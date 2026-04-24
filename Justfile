set shell := ["bash", "-euo", "pipefail", "-c"]

default:
  @just --list

# Deploy or update the Swarm benchmark stack
stack-deploy:
  ./scripts/swarm-benchmark.sh stack-deploy

# Deploy or update the Swarm benchmark stack with strict image preflight
stack-deploy-strict:
  ./scripts/swarm-benchmark.sh stack-deploy-strict

# Remove the Swarm benchmark stack
stack-rm:
  ./scripts/swarm-benchmark.sh stack-rm

# List stack services
stack-services:
  ./scripts/swarm-benchmark.sh stack-services

# List stack tasks
stack-ps:
  ./scripts/swarm-benchmark.sh stack-ps

# Wait for benchmark stack readiness gates
stack-wait mode="all":
  ./scripts/swarm-benchmark.sh stack-wait {{mode}}

# Scale the seckill Kafka Streams worker and wait for group stability
seckill-worker-scale replicas:
  ./scripts/swarm-benchmark.sh seckill-worker-scale {{replicas}}

# Print the active benchmark runner container id
runner-id:
  ./scripts/swarm-benchmark.sh runner-id

# Execute a command inside the benchmark runner container
exec-runner +cmd:
  ./scripts/swarm-benchmark.sh exec-runner {{cmd}}

# Reset checkout benchmark state and run the single-SKU checkout benchmark
checkout-reset:
  ./scripts/swarm-benchmark.sh run-checkout-reset

# Reset checkout benchmark state and run the cart checkout benchmark
checkout-cart-reset:
  ./scripts/swarm-benchmark.sh run-checkout-cart-reset

# Run the checkout concurrency sweep
checkout-sweep:
  ./scripts/swarm-benchmark.sh run-checkout-sweep

# Run the async NATS buy-intent benchmark path
nats-bypass:
  ./scripts/swarm-benchmark.sh run-nats-bypass

# Run the async NATS buy-intent benchmark path in steady-state mode
nats-bypass-steady:
  ./scripts/swarm-benchmark.sh run-nats-bypass-steady

# Run the seckill full API benchmark path
seckill-full-api:
  ./scripts/swarm-benchmark.sh run-seckill-full-api

# Run the seckill direct Kafka benchmark path
seckill-direct-kafka:
  ./scripts/swarm-benchmark.sh run-seckill-direct-kafka

# Run the seckill full API benchmark in steady-state mode
seckill-full-api-steady:
  ./scripts/swarm-benchmark.sh run-seckill-full-api-steady

# Run the seckill direct Kafka benchmark in steady-state mode
seckill-direct-kafka-steady:
  ./scripts/swarm-benchmark.sh run-seckill-direct-kafka-steady

# Pull one run's artifacts out of the runner container
artifact-pull run_id:
  ./scripts/swarm-benchmark.sh artifact-pull {{run_id}}

# Stream service logs from the Swarm stack
logs service:
  ./scripts/swarm-benchmark.sh logs {{service}}
