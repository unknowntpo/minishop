#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_name="${BENCHMARK_STACK_NAME:-minishop-benchmark}"
docker_context="${DOCKER_CONTEXT:-default}"
compose_file="${repo_root}/docker-compose.benchmark.yml"
default_image="${BENCHMARK_LOCAL_IMAGE:-minishop-benchmark-app:local}"
go_seckill_ingress_image="${BENCHMARK_GO_SECKILL_INGRESS_IMAGE:-minishop-go-seckill-ingress:latest}"
go_seckill_result_sink_image="${BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE:-minishop-go-seckill-result-sink:latest}"
worker_seckill_image="${BENCHMARK_WORKER_SECKILL_IMAGE:-minishop-worker-seckill:latest}"
worker_seckill_result_sink_image="${BENCHMARK_WORKER_SECKILL_RESULT_SINK_IMAGE:-minishop-worker-seckill-result-sink:latest}"
runner_service_name="${stack_name}_benchmark-runner"

docker_cmd() {
  docker --context "${docker_context}" "$@"
}

service_name() {
  printf '%s_%s\n' "${stack_name}" "$1"
}

service_container_id() {
  docker_cmd ps \
    --filter "label=com.docker.swarm.service.name=$(service_name "$1")" \
    --format '{{.ID}}' |
    head -n 1
}

runner_id() {
  docker_cmd ps \
    --filter "label=com.docker.swarm.service.name=${runner_service_name}" \
    --format '{{.ID}}' |
    head -n 1
}

require_runner() {
  local id
  id="$(runner_id)"
  if [[ -z "${id}" ]]; then
    echo "benchmark runner container not found; deploy the stack first" >&2
    exit 1
  fi
  printf '%s\n' "${id}"
}

build_local_image() {
  docker_cmd build -t "${default_image}" "${repo_root}"
}

wait_for_command() {
  local description="$1"
  local max_attempts="$2"
  local sleep_seconds="$3"
  shift 3

  local attempt
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    if "$@"; then
      return 0
    fi
    sleep "${sleep_seconds}"
  done

  echo "timed out waiting for ${description}" >&2
  return 1
}

