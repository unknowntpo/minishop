---
name: minishop-gcp-swarm-benchmark
description: Run MiniShop full HTTP seckill benchmarks on the GCP Docker Swarm benchmark cluster, including Artifact Registry image publishing, Terraform VM creation, Swarm bootstrap, stack deployment, API/concurrency sweeps, artifact collection, and cleanup.
---

# MiniShop GCP Swarm Benchmark

Use this skill when the user wants to run or repeat MiniShop seckill/full HTTP benchmarks on GCP.

## Guardrails

- Conclusion first in user updates.
- GCP costs real money. Before long sweeps, state the VM shape and remind the user whether the cluster is still running.
- Use the infra worktree at `/Users/unknowntpo/repo/unknowntpo/infra/gcp-swarm-ce`.
- Use project `web-service-design`, region `us-central1`, zone `us-central1-a`, Artifact Registry repo `swarm-bench`.
- Prefer IAP SSH: direct external SSH often times out.
- Do not run the HTTP load generator on the `e2-small` manager. Use a worker-hosted runner container or a one-off worker container.

## Build And Push Images

From the MiniShop repo:

```bash
TAG="$(git rev-parse --short=12 HEAD)"
REGISTRY="us-central1-docker.pkg.dev/web-service-design/swarm-bench"
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
gcloud artifacts repositories create swarm-bench --repository-format=docker --location=us-central1 --description="MiniShop Swarm benchmark images" || true
docker buildx build --platform linux/amd64 -f Dockerfile.go-backend -t "$REGISTRY/minishop-go-backend:$TAG" --push .
docker buildx build --platform linux/amd64 -f Dockerfile.worker -t "$REGISTRY/minishop-node-worker:$TAG" --push .
docker buildx build --platform linux/amd64 -f Dockerfile.go-seckill-result-sink -t "$REGISTRY/minishop-go-seckill-result-sink:$TAG" --push .
docker buildx build --platform linux/amd64 -f Dockerfile.seckill-worker -t "$REGISTRY/minishop-worker-seckill:$TAG" --push .
```

Record the exact commit id and image tag in the benchmark notes.

## Create And Bootstrap GCP Swarm

Terraform path:

```bash
cd /Users/unknowntpo/repo/unknowntpo/infra/gcp-swarm-ce/gcp/10-benchmark-swarm/envs/dev
terraform init -backend-config=../../../backend-config.hcl
terraform apply -auto-approve -var='project_id=web-service-design'
```

Expected default shape:

- `swarm-bench-dev-mgr-01`: `e2-small`, manager, drained
- `swarm-bench-dev-worker-01..03`: `e2-custom-2-8192`, workers

Grant pull permission to the VM service account:

```bash
gcloud projects add-iam-policy-binding web-service-design \
  --member=serviceAccount:swarm-bench-dev-sa@web-service-design.iam.gserviceaccount.com \
  --role=roles/artifactregistry.reader \
  --quiet
```

Bootstrap:

```bash
cd /Users/unknowntpo/repo/unknowntpo/infra/gcp-swarm-ce
PROJECT_ID=web-service-design ZONE=us-central1-a NAME_PREFIX=swarm-bench-dev scripts/gcp-swarm-bootstrap.sh
```

Verify:

```bash
gcloud compute ssh swarm-bench-dev-mgr-01 --zone=us-central1-a --tunnel-through-iap --command='sudo docker node ls'
```

## Authenticate And Pre-Pull Images

Run on manager and every worker:

```bash
gcloud compute ssh <node> --zone=us-central1-a --tunnel-through-iap \
  --command='gcloud auth print-access-token | sudo docker login -u oauth2accesstoken --password-stdin https://us-central1-docker.pkg.dev'
```

Pre-pull app images on every worker. Swarm may otherwise reject tasks with `No such image` even after manager login.

