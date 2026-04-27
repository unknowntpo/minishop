# Seckill 壓測路徑：為什麼 full API 與 direct Kafka 都要存在

基準版本：`main` at `ce9d291796ff22c4496ca14ccb934bc962cf836c`

Minishop 的 seckill path 不是一般 checkout path 的簡單放大。Hot SKU 在短時間內承受大量請求時，系統同時要處理 ingress throughput、Kafka partition、worker state、result sink 與 read model 更新。

因此 benchmark 需要兩條路徑：

- full API path
- direct Kafka path

兩者不是互相替代，而是用來拆解瓶頸。

## Full API path

Full API path 代表 production-style ingress：

```text
client / benchmark-runner
  -> go-backend
  -> Kafka request topic
  -> Kafka Streams worker
  -> Kafka result topic
  -> result sink
  -> PostgreSQL / read model
```

這條路徑會包含 HTTP parsing、JSON decode/encode、request context、middleware、seckill config lookup、Kafka producer enqueue 與 response write。它比較接近真實 API 使用者看到的 latency。

後來獨立的 `go-seckill-ingress` 被移除，`go-backend` 成為唯一 full API entry。原因是 production-style HTTP ingress 不應再分裂成兩套 service。需要更多 HTTP capacity 時，應 scale `go-backend` replicas，而不是保留一個 seckill-only ingress 旁路。

## Direct Kafka path

Direct Kafka path 是 benchmark-only ingress：

```text
benchmark-runner
  -> Kafka request topic
  -> Kafka Streams worker
  -> Kafka result topic
```

它繞過 HTTP API，直接測 Kafka broker、partition、Kafka Streams worker 與 result topic 的處理能力。

這條路徑回答的是：「如果排除 HTTP ingress，後面的 Kafka/worker pipeline 能跑多快？」

因此 direct Kafka 數字不能直接當 production API throughput，但它能幫助判斷瓶頸是否在 HTTP path。

## Async producer 的量測修正

go-backend 使用 franz-go async `Produce`。這裡有一個重要細節：`Produce()` return 只代表 record 被 client 接收並排入 producer pipeline，不代表 broker 已經 ack。

因此 benchmark instrumentation 需要分開量：

- `seckill_publish.produce_call`：呼叫 `Produce()` 的 enqueue cost。
- `seckill_publish.delivery_ack`：callback 執行時的 broker delivery/ack latency。

這個修正避免把 enqueue latency 誤讀成 Kafka produce 完成時間。

在一次 Orbstack Swarm run 中，full API burst 的觀察結果是：

```text
produce_call p95     ≈ 0.022ms
delivery_ack p95     ≈ 14.525ms
delivery_ack p99     ≈ 19.982ms
delivery_success     = 1000
client p95           ≈ 84.46ms
backend server p95   ≈ 0.385ms
```

這組數字表示 Kafka ack 有成本，但不在 HTTP response critical path。client p95 與 backend handler p95 的差距，提示瓶頸還可能存在於 HTTP stack、benchmark runner 到 backend 的連線、Swarm routing mesh、middleware 或系統排程。

## pprof 的角色

Go backend 開啟 pprof 後，可以用 `go tool pprof` 觀察 CPU profile。一次有效 profile 顯示熱點主要落在 `net/http`、syscall、OpenTelemetry wrapper、JSON 與 response write 等區域，而不是 franz-go `Produce` 本身。

這不表示 Kafka 沒成本，而是說 full API path 的慢不能只用「Kafka producer 慢」解釋。這也是為什麼 direct Kafka path 必須保留：它提供一條繞過 HTTP 的對照組。

## Swarm benchmark stack 的隔離

Swarm benchmark stack 將服務拆成角色：

```text
db      -> benchmark-postgres
msg     -> benchmark-nats, benchmark-redpanda
api     -> benchmark-go-backend
worker  -> worker-seckill, result sink
bench   -> benchmark-runner
obs     -> prometheus
```

透過 node label placement，可以在多機環境中把 DB、broker、API、worker、runner、observability 拆開。這次目標不是 production HA，而是讓 benchmark path 可跑、拓樸清楚、artifact 可回收。

Artifact 不使用 local bind mount，而是保留在 runner container/volume 中。跑完後用 `docker cp` 拉回本地。這符合 Swarm workflow，也避免 container 與本機路徑綁死。

## Justfile 是 benchmark console

benchmark 操作集中在 Justfile，例如：

```text
just stack-deploy
just stack-wait seckill
just seckill-full-api
just seckill-direct-kafka
just seckill-worker-scale 2
just artifact-pull <run_id>
```

這讓 benchmark 不再依賴口耳相傳的 shell command。更重要的是，readiness gate 被放在 helper 端：等 PostgreSQL、go-backend、Kafka topics、consumer group stable 後才開始 benchmark。

`docker stack deploy` 本身不保證 service dependency readiness，因此 readiness 不應假裝由 compose `depends_on` 解決。
