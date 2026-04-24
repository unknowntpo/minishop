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
  shift

  local run_id="${BENCHMARK_RUN_ID:-${label}_$(timestamp_run_id)}"
  local results_dir="/tmp/benchmark-results/${run_id}"
  local id
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
    run_benchmark checkout-reset "pnpm --config.engine-strict=false benchmark:checkout:postgres:reset"
    ;;
  run-checkout-cart-reset)
    shift
    run_benchmark checkout-cart-reset "pnpm --config.engine-strict=false benchmark:checkout:postgres:cart:reset"
    ;;
  run-checkout-sweep)
    shift
    run_benchmark checkout-sweep "pnpm --config.engine-strict=false benchmark:checkout:postgres:sweep"
    ;;
  run-seckill-full-api)
    shift
    run_benchmark seckill-full-api "
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
    run_benchmark seckill-direct-kafka "
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
    run_benchmark seckill-full-api-steady "
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
    run_benchmark seckill-direct-kafka-steady "
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
  swarm-benchmark.sh artifact-pull <run_id>
  swarm-benchmark.sh logs <service>
EOF
    exit 1
    ;;
esac
