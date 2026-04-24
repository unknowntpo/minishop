#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
context="${DOCKER_CONTEXT:-morefine}"
project="${COMPOSE_PROJECT_NAME:-minishop-go-sink-sweep}"
results_root="${RESULTS_ROOT:-$repo_root/benchmark-results/remote-go-seckill-result-sink-maxwait}"
max_waits=("${@:-10 50 100 250}")

compose_args=(
  --context "$context"
  compose
  -f "$repo_root/docker-compose.yml"
  -f "$repo_root/docker-compose.remote-benchmark.yml"
  -p "$project"
)

core_services=(
  postgres
  nats
  redpanda
  go-backend
  worker-seckill
)

no_dep_services=(
  go-seckill-result-sink
)

mkdir -p "$results_root"

cleanup() {
  docker "${compose_args[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

for max_wait in "${max_waits[@]}"; do
  run_id="go_sink_maxwait_${max_wait}ms_$(date -u +%Y%m%dT%H%M%SZ)"
  isolation_id="${run_id}"
  worker_app_id="minishop-seckill-worker-bench-${isolation_id}"
  sink_group_id="minishop-seckill-result-sink-bench-${isolation_id}"
  runner_name="${project//[^a-zA-Z0-9_.-]/-}-runner-${max_wait}"
  local_result_dir="$results_root/maxwait-${max_wait}"

  echo "[remote-benchmark] max_wait=${max_wait}ms: resetting compose project"
  docker "${compose_args[@]}" down -v --remove-orphans || true

  echo "[remote-benchmark] max_wait=${max_wait}ms: starting services"
  KAFKA_SECKILL_APPLICATION_ID="$worker_app_id" \
  KAFKA_SECKILL_CLEAR_STATE_ON_START=1 \
  KAFKA_SECKILL_RESULT_SINK_GROUP_ID="$sink_group_id" \
  docker "${compose_args[@]}" up -d --build "${core_services[@]}"
  KAFKA_SECKILL_APPLICATION_ID="$worker_app_id" \
  KAFKA_SECKILL_CLEAR_STATE_ON_START=1 \
  KAFKA_SECKILL_RESULT_SINK_GROUP_ID="$sink_group_id" \
  docker "${compose_args[@]}" up -d --build --no-deps "${no_dep_services[@]}"

  echo "[remote-benchmark] max_wait=${max_wait}ms: running benchmark"
  docker "${compose_args[@]}" run \
    --no-deps \
    --name "$runner_name" \
    -e KAFKA_SECKILL_APPLICATION_ID="$worker_app_id" \
    -e KAFKA_SECKILL_CLEAR_STATE_ON_START=1 \
    -e KAFKA_SECKILL_RESULT_SINK_GROUP_ID="$sink_group_id" \
    -e BENCHMARK_RUN_ID="$run_id" \
    -e BENCHMARK_REQUESTS=200000 \
    -e BENCHMARK_STYLE=steady_state \
    -e BENCHMARK_HTTP_CONCURRENCY=200 \
    -e BENCHMARK_SECKILL_BUCKET_COUNT=4 \
    -e BENCHMARK_SECKILL_MAX_PROBE=4 \
    -e BENCHMARK_INGRESS_SOURCE=http \
    -e BENCHMARK_PATH_TAG=seckill_only \
    -e BENCHMARK_IMPL=go \
    -e BENCHMARK_CREATED_SOURCE=kafka_seckill_result \
    -e BENCHMARK_APP_URL=http://go-backend:3000 \
    -e BENCHMARK_APP_URLS=http://go-backend:3000 \
    -e BENCHMARK_PROMETHEUS_URL=http://prometheus:9090 \
    -e BENCHMARK_INGRESS_APP_URLS=http://go-backend:3000 \
    -e BENCHMARK_INGRESS_HEALTH_PATH=/api/products \
    -e KAFKA_SECKILL_CLIENT_LINGER_MS=50 \
    -e KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=5000 \
    -e GO_SECKILL_RESULT_SINK_MAX_WAIT_MS="$max_wait" \
    -e BENCHMARK_RESULTS_DIR=/tmp/benchmark-results \
    benchmark-runner \
    pnpm --config.engine-strict=false benchmark:buy-intent

  echo "[remote-benchmark] max_wait=${max_wait}ms: copying artifacts to $local_result_dir"
  rm -rf "$local_result_dir"
  mkdir -p "$local_result_dir"
  docker --context "$context" cp "$runner_name:/tmp/benchmark-results/." "$local_result_dir"

  docker --context "$context" rm "$runner_name" >/dev/null
done

trap - EXIT
cleanup