wait_for_service_container() {
  local service="$1"
  local attempt
  for ((attempt = 1; attempt <= 60; attempt += 1)); do
    if [[ -n "$(service_container_id "${service}")" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "timed out waiting for service container ${service}" >&2
  return 1
}

wait_for_postgres_ready() {
  wait_for_service_container "benchmark-postgres"
  local id
  id="$(service_container_id "benchmark-postgres")"
  wait_for_command "postgres readiness" 60 2 \
    docker_cmd exec "${id}" pg_isready -U postgres -d minishop
}

wait_for_http_from_runner() {
  local url="$1"
  local label="$2"
  local require_ok="${3:-1}"
  local id
  id="$(require_runner)"
  wait_for_command "${label}" 60 2 \
    docker_cmd exec "${id}" node -e "const requireOk = process.argv[2] === '1'; fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then((r)=>process.exit(requireOk ? (r.ok ? 0 : 1) : 0)).catch(()=>process.exit(1))" "${url}" "${require_ok}"
}

wait_for_redpanda_ready() {
  wait_for_service_container "benchmark-redpanda"
  local id
  id="$(service_container_id "benchmark-redpanda")"
  wait_for_command "redpanda readiness" 60 2 \
    docker_cmd exec "${id}" rpk cluster info
}

ensure_topic() {
  local topic="$1"
  local partitions="$2"
  local id
  id="$(service_container_id "benchmark-redpanda")"
  docker_cmd exec "${id}" sh -lc "rpk topic describe '${topic}' >/dev/null 2>&1 || rpk topic create '${topic}' -p '${partitions}' -r 1 >/dev/null"
}

wait_for_consumer_group() {
  local group_id="$1"
  local expected_members="${2:-1}"
  local id
  id="$(service_container_id "benchmark-redpanda")"

  wait_for_command "consumer group ${group_id}" 60 2 sh -lc "
    description=\$(docker --context '${docker_context}' exec '${id}' rpk group describe '${group_id}' 2>/dev/null || true)
    state=\$(printf '%s\n' \"\$description\" | awk '\$1 == \"STATE\" { print \$2; exit }')
    members=\$(printf '%s\n' \"\$description\" | awk '\$1 == \"MEMBERS\" { print \$2; exit }')
    [ \"\$state\" = \"Stable\" ] && [ \"\$members\" = '${expected_members}' ]
  "
}

stack_wait_checkout() {
  wait_for_postgres_ready
  wait_for_redpanda_ready
  wait_for_service_container "benchmark-go-backend"
  wait_for_service_container "benchmark-runner"
  wait_for_http_from_runner "http://benchmark-go-backend:3000/products" "go-backend HTTP response" 0
}

stack_wait_seckill() {
  local request_topic="${BENCHMARK_KAFKA_SECKILL_REQUEST_TOPIC:-inventory.seckill.requested}"
  local result_topic="${BENCHMARK_KAFKA_SECKILL_RESULT_TOPIC:-inventory.seckill.result}"
  local dlq_topic="${BENCHMARK_KAFKA_SECKILL_DLQ_TOPIC:-inventory.seckill.dlq}"
  local partitions="${BENCHMARK_SECKILL_BUCKET_COUNT:-4}"
  local worker_group="${KAFKA_SECKILL_APPLICATION_ID:-minishop-seckill-worker-benchmark}"
  local sink_group="${KAFKA_SECKILL_RESULT_SINK_GROUP_ID:-minishop-seckill-result-sink-benchmark}"

  stack_wait_checkout
  wait_for_service_container "benchmark-go-seckill-ingress"
  wait_for_service_container "benchmark-worker-seckill"
  wait_for_service_container "benchmark-worker-seckill-result-sink"
  wait_for_http_from_runner "http://benchmark-go-seckill-ingress:3000/healthz" "go-seckill-ingress /healthz" 1
  ensure_topic "${request_topic}" "${partitions}"
  ensure_topic "${result_topic}" "${partitions}"
  ensure_topic "${dlq_topic}" "${partitions}"
  wait_for_consumer_group "${worker_group}"
  wait_for_consumer_group "${sink_group}"
}

stack_wait() {
  local mode="${1:-all}"
  case "${mode}" in
    checkout)
      stack_wait_checkout
      ;;
    seckill|all)
      stack_wait_seckill
      ;;
    *)
      echo "unknown wait mode: ${mode}" >&2
      exit 1
      ;;
  esac
}

image_exists() {
  docker_cmd image inspect "$1" >/dev/null 2>&1
}

can_build_from_repo() {
  local dockerfile="$1"
  shift

  [[ -f "${repo_root}/${dockerfile}" ]] || return 1

  local required_path
  for required_path in "$@"; do
    [[ -e "${repo_root}/${required_path}" ]] || return 1
  done
}

build_if_missing() {
  local image="$1"
  local dockerfile="$2"
  shift 2
  local required_paths=("$@")

  if image_exists "${image}"; then
    return 0
  fi

  if ! can_build_from_repo "${dockerfile}" "${required_paths[@]}"; then
    echo "missing image ${image} and cannot auto-build it from this branch" >&2
    echo "expected dockerfile/source: ${dockerfile} ${required_paths[*]}" >&2
    return 1
  fi

  docker_cmd build -f "${repo_root}/${dockerfile}" -t "${image}" "${repo_root}"
}

prepare_local_images() {
  local failures=0

  build_local_image

  build_if_missing "${go_seckill_ingress_image}" "Dockerfile.go-seckill-ingress" \
    "services/go-seckill-ingress/go.mod" "services/go-seckill-ingress" || failures=1

  build_if_missing "${go_seckill_result_sink_image}" "Dockerfile.go-seckill-result-sink" \
    "services/go-seckill-result-sink/go.mod" "services/go-seckill-result-sink" || failures=1

  build_if_missing "${worker_seckill_image}" "Dockerfile.worker" \
    "workers/node" || failures=1

  build_if_missing "${worker_seckill_result_sink_image}" "Dockerfile.worker" \
    "workers/node" || failures=1

  return "${failures}"
}

stack_deploy() {
  prepare_local_images

  export BENCHMARK_RUNNER_IMAGE="${BENCHMARK_RUNNER_IMAGE:-${default_image}}"
  export BENCHMARK_GO_BACKEND_IMAGE="${BENCHMARK_GO_BACKEND_IMAGE:-${default_image}}"
  export BENCHMARK_GO_SECKILL_INGRESS_IMAGE="${BENCHMARK_GO_SECKILL_INGRESS_IMAGE:-${go_seckill_ingress_image}}"
  export BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE="${BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE:-${go_seckill_result_sink_image}}"
  export BENCHMARK_WORKER_SECKILL_IMAGE="${BENCHMARK_WORKER_SECKILL_IMAGE:-${worker_seckill_image}}"
  export BENCHMARK_WORKER_SECKILL_RESULT_SINK_IMAGE="${BENCHMARK_WORKER_SECKILL_RESULT_SINK_IMAGE:-${worker_seckill_result_sink_image}}"

  docker_cmd stack deploy --compose-file "${compose_file}" "${stack_name}"
}

stack_rm() {
  docker_cmd stack rm "${stack_name}"
}

stack_services() {
  docker_cmd stack services "${stack_name}"
}

stack_ps() {
  docker_cmd stack ps "${stack_name}"
}

exec_runner() {
  local id
  id="$(require_runner)"
  docker_cmd exec "${id}" "$@"
}

timestamp_run_id() {
  date -u +%Y%m%dT%H%M%SZ
}

run_benchmark() {
  local label="$1"
  local wait_mode="$2"
  shift
  shift

  local run_id="${BENCHMARK_RUN_ID:-${label}_$(timestamp_run_id)}"
  local results_dir="/tmp/benchmark-results/${run_id}"
  local id
  stack_wait "${wait_mode}"
  id="$(require_runner)"

  echo "run_id=${run_id}"
  docker_cmd exec "${id}" sh -lc "
    mkdir -p '${results_dir}' &&
    export BENCHMARK_RUN_ID='${run_id}' &&
    export BENCHMARK_RESULTS_DIR='${results_dir}' &&
    $*
  "
}

artifact_pull() {
  local run_id="$1"
  local id
  local destination="${repo_root}/benchmark-results/${run_id}"
  id="$(require_runner)"

  rm -rf "${destination}"
  mkdir -p "${destination}"
  docker_cmd cp "${id}:/tmp/benchmark-results/${run_id}/." "${destination}"
  echo "artifact copied to ${destination}"
}

logs_service() {
  docker_cmd service logs -f "$(service_name "$1")"
}

case "${1:-}" in
  stack-deploy)
    shift
    stack_deploy "$@"
    ;;
  stack-rm)
    shift
    stack_rm "$@"
    ;;
  stack-services)
    shift
    stack_services "$@"
    ;;
  stack-ps)
    shift
    stack_ps "$@"
    ;;
  runner-id)
    shift
    require_runner
    ;;
  exec-runner)
    shift
    if [[ "$#" -eq 0 ]]; then
      echo "usage: $0 exec-runner <cmd...>" >&2
      exit 1
    fi
    exec_runner "$@"
    ;;
  run-checkout-reset)
    shift
    run_benchmark checkout-reset checkout "pnpm --config.engine-strict=false benchmark:checkout:postgres:reset"
    ;;
  run-checkout-cart-reset)
    shift
    run_benchmark checkout-cart-reset checkout "pnpm --config.engine-strict=false benchmark:checkout:postgres:cart:reset"
    ;;
  run-checkout-sweep)
    shift
    run_benchmark checkout-sweep checkout "pnpm --config.engine-strict=false benchmark:checkout:postgres:sweep"
    ;;
  run-seckill-full-api)
    shift
    run_benchmark seckill-full-api seckill "
      export BENCHMARK_SCENARIO_NAME='seckill-full-api' &&
      export BENCHMARK_SCENARIO_FAMILY='seckill-full-api' &&
      export BENCHMARK_PATH_TAG='seckill_full_api' &&
      export BENCHMARK_INGRESS_SOURCE='http' &&
      export BENCHMARK_CREATED_SOURCE='kafka_seckill_result' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='1' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  run-seckill-direct-kafka)
    shift
    run_benchmark seckill-direct-kafka seckill "
      export BENCHMARK_SCENARIO_NAME='seckill-direct-kafka' &&
      export BENCHMARK_SCENARIO_FAMILY='seckill-direct-kafka' &&
      export BENCHMARK_PATH_TAG='seckill_direct_kafka' &&
      export BENCHMARK_INGRESS_SOURCE='direct_kafka' &&
      export BENCHMARK_CREATED_SOURCE='kafka_seckill_result' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='1' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  run-seckill-full-api-steady)
    shift
    run_benchmark seckill-full-api-steady seckill "
      export BENCHMARK_SCENARIO_NAME='seckill-full-api-steady' &&
      export BENCHMARK_SCENARIO_FAMILY='seckill-full-api' &&
      export BENCHMARK_PATH_TAG='seckill_full_api' &&
      export BENCHMARK_INGRESS_SOURCE='http' &&
      export BENCHMARK_CREATED_SOURCE='kafka_seckill_result' &&
      export BENCHMARK_STYLE='steady_state' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='1' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  run-seckill-direct-kafka-steady)
    shift
    run_benchmark seckill-direct-kafka-steady seckill "
      export BENCHMARK_SCENARIO_NAME='seckill-direct-kafka-steady' &&
      export BENCHMARK_SCENARIO_FAMILY='seckill-direct-kafka' &&
      export BENCHMARK_PATH_TAG='seckill_direct_kafka' &&
      export BENCHMARK_INGRESS_SOURCE='direct_kafka' &&
      export BENCHMARK_CREATED_SOURCE='kafka_seckill_result' &&
      export BENCHMARK_STYLE='steady_state' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='1' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  artifact-pull)
    shift
    if [[ "$#" -ne 1 ]]; then
      echo "usage: $0 artifact-pull <run_id>" >&2
      exit 1
    fi
    artifact_pull "$1"
    ;;
  stack-wait)
    shift
    stack_wait "${1:-all}"
    ;;
  logs)
    shift
    if [[ "$#" -ne 1 ]]; then
      echo "usage: $0 logs <service>" >&2
      exit 1
    fi
    logs_service "$1"
    ;;
  *)
    cat >&2 <<'EOF'
usage:
  swarm-benchmark.sh stack-deploy
  swarm-benchmark.sh stack-rm
  swarm-benchmark.sh stack-services
  swarm-benchmark.sh stack-ps
  swarm-benchmark.sh runner-id
  swarm-benchmark.sh exec-runner <cmd...>
  swarm-benchmark.sh run-checkout-reset
  swarm-benchmark.sh run-checkout-cart-reset
  swarm-benchmark.sh run-checkout-sweep
  swarm-benchmark.sh run-seckill-full-api
  swarm-benchmark.sh run-seckill-direct-kafka
  swarm-benchmark.sh run-seckill-full-api-steady
  swarm-benchmark.sh run-seckill-direct-kafka-steady
  swarm-benchmark.sh stack-wait [checkout|seckill|all]
  swarm-benchmark.sh artifact-pull <run_id>
  swarm-benchmark.sh logs <service>
EOF
    exit 1
    ;;
esac
