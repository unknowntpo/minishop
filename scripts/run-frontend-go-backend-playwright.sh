#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
SUFFIX="${RUN_ID}-$RANDOM"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-minishop-frontend-go-e2e-${SUFFIX}}"

POSTGRES_PORT="${MINISHOP_FE_E2E_POSTGRES_PORT:-55433}"
GO_BACKEND_PORT="${MINISHOP_FE_E2E_GO_BACKEND_PORT:-53005}"
APP_PORT="${MINISHOP_FE_E2E_APP_PORT:-53001}"

APP_ORIGIN="http://127.0.0.1:${APP_PORT}"
API_BASE_URL="http://127.0.0.1:${GO_BACKEND_PORT}"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${POSTGRES_PORT}/minishop"

wait_for_http() {
  local url="$1"
  local name="$2"

  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "[frontend-go-e2e] timed out waiting for ${name}: ${url}" >&2
  return 1
}

cleanup() {
  docker compose \
    -p "${PROJECT_NAME}" \
    -f docker-compose.frontend-go-backend-e2e.yml \
    down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

cd "${REPO_ROOT}"

export MINISHOP_POSTGRES_PORT="${POSTGRES_PORT}"
export MINISHOP_GO_BACKEND_PORT="${GO_BACKEND_PORT}"
export MINISHOP_APP_PORT="${APP_PORT}"
export GO_BACKEND_CORS_ALLOWED_ORIGINS="${APP_ORIGIN}"
export NEXT_PUBLIC_API_BASE_URL="${API_BASE_URL}"
export OTEL_ENABLED=0
export NEXT_TELEMETRY_DISABLED=1

docker compose \
  -p "${PROJECT_NAME}" \
  -f docker-compose.frontend-go-backend-e2e.yml \
  up -d --build postgres nats redpanda go-backend app app-lb worker-buy-intents-ingest worker-staged-buy-intents-process

wait_for_http "${API_BASE_URL}/healthz" "go-backend"

MINISHOP_ALLOW_DB_RESET=1 \
DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false exec tsx scripts/reset-dev-db.ts

DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false db:migrate

DATABASE_URL="${DATABASE_URL}" \
pnpm --config.engine-strict=false db:seed:dev

wait_for_http "${APP_ORIGIN}/products" "frontend"

PLAYWRIGHT_BASE_URL="${APP_ORIGIN}" \
PLAYWRIGHT_API_BASE_URL="${API_BASE_URL}" \
pnpm --config.engine-strict=false exec playwright test e2e/frontend-go-backend.spec.ts "$@"