```bash
gcloud compute ssh <worker> --zone=us-central1-a --tunnel-through-iap --command='
sudo docker pull us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-go-backend:<TAG> &&
sudo docker pull us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-node-worker:<TAG> &&
sudo docker pull us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-go-seckill-result-sink:<TAG> &&
sudo docker pull us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-worker-seckill:<TAG>'
```

## Deploy Stack

Copy the minimal stack files to the manager:

```bash
gcloud compute ssh swarm-bench-dev-mgr-01 --zone=us-central1-a --tunnel-through-iap --command='mkdir -p /tmp/minishop-bench/scripts /tmp/minishop-bench/ops/benchmark'
gcloud compute scp docker-compose.benchmark.yml swarm-bench-dev-mgr-01:/tmp/minishop-bench/docker-compose.benchmark.yml --zone=us-central1-a --tunnel-through-iap
gcloud compute scp scripts/swarm-benchmark.sh swarm-bench-dev-mgr-01:/tmp/minishop-bench/scripts/swarm-benchmark.sh --zone=us-central1-a --tunnel-through-iap
gcloud compute scp ops/benchmark/prometheus.yml swarm-bench-dev-mgr-01:/tmp/minishop-bench/ops/benchmark/prometheus.yml --zone=us-central1-a --tunnel-through-iap
```

Deploy with remote images:

```bash
gcloud compute ssh swarm-bench-dev-mgr-01 --zone=us-central1-a --tunnel-through-iap --command='
cd /tmp/minishop-bench &&
chmod +x scripts/swarm-benchmark.sh &&
sudo -E BENCHMARK_BUILD_POLICY=missing \
BENCHMARK_GO_BACKEND_IMAGE=us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-go-backend:<TAG> \
BENCHMARK_NODE_WORKER_IMAGE=us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-node-worker:<TAG> \
BENCHMARK_RUNNER_IMAGE=us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-node-worker:<TAG> \
BENCHMARK_GO_SECKILL_RESULT_SINK_IMAGE=us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-go-seckill-result-sink:<TAG> \
BENCHMARK_WORKER_SECKILL_IMAGE=us-central1-docker.pkg.dev/web-service-design/swarm-bench/minishop-worker-seckill:<TAG> \
./scripts/swarm-benchmark.sh stack-deploy'
```

Initialize DB once from the runner worker:

```bash
gcloud compute ssh swarm-bench-dev-worker-03 --zone=us-central1-a --tunnel-through-iap --command='
cid=$(sudo docker ps --filter label=com.docker.swarm.service.name=minishop-benchmark_benchmark-runner --format "{{.ID}}" | head -n 1)
sudo docker exec "$cid" sh -lc "pnpm --config.engine-strict=false benchmark:checkout:postgres:reset"'
```

## Run Full HTTP Seckill Sweep

Fixed parameters for comparable runs:

```text
BENCHMARK_REQUESTS=10000
BENCHMARK_HTTP_CLIENT=go-http
BENCHMARK_SECKILL_BUCKET_COUNT=12
BENCHMARK_SECKILL_MAX_PROBE=1
KAFKA_SECKILL_CLIENT_LINGER_MS=20
KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=500
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all
```

First scale matrix:

| API replicas | concurrency |
|---:|---:|
| 1 | 200 |
| 2 | 400 |
| 4 | 800 |

For each run:

1. On manager, scale `benchmark-go-backend` and pause `benchmark-worker-seckill`.
2. Force update backend, worker, and result sink env with 12 partitions, `maxProbe=1`, linger/batch, and unique group ids.
3. On the Redpanda worker, delete and recreate `inventory.seckill.requested`, `inventory.seckill.result`, and `inventory.seckill.dlq` with 12 partitions.
4. Restart `benchmark-worker-seckill`.
5. On the runner worker, execute `pnpm --config.engine-strict=false benchmark:buy-intent` inside the runner container.

The runner command shape:

