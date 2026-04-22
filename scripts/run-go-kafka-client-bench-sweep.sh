#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scenario_name="${BENCHMARK_SCENARIO_NAME:-go-kafka-producer-raw}"
results_root="${BENCHMARK_RESULTS_DIR:-$repo_root/benchmark-results}"
clients_csv="${GO_KAFKA_BENCH_CLIENTS:-sarama,franz-go}"
sizes_csv="${GO_KAFKA_BENCH_MESSAGE_SIZES:-1024,4096}"
repeats="${GO_KAFKA_BENCH_REPEATS:-3}"
summary_dir="$results_root/$scenario_name/summaries"
summary_file="$summary_dir/$(date -u +%Y-%m-%dT%H-%M-%S-000Z)_sweep_summary.json"

IFS=',' read -r -a clients <<< "$clients_csv"
IFS=',' read -r -a sizes <<< "$sizes_csv"

mkdir -p "$summary_dir"
summary_entries=()

run_one() {
  local client="$1"
  local size="$2"
  local repeat="$3"
  local run_id="go_kafka_raw_${client//[^a-zA-Z0-9]/_}_${size}b_r${repeat}_$(date -u +%Y%m%dT%H%M%SZ)"
  echo "[go-kafka-client-bench:sweep] client=${client} size=${size} repeat=${repeat} run_id=${run_id}"

  local output
  output="$(
    cd "$repo_root/services/go-kafka-client-bench" && \
    GO_KAFKA_BENCH_CLIENT="$client" \
    GO_KAFKA_BENCH_MESSAGE_BYTES="$size" \
    GO_KAFKA_BENCH_RUN_ID="$run_id" \
    BENCHMARK_SCENARIO_NAME="$scenario_name" \
    BENCHMARK_RESULTS_DIR="$results_root" \
    GO_KAFKA_BENCH_BROKERS="${GO_KAFKA_BENCH_BROKERS:-${KAFKA_BROKERS:-localhost:19092}}" \
    go run .
  )"

  printf '%s\n' "$output"
  local artifact_path
  artifact_path="$(printf '%s\n' "$output" | awk '/artifact written to /{print $4}' | tail -n1)"
  if [[ -z "$artifact_path" ]]; then
    echo "failed to locate artifact path for ${run_id}" >&2
    exit 1
  fi

  local entry
  entry="$(node - "$artifact_path" <<NODE
const fs = require('fs');
const p = process.argv[2];
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const bytes = j.measurements.find((m) => m.key === 'bytes_throughput')?.value ?? 0;
process.stdout.write(JSON.stringify({
  artifact: p,
  runId: j.runId,
  client: j.scenarioTags.client,
  messageBytes: Number(j.scenarioTags.messageBytes),
  repeat: Number(${repeat}),
  accepted: j.requestPath.accepted,
  errors: j.requestPath.errors,
  produceThroughput: j.measurements.find((m) => m.key === 'produce_throughput')?.value ?? 0,
  producerP95LatencyMs: j.requestPath.p95LatencyMs,
  bytesThroughput: bytes
}));
NODE
)"

  summary_entries+=("$entry")
}

for client in "${clients[@]}"; do
  client="$(echo "$client" | xargs)"
  [[ -n "$client" ]] || continue

  for size in "${sizes[@]}"; do
    size="$(echo "$size" | xargs)"
    [[ -n "$size" ]] || continue

    for repeat in $(seq 1 "$repeats"); do
      run_one "$client" "$size" "$repeat"
    done
  done
done

node - "$summary_file" "${summary_entries[@]}" <<'NODE'
const fs = require('fs');
const [summaryFile, ...entries] = process.argv.slice(2);
const parsed = entries.map((entry) => JSON.parse(entry));
const grouped = new Map();
for (const entry of parsed) {
  const key = `${entry.client}:${entry.messageBytes}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(entry);
}
const aggregates = [...grouped.values()].map((rows) => {
  const sortedThroughput = rows.map((row) => row.produceThroughput).sort((a, b) => a - b);
  const sortedP95 = rows.map((row) => row.producerP95LatencyMs).sort((a, b) => a - b);
  const mid = Math.floor(rows.length / 2);
  const median = (values) => values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  return {
    client: rows[0].client,
    messageBytes: rows[0].messageBytes,
    repeats: rows.length,
    throughputMedian: median(sortedThroughput),
    throughputMin: sortedThroughput[0],
    throughputMax: sortedThroughput[sortedThroughput.length - 1],
    producerP95MedianMs: median(sortedP95),
    errorsTotal: rows.reduce((sum, row) => sum + row.errors, 0),
  };
}).sort((a, b) => a.messageBytes - b.messageBytes || a.client.localeCompare(b.client));
fs.writeFileSync(summaryFile, JSON.stringify({ entries: parsed, aggregates }, null, 2) + '\n');
console.log(`sweep summary written to ${summaryFile}`);
console.table(aggregates);
NODE
