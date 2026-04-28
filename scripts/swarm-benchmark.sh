#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_name="${BENCHMARK_STACK_NAME:-minishop-benchmark}"
docker_context="${DOCKER_CONTEXT:-default}"
compose_file="${repo_root}/docker-compose.benchmark.yml"
go_backend_image="${BENCHMARK_GO_BACKEND_IMAGE:-minishop-go-backend:local}"
node_worker_image="${BENCHMARK_NODE_WORKER_IMAGE:-minishop-node-worker:local}"
go_seckill_result_sink_image="${BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE:-minishop-go-seckill-result-sink:local}"
worker_seckill_image="${BENCHMARK_WORKER_SECKILL_IMAGE:-minishop-worker-seckill:local}"
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
  for ((attempt = 1; attempt <= 90; attempt += 1)); do
    if [[ -n "$(service_container_id "${service}")" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "timed out waiting for service container ${service}" >&2
  return 1
}

service_replica_count() {
  local service="$1"
  docker_cmd service inspect \
    --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}1{{end}}' \
    "$(service_name "${service}")"
}

service_env_value() {
  local service="$1"
  local key="$2"
  local fallback="${3:-}"
  local value
  value="$(
    docker_cmd service inspect \
      --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
      "$(service_name "${service}")" |
      awk -F= -v key="${key}" '$1 == key { value = substr($0, length(key) + 2) } END { print value }'
  )"

  if [[ -n "${value}" ]]; then
    printf '%s\n' "${value}"
    return 0
  fi

  printf '%s\n' "${fallback}"
}

wait_for_service_replicas() {
  local service="$1"
  local expected="$2"
  local attempt
  for ((attempt = 1; attempt <= 90; attempt += 1)); do
    local running
    running="$(
      docker_cmd ps \
        --filter "label=com.docker.swarm.service.name=$(service_name "${service}")" \
        --filter "status=running" \
        --format '{{.ID}}' |
        wc -l |
        tr -d '[:space:]'
    )"
    if [[ "${running}" == "${expected}" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "timed out waiting for ${expected} running replica(s) of ${service}" >&2
  return 1
}

wait_for_postgres_ready() {
  wait_for_service_container "benchmark-postgres"
  local id
  id="$(service_container_id "benchmark-postgres")"
  wait_for_command "postgres readiness" 60 2 \
    docker_cmd exec "${id}" pg_isready -U postgres -d minishop
}

wait_for_redpanda_ready() {
  wait_for_service_container "benchmark-redpanda"
  local id
  id="$(service_container_id "benchmark-redpanda")"
  wait_for_command "redpanda readiness" 60 2 \
    docker_cmd exec "${id}" rpk cluster info
}

wait_for_nats_ready() {
  wait_for_service_container "benchmark-nats"
  wait_for_http_from_runner "http://benchmark-nats:8222/healthz" "nats /healthz" 1
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

ensure_topic() {
  local topic="$1"
  local partitions="$2"
  local id
  id="$(service_container_id "benchmark-redpanda")"
  docker_cmd exec "${id}" sh -lc "rpk topic describe '${topic}' >/dev/null 2>&1 || rpk topic create '${topic}' -p '${partitions}' -r 1 >/dev/null"
}

reset_topic() {
  local topic="$1"
  local partitions="$2"
  local id
  id="$(service_container_id "benchmark-redpanda")"
  docker_cmd exec "${id}" sh -lc "
    rpk topic delete '${topic}' >/dev/null 2>&1 || true
    for attempt in \$(seq 1 30); do
      if rpk topic create '${topic}' -p '${partitions}' -r 1 >/dev/null 2>&1; then
        exit 0
      fi
      sleep 1
    done
    rpk topic create '${topic}' -p '${partitions}' -r 1 >/dev/null
  "
}

delete_old_seckill_worker_changelog_topics() {
  local id
  id="$(service_container_id "benchmark-redpanda")"
  docker_cmd exec "${id}" sh -lc "
    topics=\$(rpk topic list 2>/dev/null | awk '/^minishop-seckill-worker-benchmark(-.*)?-(dedupe-store|inventory-store)-changelog[[:space:]]/ { print \$1 }')
    if [ -n \"\$topics\" ]; then
      rpk topic delete \$topics >/dev/null 2>&1 || true
    fi
  "
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
  wait_for_http_from_runner "http://benchmark-go-backend:3000/api/products" "go-backend HTTP response" 0
}

stack_wait_async() {
  stack_wait_checkout
  wait_for_nats_ready
  wait_for_service_container "benchmark-worker-buy-intents-ingest"
  wait_for_service_container "benchmark-worker-staged-buy-intents-process"
  wait_for_service_container "benchmark-worker-projections"
}

stack_wait_seckill() {
  local request_topic="${BENCHMARK_KAFKA_SECKILL_REQUEST_TOPIC:-inventory.seckill.requested}"
  local result_topic="${BENCHMARK_KAFKA_SECKILL_RESULT_TOPIC:-inventory.seckill.result}"
  local dlq_topic="${BENCHMARK_KAFKA_SECKILL_DLQ_TOPIC:-inventory.seckill.dlq}"
  local partitions="${BENCHMARK_SECKILL_BUCKET_COUNT:-4}"
  local worker_group
  local sink_group
  local worker_replicas
  worker_replicas="$(service_replica_count "benchmark-worker-seckill")"
  worker_group="${KAFKA_SECKILL_APPLICATION_ID:-$(service_env_value "benchmark-worker-seckill" "KAFKA_SECKILL_APPLICATION_ID" "minishop-seckill-worker-benchmark")}"
  sink_group="${KAFKA_SECKILL_RESULT_SINK_GROUP_ID:-$(service_env_value "benchmark-worker-seckill-result-sink" "KAFKA_SECKILL_RESULT_SINK_GROUP_ID" "minishop-seckill-result-sink-benchmark")}"

  stack_wait_checkout
  wait_for_service_replicas "benchmark-worker-seckill" "${worker_replicas}"
  wait_for_service_container "benchmark-worker-seckill-result-sink"
  ensure_topic "${request_topic}" "${partitions}"
  ensure_topic "${result_topic}" "${partitions}"
  ensure_topic "${dlq_topic}" "${partitions}"
  wait_for_consumer_group "${worker_group}" "${worker_replicas}"
  wait_for_consumer_group "${sink_group}"
}

stack_wait() {
  local mode="${1:-all}"
  case "${mode}" in
    checkout)
      stack_wait_checkout
      ;;
    async)
      stack_wait_async
      ;;
    seckill)
      stack_wait_seckill
      ;;
    all)
      stack_wait_async
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

