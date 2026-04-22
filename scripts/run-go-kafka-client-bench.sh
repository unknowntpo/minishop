#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
clients_csv="${GO_KAFKA_BENCH_CLIENTS:-sarama,franz-go}"
IFS=',' read -r -a clients <<< "$clients_csv"

for client in "${clients[@]}"; do
  client="$(echo "$client" | xargs)"
  [[ -n "$client" ]] || continue

  run_id="go_kafka_raw_${client//[^a-zA-Z0-9]/_}_$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[go-kafka-client-bench] client=${client} run_id=${run_id}"

  if [[ "$client" == "rust-rdkafka" ]]; then
    (
      cd "$repo_root/services/rust-kafka-client-bench"
      GO_KAFKA_BENCH_CLIENT="$client" \
      GO_KAFKA_BENCH_RUN_ID="$run_id" \
      BENCHMARK_SCENARIO_NAME="${BENCHMARK_SCENARIO_NAME:-go-kafka-producer-raw}" \
      BENCHMARK_RESULTS_DIR="${BENCHMARK_RESULTS_DIR:-$repo_root/benchmark-results}" \
      GO_KAFKA_BENCH_BROKERS="${GO_KAFKA_BENCH_BROKERS:-${KAFKA_BROKERS:-localhost:19092}}" \
      cargo run --quiet
    )
  else
    (
      cd "$repo_root/services/go-kafka-client-bench"
      GO_KAFKA_BENCH_CLIENT="$client" \
      GO_KAFKA_BENCH_RUN_ID="$run_id" \
      BENCHMARK_SCENARIO_NAME="${BENCHMARK_SCENARIO_NAME:-go-kafka-producer-raw}" \
      BENCHMARK_RESULTS_DIR="${BENCHMARK_RESULTS_DIR:-$repo_root/benchmark-results}" \
      GO_KAFKA_BENCH_BROKERS="${GO_KAFKA_BENCH_BROKERS:-${KAFKA_BROKERS:-localhost:19092}}" \
      go run .
    )
  fi
done
