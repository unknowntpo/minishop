#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${COMPOSE_PROJECT_NAME:-minishop-seckill-benchmark}"
app_replicas="${BENCHMARK_APP_REPLICAS:-1}"
run_id="${BENCHMARK_RUN_ID:-bench_$(date -u +%Y%m%dT%H%M%SZ)}"
isolation_id="${BENCHMARK_ISOLATION_ID:-$run_id}"
worker_app_prefix="${BENCHMARK_SECKILL_APPLICATION_ID_PREFIX:-minishop-seckill-worker-bench}"
sink_group_prefix="${BENCHMARK_SECKILL_RESULT_SINK_GROUP_PREFIX:-minishop-seckill-result-sink-bench}"

export KAFKA_SECKILL_APPLICATION_ID="${KAFKA_SECKILL_APPLICATION_ID:-${worker_app_prefix}-${isolation_id}}"
export KAFKA_SECKILL_CLEAR_STATE_ON_START="${KAFKA_SECKILL_CLEAR_STATE_ON_START:-1}"
export KAFKA_SECKILL_RESULT_SINK_GROUP_ID="${KAFKA_SECKILL_RESULT_SINK_GROUP_ID:-${sink_group_prefix}-${isolation_id}}"

compose_args=(
  compose
  --profile benchmark
  -p "$project"
)

core_services=(
  postgres
  nats
  redpanda
  app
  worker-seckill
  worker-seckill-result-sink
)

if [[ "${BENCHMARK_INGRESS_IMPL:-node}" == "go" ]]; then
  core_services+=(go-seckill-ingress)
fi

if [[ "${BENCHMARK_RESULT_SINK_IMPL:-node}" == "go" ]]; then
  filtered_services=()
  for service in "${core_services[@]}"; do
    if [[ "$service" != "worker-seckill-result-sink" ]]; then
      filtered_services+=("$service")
    fi
  done
  core_services=("${filtered_services[@]}")
  core_services+=(go-seckill-result-sink)
fi