```bash
rid=gcp_full_api_a${API}_c${CONCURRENCY}_$(date -u +%Y%m%dT%H%M%SZ)
cid=$(sudo docker ps --filter label=com.docker.swarm.service.name=minishop-benchmark_benchmark-runner --format "{{.ID}}" | head -n 1)
sudo docker exec "$cid" sh -lc "
mkdir -p /tmp/benchmark-results/$rid &&
export BENCHMARK_RUN_ID=$rid BENCHMARK_RESULTS_DIR=/tmp/benchmark-results/$rid \
BENCHMARK_REQUESTS=10000 BENCHMARK_HTTP_CONCURRENCY=${CONCURRENCY} BENCHMARK_HTTP_CLIENT=go-http \
BENCHMARK_STYLE=burst BENCHMARK_SCENARIO_NAME=seckill-full-api BENCHMARK_SCENARIO_FAMILY=seckill-full-api \
BENCHMARK_PATH_TAG=seckill_full_api BENCHMARK_INGRESS_SOURCE=http BENCHMARK_CREATED_SOURCE=kafka_seckill_result \
BENCHMARK_RESET_STATE=1 BENCHMARK_ENSURE_SECKILL_ENABLED=1 BENCHMARK_SECKILL_BUCKET_COUNT=12 BENCHMARK_SECKILL_MAX_PROBE=1 \
KAFKA_SECKILL_CLIENT_LINGER_MS=20 KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES=500 KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all &&
pnpm --config.engine-strict=false benchmark:buy-intent"
```

## Known 2026-04-28 Baseline

Image tag / commit: `d088abe63d13`.

| API replicas | concurrency | run id | HTTP accepted RPS | Kafka durable accepted | p95 latency |
|---:|---:|---|---:|---:|---:|
| 1 | 200 | `gcp_full_api_a1_c200_20260428T125219Z` | `6,694/s` | 10000 | `44.97ms` |
| 2 | 400 | `gcp_full_api_a2_c400_20260428T125525Z` | `5,077/s` | 10000 | `126.05ms` |
| 4 | 800 | `gcp_full_api_a4_c800_20260428T125826Z` | `5,998/s` | 10000 | `214.11ms` |

Interpretation: durable Kafka publish stayed complete, but API scale-out did not improve throughput in this GCP Swarm topology. Tail latency worsened as replicas/concurrency rose, so investigate Swarm VIP/routing mesh, worker placement, and single Redpanda broker pressure before adding API replicas.

## Artifact Pull

Copy artifacts out of the runner container on its worker:

```bash
gcloud compute ssh swarm-bench-dev-worker-03 --zone=us-central1-a --tunnel-through-iap --command='
rm -rf /tmp/gcp-benchmark-results-copy &&
mkdir -p /tmp/gcp-benchmark-results-copy &&
cid=$(sudo docker ps --filter label=com.docker.swarm.service.name=minishop-benchmark_benchmark-runner --format "{{.ID}}" | head -n 1)
sudo docker cp "$cid":/tmp/benchmark-results/<RUN_ID> /tmp/gcp-benchmark-results-copy/
sudo chown -R $(id -u):$(id -g) /tmp/gcp-benchmark-results-copy'

gcloud compute scp --recurse swarm-bench-dev-worker-03:/tmp/gcp-benchmark-results-copy/. benchmark-results/<LOCAL_DIR> --zone=us-central1-a --tunnel-through-iap
```

## Cleanup

If the user is done reviewing the live cluster, remove the stack and destroy Terraform resources:

```bash
gcloud compute ssh swarm-bench-dev-mgr-01 --zone=us-central1-a --tunnel-through-iap --command='cd /tmp/minishop-bench && sudo -E ./scripts/swarm-benchmark.sh stack-rm'
cd /Users/unknowntpo/repo/unknowntpo/infra/gcp-swarm-ce/gcp/10-benchmark-swarm/envs/dev
terraform destroy -auto-approve -var='project_id=web-service-design'
```
