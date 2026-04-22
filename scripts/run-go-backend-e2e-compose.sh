#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
SUFFIX="${RUN_ID}-$RANDOM"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-minishop-go-backend-e2e-${SUFFIX}}"
APPLICATION_ID="${KAFKA_SECKILL_APPLICATION_ID:-minishop-seckill-e2e-${SUFFIX}}"
RESULT_SINK_GROUP_ID="${KAFKA_SECKILL_RESULT_SINK_GROUP_ID:-minishop-seckill-result-e2e-${SUFFIX}}"
LABEL_FILTER="${GINKGO_LABEL_FILTER:-full}"

cd "${REPO_ROOT}"

cleanup() {
  docker compose \
    -p "${PROJECT_NAME}" \
    -f docker-compose.go-backend-e2e.yml \
    down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

export KAFKA_SECKILL_APPLICATION_ID="${APPLICATION_ID}"
export KAFKA_SECKILL_RESULT_SINK_GROUP_ID="${RESULT_SINK_GROUP_ID}"

docker compose \
  -p "${PROJECT_NAME}" \
  -f docker-compose.go-backend-e2e.yml \
  up -d --build postgres nats redpanda go-backend worker-buy-intents-ingest worker-staged-buy-intents-process worker-seckill go-seckill-result-sink

docker compose \
  -p "${PROJECT_NAME}" \
  -f docker-compose.go-backend-e2e.yml \
  run --rm go-backend-e2e-runner \
  ginkgo -r -v --label-filter="${LABEL_FILTER}" --timeout=10m