runner_command=("$@")
if [[ ${#runner_command[@]} -eq 0 ]]; then
  runner_command=(pnpm --config.engine-strict=false benchmark:buy-intent)
fi

runner_env_args=()
add_runner_env_if_set() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    runner_env_args+=(-e "${name}=${!name}")
  fi
}

for env_name in \
  BENCHMARK_SCENARIO_NAME \
  BENCHMARK_SCENARIO_FAMILY \
  BENCHMARK_REQUESTS \
  BENCHMARK_HTTP_CONCURRENCY \
  BENCHMARK_STYLE \
  BENCHMARK_INGRESS_SOURCE \
  BENCHMARK_PATH_TAG \
  BENCHMARK_CREATED_TIMEOUT_MS \
  BENCHMARK_SECKILL_BUCKET_COUNT \
  BENCHMARK_SECKILL_MAX_PROBE \
  BENCHMARK_RESULT_SINK_IMPL \
  BENCHMARK_RESET_STATE \
  BENCHMARK_PROFILE \
  BENCHMARK_SKU_ID \
  BENCHMARK_UNIT_PRICE_MINOR \
  BENCHMARK_CURRENCY \
  BENCHMARK_STEADY_STATE_WARMUP_MS \
  BENCHMARK_STEADY_STATE_MEASURE_MS \
  BENCHMARK_STEADY_STATE_COOLDOWN_MS \
  SECKILL_BUCKET_COUNT \
  KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS \
  KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS \
  KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS
do
  add_runner_env_if_set "$env_name"
done

echo "[seckill-benchmark] project=${project} run_id=${run_id}"
echo "[seckill-benchmark] worker_app_id=${KAFKA_SECKILL_APPLICATION_ID}"
echo "[seckill-benchmark] result_sink_group_id=${KAFKA_SECKILL_RESULT_SINK_GROUP_ID}"

wait_for_consumer_group() {
  local group_id="$1"
  local expected_members="${2:-1}"
  local max_attempts="${3:-45}"
  local sleep_seconds="${4:-2}"

  if [[ -z "$group_id" ]]; then
    return 0
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    local description
    description="$(docker "${compose_args[@]}" exec -T redpanda rpk group describe "$group_id" 2>/dev/null || true)"

    if [[ -z "$description" ]]; then
      sleep "$sleep_seconds"
      continue
    fi

    local state
    state="$(printf '%s\n' "$description" | awk '$1 == "STATE" { print $2; exit }')"
    local members
    members="$(printf '%s\n' "$description" | awk '$1 == "MEMBERS" { print $2; exit }')"

    if [[ "$state" == "Stable" && "$members" == "$expected_members" ]]; then
      echo "[seckill-benchmark] group ${group_id} stable with ${members} member(s)"
      return 0
    fi

    sleep "$sleep_seconds"
  done

  echo "[seckill-benchmark] group ${group_id} failed to become stable" >&2
  docker "${compose_args[@]}" exec -T redpanda rpk group describe "$group_id" || true
  return 1
}

docker "${compose_args[@]}" rm -sf benchmark-runner "${core_services[@]}" >/dev/null 2>&1 || true
docker "${compose_args[@]}" up -d --build --scale "app=${app_replicas}" "${core_services[@]}"

if [[ "${BENCHMARK_RESET_STATE:-1}" != "0" ]]; then
  request_topic="${KAFKA_SECKILL_REQUEST_TOPIC:-inventory.seckill.requested}"
  result_topic="${KAFKA_SECKILL_RESULT_TOPIC:-inventory.seckill.result}"
  dlq_topic="${KAFKA_SECKILL_DLQ_TOPIC:-inventory.seckill.dlq}"
  topic_partitions="${KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT:-4}}"
  result_partitions="${KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT:-4}}"
  dlq_partitions="${KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT:-4}}"

  echo "[seckill-benchmark] hard-reset topics"
  docker "${compose_args[@]}" exec -T redpanda rpk topic delete "$request_topic" "$result_topic" "$dlq_topic" >/dev/null 2>&1 || true
  docker "${compose_args[@]}" exec -T redpanda rpk topic create "$request_topic" -p "$topic_partitions" -r 1 >/dev/null
  docker "${compose_args[@]}" exec -T redpanda rpk topic create "$result_topic" -p "$result_partitions" -r 1 >/dev/null
  docker "${compose_args[@]}" exec -T redpanda rpk topic create "$dlq_topic" -p "$dlq_partitions" -r 1 >/dev/null

  docker "${compose_args[@]}" up -d --force-recreate worker-seckill >/dev/null
  if [[ "${BENCHMARK_RESULT_SINK_IMPL:-node}" == "go" ]]; then
    docker "${compose_args[@]}" up -d --force-recreate go-seckill-result-sink >/dev/null
  else
    docker "${compose_args[@]}" up -d --force-recreate worker-seckill-result-sink >/dev/null
  fi

  wait_for_consumer_group "${KAFKA_SECKILL_APPLICATION_ID}"
  wait_for_consumer_group "${KAFKA_SECKILL_RESULT_SINK_GROUP_ID}"
fi

docker "${compose_args[@]}" run --rm --build --no-deps \
  -e BENCHMARK_RUN_ID="${run_id}" \
  -e BENCHMARK_APP_REPLICAS="${app_replicas}" \
  -e BENCHMARK_APP_URL="${BENCHMARK_APP_URL:-http://app:3000}" \
  -e BENCHMARK_PROMETHEUS_URL="${BENCHMARK_PROMETHEUS_URL:-http://prometheus:9090}" \
  -e KAFKA_SECKILL_APPLICATION_ID="${KAFKA_SECKILL_APPLICATION_ID}" \
  -e KAFKA_SECKILL_RESULT_SINK_GROUP_ID="${KAFKA_SECKILL_RESULT_SINK_GROUP_ID}" \
  "${runner_env_args[@]}" \
  benchmark-runner \
  "${runner_command[@]}"