ensure_image() {
  local image="$1"
  local dockerfile="$2"
  local strict="${3:-0}"
  local build_policy="${BENCHMARK_BUILD_POLICY:-always}"

  if [[ "${build_policy}" != "always" ]] && image_exists "${image}"; then
    return 0
  fi

  if [[ ! -f "${repo_root}/${dockerfile}" ]]; then
    if [[ "${strict}" == "1" ]]; then
      echo "missing image ${image} and dockerfile ${dockerfile}" >&2
      return 1
    fi
    echo "warning: missing image ${image} and dockerfile ${dockerfile}; skipping auto-build" >&2
    return 0
  fi

  docker_cmd build -f "${repo_root}/${dockerfile}" -t "${image}" "${repo_root}"
}

prepare_local_images() {
  local strict="${1:-0}"

  ensure_image "${go_backend_image}" "Dockerfile.go-backend" "${strict}"
  ensure_image "${node_worker_image}" "Dockerfile.worker" "${strict}"
  ensure_image "${go_seckill_result_sink_image}" "Dockerfile.go-seckill-result-sink" "${strict}"
  ensure_image "${worker_seckill_image}" "Dockerfile.seckill-worker" "${strict}"
}

label_single_node_for_smoke() {
  local node_id
  node_id="$(docker_cmd node ls --format '{{if .ManagerStatus}}{{.ID}}{{end}}' | head -n 1)"
  if [[ -z "${node_id}" ]]; then
    return 1
  fi

  docker_cmd node update \
    --label-add benchmark.role.db=true \
    --label-add benchmark.role.msg=true \
    --label-add benchmark.role.api=true \
    --label-add benchmark.role.worker=true \
    --label-add benchmark.role.bench=true \
    --label-add benchmark.role.obs=true \
    "${node_id}" >/dev/null
}

