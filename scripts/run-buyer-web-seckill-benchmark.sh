#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUN_ID="${BUYER_WEB_BENCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
SANITIZED_RUN_ID="$(printf '%s' "${RUN_ID}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
SUFFIX="${SANITIZED_RUN_ID}-$RANDOM"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-minishop-buyer-web-seckill-bench-${SUFFIX}}"

pick_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

POSTGRES_PORT="${MINISHOP_BUYER_WEB_BENCH_POSTGRES_PORT:-$(pick_free_port)}"
GO_BACKEND_PORT="${MINISHOP_BUYER_WEB_BENCH_GO_BACKEND_PORT:-$(pick_free_port)}"
BUYER_WEB_PORT="${MINISHOP_BUYER_WEB_BENCH_PORT:-$(pick_free_port)}"
APP_ORIGIN="http://127.0.0.1:${BUYER_WEB_PORT}"
API_BASE_URL="http://127.0.0.1:${GO_BACKEND_PORT}"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${POSTGRES_PORT}/minishop"
SECKILL_APP_ID="minishop-seckill-worker-buyer-web-bench-${SUFFIX}"
SECKILL_RESULT_SINK_GROUP_ID="minishop-seckill-result-sink-buyer-web-bench-${SUFFIX}"
BUYER_WEB_PID=""

wait_for_http() {
  local url="$1"
  local name="$2"

  for _ in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[buyer-web-seckill-bench] timed out waiting for ${name}: ${url}" >&2
  return 1
}

cleanup() {
  if [[ -n "${BUYER_WEB_PID}" ]]; then
    kill "${BUYER_WEB_PID}" >/dev/null 2>&1 || true
    wait "${BUYER_WEB_PID}" >/dev/null 2>&1 || true
  fi

  docker compose \
    -p "${PROJECT_NAME}" \
    -f docker-compose.frontend-go-backend-e2e.yml \
    down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

cd "${REPO_ROOT}"

export MINISHOP_POSTGRES_PORT="${POSTGRES_PORT}"
export MINISHOP_GO_BACKEND_PORT="${GO_BACKEND_PORT}"
export GO_BACKEND_CORS_ALLOWED_ORIGINS="${APP_ORIGIN}"
export OTEL_ENABLED=0
export NEXT_TELEMETRY_DISABLED=1
export KAFKA_SECKILL_APPLICATION_ID="${SECKILL_APP_ID}"
export KAFKA_SECKILL_RESULT_SINK_GROUP_ID="${SECKILL_RESULT_SINK_GROUP_ID}"
export SECKILL_BUCKET_COUNT="${SECKILL_BUCKET_COUNT:-4}"
export KAFKA_SECKILL_BUCKET_COUNT="${KAFKA_SECKILL_BUCKET_COUNT:-${SECKILL_BUCKET_COUNT}}"
export KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS="${KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT}}"
export KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS="${KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT}}"
export KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS="${KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS:-${SECKILL_BUCKET_COUNT}}"

docker compose \
  -p "${PROJECT_NAME}" \
  -f docker-compose.frontend-go-backend-e2e.yml \
  down -v --remove-orphans >/dev/null 2>&1 || true

docker compose \
  -p "${PROJECT_NAME}" \
  -f docker-compose.frontend-go-backend-e2e.yml \
  up -d --build postgres nats redpanda go-backend worker-buy-intents-ingest worker-staged-buy-intents-process worker-seckill go-seckill-result-sink

wait_for_http "${API_BASE_URL}/healthz" "go-backend"

MINISHOP_ALLOW_DB_RESET=1 \
DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false exec tsx scripts/reset-dev-db.ts

DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false db:migrate

SEED_DEV_CATALOG_ON_HAND_OVERRIDES="sku_hot_001:${BUYER_WEB_BENCH_SECKILL_STOCK:-${BUYER_WEB_BENCH_REQUESTS:-120}}" \
DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false db:seed:dev

docker compose -p "${PROJECT_NAME}" -f docker-compose.frontend-go-backend-e2e.yml exec -T redpanda \
  rpk topic delete inventory.seckill.requested inventory.seckill.result inventory.seckill.dlq >/dev/null 2>&1 || true
docker compose -p "${PROJECT_NAME}" -f docker-compose.frontend-go-backend-e2e.yml exec -T redpanda \
  rpk topic create inventory.seckill.requested -p "${SECKILL_BUCKET_COUNT}" -r 1 >/dev/null
docker compose -p "${PROJECT_NAME}" -f docker-compose.frontend-go-backend-e2e.yml exec -T redpanda \
  rpk topic create inventory.seckill.result -p "${SECKILL_BUCKET_COUNT}" -r 1 >/dev/null
docker compose -p "${PROJECT_NAME}" -f docker-compose.frontend-go-backend-e2e.yml exec -T redpanda \
  rpk topic create inventory.seckill.dlq -p "${SECKILL_BUCKET_COUNT}" -r 1 >/dev/null

docker compose -p "${PROJECT_NAME}" -f docker-compose.frontend-go-backend-e2e.yml up -d --force-recreate worker-seckill go-seckill-result-sink >/dev/null
sleep 10

VITE_API_BASE_URL="${API_BASE_URL}" \
VITE_APP_MODE="${BUYER_WEB_VITE_APP_MODE:-dev}" \
pnpm --config.engine-strict=false buyer-web:build

VITE_API_BASE_URL="${API_BASE_URL}" \
VITE_APP_MODE="${BUYER_WEB_VITE_APP_MODE:-dev}" \
pnpm --config.engine-strict=false exec vite preview --config buyer-web/vite.config.ts --host 127.0.0.1 --port "${BUYER_WEB_PORT}" >/tmp/minishop-buyer-web-seckill-bench-preview.log 2>&1 &
BUYER_WEB_PID=$!

wait_for_http "${APP_ORIGIN}/products" "buyer-web"

BUYER_WEB_BENCH_APP_URL="${APP_ORIGIN}" \
BUYER_WEB_BENCH_API_URL="${API_BASE_URL}" \
BUYER_WEB_BENCH_RUN_ID="${RUN_ID}" \
BUYER_WEB_BENCH_BUCKET_COUNT="${SECKILL_BUCKET_COUNT}" \
pnpm --config.engine-strict=false exec tsx scripts/benchmark-buyer-web-seckill.ts