stack_deploy() {
  local strict="${1:-0}"
  local prometheus_config_hash
  prepare_local_images "${strict}"
  label_single_node_for_smoke
  prometheus_config_hash="$(shasum -a 256 "${repo_root}/ops/benchmark/prometheus.yml" | awk '{print substr($1, 1, 12)}')"

  export BENCHMARK_GO_BACKEND_IMAGE="${BENCHMARK_GO_BACKEND_IMAGE:-${go_backend_image}}"
  export BENCHMARK_NODE_WORKER_IMAGE="${BENCHMARK_NODE_WORKER_IMAGE:-${node_worker_image}}"
  export BENCHMARK_RUNNER_IMAGE="${BENCHMARK_RUNNER_IMAGE:-${node_worker_image}}"
  export BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE="${BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE:-${go_seckill_result_sink_image}}"
  export BENCHMARK_WORKER_SECKILL_IMAGE="${BENCHMARK_WORKER_SECKILL_IMAGE:-${worker_seckill_image}}"
  export BENCHMARK_PROMETHEUS_CONFIG_NAME="${BENCHMARK_PROMETHEUS_CONFIG_NAME:-${stack_name}_benchmark_prometheus_config_${prometheus_config_hash}}"

  docker_cmd stack deploy --prune --compose-file "${compose_file}" "${stack_name}"
  rollout_local_images
}

stack_rm() {
  docker_cmd stack rm "${stack_name}"
  wait_for_command "stack ${stack_name} removal" 60 2 sh -lc "
    [ -z \"\$(docker --context '${docker_context}' stack services '${stack_name}' --format '{{.Name}}' 2>/dev/null)\" ] &&
    [ -z \"\$(docker --context '${docker_context}' network ls --filter name='^${stack_name}_benchmark$' --format '{{.Name}}')\" ]
  "
}

stack_services() {
  docker_cmd stack services "${stack_name}"
}

stack_ps() {
  docker_cmd stack ps "${stack_name}"
}

scale_seckill_worker() {
  local replicas="$1"
  if ! [[ "${replicas}" =~ ^[1-9][0-9]*$ ]]; then
    echo "replicas must be a positive integer" >&2
    exit 1
  fi

  docker_cmd service scale "$(service_name "benchmark-worker-seckill")=${replicas}" >/dev/null
  wait_for_service_replicas "benchmark-worker-seckill" "${replicas}"
  stack_wait_seckill
}

force_update_service_image() {
  local service="$1"
  local image="$2"

  if docker_cmd service inspect "$(service_name "${service}")" >/dev/null 2>&1; then
    docker_cmd service update --detach=true --force --image "${image}" "$(service_name "${service}")" >/dev/null
  fi
}

rollout_local_images() {
  force_update_service_image "benchmark-go-backend" "${go_backend_image}"
  force_update_service_image "benchmark-go-seckill-result-sink" "${go_seckill_result_sink_image}"
  force_update_service_image "benchmark-worker-seckill" "${worker_seckill_image}"
  force_update_service_image "benchmark-worker-buy-intents-ingest" "${node_worker_image}"
  force_update_service_image "benchmark-worker-staged-buy-intents-process" "${node_worker_image}"
  force_update_service_image "benchmark-worker-projections" "${node_worker_image}"
  force_update_service_image "benchmark-worker-seckill-result-sink" "${node_worker_image}"
  force_update_service_image "benchmark-runner" "${node_worker_image}"
}

prepare_seckill_run() {
  local run_id="$1"
  local request_topic="${BENCHMARK_KAFKA_SECKILL_REQUEST_TOPIC:-inventory.seckill.requested}"
  local result_topic="${BENCHMARK_KAFKA_SECKILL_RESULT_TOPIC:-inventory.seckill.result}"
  local dlq_topic="${BENCHMARK_KAFKA_SECKILL_DLQ_TOPIC:-inventory.seckill.dlq}"
  local partitions="${BENCHMARK_SECKILL_BUCKET_COUNT:-4}"
  local worker_group="minishop-seckill-worker-benchmark-${run_id}"
  local sink_group="minishop-seckill-result-sink-benchmark-${run_id}"
  local worker_replicas
  worker_replicas="$(service_replica_count "benchmark-worker-seckill")"

  wait_for_redpanda_ready
  docker_cmd service scale "$(service_name "benchmark-worker-seckill")=0" >/dev/null
  wait_for_service_replicas "benchmark-worker-seckill" "0"
  delete_old_seckill_worker_changelog_topics
  reset_topic "${request_topic}" "${partitions}"
  reset_topic "${result_topic}" "${partitions}"
  reset_topic "${dlq_topic}" "${partitions}"

  docker_cmd service update --detach=true --force \
    --env-add "KAFKA_SECKILL_BUCKET_COUNT=${partitions}" \
    --env-add "KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS=${partitions}" \
    --env-add "KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS=${partitions}" \
    --env-add "KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS=${partitions}" \
    --env-add "KAFKA_SECKILL_MAX_PROBE=${BENCHMARK_SECKILL_MAX_PROBE:-4}" \
    --env-add "KAFKA_SECKILL_CLIENT_LINGER_MS=${KAFKA_SECKILL_CLIENT_LINGER_MS:-1}" \
    --env-add "KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=${KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES:-10000}" \
    --env-add "KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=${KAFKA_SECKILL_CLIENT_REQUIRED_ACKS:-all}" \
    "$(service_name "benchmark-go-backend")" >/dev/null

  docker_cmd service update --detach=true --force \
    --env-add "KAFKA_SECKILL_APPLICATION_ID=${worker_group}" \
    --env-add "KAFKA_SECKILL_CLEAR_STATE_ON_START=1" \
    --env-add "KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS=${partitions}" \
    --env-add "KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS=${partitions}" \
    --env-add "KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS=${partitions}" \
    "$(service_name "benchmark-worker-seckill")" >/dev/null

  docker_cmd service update --detach=true --force \
    --env-add "KAFKA_SECKILL_RESULT_SINK_GROUP_ID=${sink_group}" \
    --env-add "KAFKA_SECKILL_RESULT_SINK_CLIENT_ID=${sink_group}" \
    --env-add "KAFKA_SECKILL_RESULT_SINK_PARTITIONS_CONCURRENTLY=${partitions}" \
    "$(service_name "benchmark-worker-seckill-result-sink")" >/dev/null

  if docker_cmd service inspect "$(service_name "benchmark-go-seckill-result-sink")" >/dev/null 2>&1; then
    docker_cmd service update --detach=true --force \
      --env-add "KAFKA_SECKILL_RESULT_SINK_GROUP_ID=${sink_group}" \
      --env-add "KAFKA_SECKILL_RESULT_SINK_CLIENT_ID=${sink_group}" \
      --env-add "KAFKA_SECKILL_RESULT_SINK_PARTITIONS_CONCURRENTLY=${partitions}" \
      "$(service_name "benchmark-go-seckill-result-sink")" >/dev/null
  fi

  docker_cmd service scale "$(service_name "benchmark-worker-seckill")=${worker_replicas}" >/dev/null
  export KAFKA_SECKILL_APPLICATION_ID="${worker_group}"
  export KAFKA_SECKILL_RESULT_SINK_GROUP_ID="${sink_group}"
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
  shift 2

  local run_id="${BENCHMARK_RUN_ID:-${label}_$(timestamp_run_id)}"
  local results_dir="/tmp/benchmark-results/${run_id}"
  local id

  if [[ "${wait_mode}" == "seckill" ]]; then
    prepare_seckill_run "${run_id}"
  fi

  stack_wait "${wait_mode}"
  id="$(require_runner)"

  local seckill_worker_replicas=""
  if docker_cmd service inspect "$(service_name "benchmark-worker-seckill")" >/dev/null 2>&1; then
    seckill_worker_replicas="$(service_replica_count "benchmark-worker-seckill")"
  fi

  local runner_exports
  runner_exports="$(
    for key in \
      BENCHMARK_REQUESTS \
      BENCHMARK_HTTP_CONCURRENCY \
      BENCHMARK_STYLE \
      BENCHMARK_STEADY_STATE_WARMUP_MS \
      BENCHMARK_STEADY_STATE_MEASURE_MS \
      BENCHMARK_STEADY_STATE_COOLDOWN_MS \
      BENCHMARK_CREATED_TIMEOUT_MS \
      BENCHMARK_DIRECT_KAFKA_BATCH_SIZE \
      BENCHMARK_DIRECT_KAFKA_PRODUCER_CLIENT \
      BENCHMARK_DIRECT_KAFKA_FRANZ_PUBLISHER_BIN \
      BENCHMARK_SECKILL_BUCKET_COUNT \
      BENCHMARK_SECKILL_MAX_PROBE \
      BENCHMARK_RESULT_SINK_IMPL \
      BENCHMARK_PROFILE \
      BENCHMARK_SKU_ID \
      BENCHMARK_UNIT_PRICE_MINOR \
      BENCHMARK_CURRENCY \
      KAFKA_SECKILL_PUBLISH_BATCH_SIZE \
      KAFKA_SECKILL_PUBLISH_LINGER_MS \
      KAFKA_SECKILL_CLIENT_LINGER_MS \
      KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES \
      KAFKA_SECKILL_CLIENT_REQUIRED_ACKS
    do
      if [[ -n "${!key:-}" ]]; then
        printf 'export %s=%q && ' "${key}" "${!key}"
      fi
    done
  )"

  echo "run_id=${run_id}"
  docker_cmd exec "${id}" sh -lc "
    mkdir -p '${results_dir}' &&
    export BENCHMARK_RUN_ID='${run_id}' &&
    export BENCHMARK_RESULTS_DIR='${results_dir}' &&
    export BENCHMARK_SECKILL_WORKER_REPLICAS='${seckill_worker_replicas}' &&
    ${runner_exports}
    $*
  "
}

default_load_env() {
  local requests="$1"
  local concurrency="$2"
  printf "export BENCHMARK_REQUESTS=\"\${BENCHMARK_REQUESTS:-%s}\" && export BENCHMARK_HTTP_CONCURRENCY=\"\${BENCHMARK_HTTP_CONCURRENCY:-%s}\" && " "${requests}" "${concurrency}"
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
    stack_deploy 0 "$@"
    ;;
  stack-deploy-strict)
    shift
    stack_deploy 1 "$@"
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
  seckill-worker-scale)
    shift
    if [[ "$#" -ne 1 ]]; then
      echo "usage: $0 seckill-worker-scale <replicas>" >&2
      exit 1
    fi
    scale_seckill_worker "$1"
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
  run-nats-bypass)
    shift
    run_benchmark nats-bypass async "
      $(default_load_env 1000 100)
      export BENCHMARK_SCENARIO_NAME='buy-intent-bypass-created' &&
      export BENCHMARK_SCENARIO_FAMILY='buy-intent-bypass' &&
      export BENCHMARK_PATH_TAG='buy_intent_bypass' &&
      export BENCHMARK_INGRESS_APP_URLS='http://benchmark-go-backend:3000' &&
      export BENCHMARK_INGRESS_HEALTH_PATH='/api/products' &&
      export BENCHMARK_INGRESS_SOURCE='http' &&
      export BENCHMARK_CREATED_SOURCE='postgres' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='0' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  run-nats-bypass-steady)
    shift
    run_benchmark nats-bypass-steady async "
      $(default_load_env 1000 100)
      export BENCHMARK_SCENARIO_NAME='buy-intent-bypass-created-steady' &&
      export BENCHMARK_SCENARIO_FAMILY='buy-intent-bypass' &&
      export BENCHMARK_PATH_TAG='buy_intent_bypass' &&
      export BENCHMARK_INGRESS_APP_URLS='http://benchmark-go-backend:3000' &&
      export BENCHMARK_INGRESS_HEALTH_PATH='/api/products' &&
      export BENCHMARK_INGRESS_SOURCE='http' &&
      export BENCHMARK_CREATED_SOURCE='postgres' &&
      export BENCHMARK_STYLE='steady_state' &&
      export BENCHMARK_RESET_STATE='1' &&
      export BENCHMARK_ENSURE_SECKILL_ENABLED='0' &&
      pnpm --config.engine-strict=false benchmark:buy-intent
    "
    ;;
  run-seckill-full-api)
    shift
    run_benchmark seckill-full-api seckill "
      $(default_load_env 1000 100)
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
      $(default_load_env 10000 200)
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
      $(default_load_env 1000 100)
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
      $(default_load_env 10000 200)
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
  swarm-benchmark.sh stack-deploy-strict
  swarm-benchmark.sh stack-rm
  swarm-benchmark.sh stack-services
  swarm-benchmark.sh stack-ps
  swarm-benchmark.sh seckill-worker-scale <replicas>
  swarm-benchmark.sh runner-id
  swarm-benchmark.sh exec-runner <cmd...>
  swarm-benchmark.sh run-checkout-reset
  swarm-benchmark.sh run-checkout-cart-reset
  swarm-benchmark.sh run-checkout-sweep
  swarm-benchmark.sh run-nats-bypass
  swarm-benchmark.sh run-nats-bypass-steady
  swarm-benchmark.sh run-seckill-full-api
  swarm-benchmark.sh run-seckill-direct-kafka
  swarm-benchmark.sh run-seckill-full-api-steady
  swarm-benchmark.sh run-seckill-direct-kafka-steady
  swarm-benchmark.sh stack-wait [checkout|async|seckill|all]
  swarm-benchmark.sh artifact-pull <run_id>
  swarm-benchmark.sh logs <service>
EOF
    exit 1
    ;;
esac
