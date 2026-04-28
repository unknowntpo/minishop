# Homelab Docker Swarm 秒殺 full HTTP 實驗設計 - 2026-04-28

## 目標

本實驗用 homelab Docker Swarm 取代 OrbStack 本機環境，目的不是先追求單次最高 rps，而是拆清楚 full HTTP seckill 與 direct Kafka seckill 的差距來源。

## 目前追蹤資訊

- Repo HEAD：`e566af0e6e1025dd9e370485f384d212ec4dd767`
- HEAD 摘要：`e566af0 merge: swarm benchmark mainbase`
- 工作樹狀態：有未提交修改。至少包含 benchmark helper、runner instrumentation、Go backend ack 設定、worker partition 設定與 compose env propagation。
- 本文件紀錄的 OrbStack 結果不是乾淨 commit 的正式 benchmark，只用於設計 homelab 實驗與找變因。

核心問題：

1. full HTTP ingress 的主要限制是否來自 HTTP/API path。
2. `go-backend` Kafka producer 的 `linger` / batch 設定是否影響 full HTTP throughput。
3. 固定 API replicas 時，`BENCHMARK_HTTP_CONCURRENCY` 是否確實形成指定數量的 in-flight HTTP requests。
4. direct Kafka benchmark 與 full HTTP benchmark 的 load generator 模型差異有多大。
5. `maxProbe=4` 的 reroute amplification 對 Kafka / worker / result path 的成本是多少。

## 重要前提

### Full HTTP 與 Direct Kafka 的邊界不同

Full HTTP path：

```text
benchmark runner
-> HTTP POST /api/buy-intents
-> Swarm service / network path
-> go-backend HTTP server
-> request decode / validate / classify
-> seckill command build
-> go-backend Kafka producer
-> inventory.seckill.requested
-> Kafka Streams seckill worker
-> inventory.seckill.result
-> result sink
-> Postgres
```

Direct Kafka path：

```text
benchmark runner
-> build SeckillBuyIntentRequest in-process
-> Kafka producer sendBatch
-> inventory.seckill.requested
-> Kafka Streams seckill worker
-> inventory.seckill.result
-> result sink
-> Postgres
```

因此 direct Kafka rps 不能直接解讀為 full HTTP API 應達到的 rps。Direct Kafka 跳過 HTTP server、HTTP client、Swarm ingress path、Go request parsing、seckill routing、trace header injection、response write，以及 go-backend 內的 producer path。

### Load Generator 模型不同

Full HTTP burst path 使用：

```text
runWithConcurrency(effectiveRequests, BENCHMARK_HTTP_CONCURRENCY, createBuyIntent)
```

因此 `BENCHMARK_HTTP_CONCURRENCY` 控制同時 in-flight 的 HTTP request 數。

Direct Kafka burst path 使用：

```text
publishSeckillRequestsDirectly(...)
```

它目前依 `BENCHMARK_DIRECT_KAFKA_BATCH_SIZE` 分 batch，逐批 `sendBatch`，不使用 `BENCHMARK_HTTP_CONCURRENCY`。

因此 direct Kafka 與 full HTTP 是不同 load generator。後續若要做更公平比較，direct Kafka 需要另加：

```text
BENCHMARK_DIRECT_KAFKA_CONCURRENCY
```

讓多個 `sendBatch` 可以並行。

### Concurrency 需要實測

目前已在 `scripts/benchmark-buy-intent-temporal.ts` 加入 HTTP burst path 的 observed concurrency instrumentation，預期報告會多出：

```json
"requestPath": {
  "concurrency": {
    "configured": 300,
    "workers": 300,
    "maxInFlight": 300,
    "totalStarted": 1200,
    "totalCompleted": 1200
  }
}
```

這個欄位只適用 `ingressSource=http`。Direct Kafka path 不使用 `runWithConcurrency`，因此不應用這個欄位判讀。

## 固定基準條件

為了先隔離 HTTP/API 與 producer 參數，第一階段固定以下條件：

```text
API replicas: 1
seckill worker replicas: 1
Redpanda brokers: 1
bucket / partitions: 12
maxProbe: 1
Kafka required acks: all
OTel: off
requests: 10000 或 30000
result sink: 固定一種實作，不混用 Node 與 Go sink
```

`maxProbe=1` 是必要控制變因。若使用 `maxProbe=4`，10k HTTP requests 可能被 worker reroute 放大成約 40k request topic messages，會污染對 HTTP ingress 的判讀。

## 實驗 0：工具正確性驗證

目的：先確認 benchmark helper 與 runner report 可相信。

### 0.1 確認 HTTP concurrency 真的生效

條件：

```text
API=1
partitions=12
maxProbe=1
requests=1200
concurrency=300
```

判讀：

```text
requestPath.concurrency.configured = 300
requestPath.concurrency.workers = 300
requestPath.concurrency.maxInFlight = 300
requestPath.concurrency.totalStarted = 1200
requestPath.concurrency.totalCompleted = 1200
```

若 `maxInFlight < configured`，需要先修 runner 或 HTTP client 限制，不能進入正式實驗。

### 0.2 確認 service env 有套用到 go-backend

每輪 seckill run 前，`scripts/swarm-benchmark.sh` 應同步更新：

```text
KAFKA_SECKILL_BUCKET_COUNT
KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS
KAFKA_SECKILL_RESULT_TOPIC_PARTITIONS
KAFKA_SECKILL_DLQ_TOPIC_PARTITIONS
KAFKA_SECKILL_MAX_PROBE
KAFKA_SECKILL_CLIENT_LINGER_MS
KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS
```

否則 runner report 可能顯示某個參數，但真正的 `go-backend` service 仍在使用舊設定。

## 實驗 1：Full HTTP Producer Tuning

目的：確認 `go-backend` Kafka producer 的 `linger` 與 batch buffer 是否是 full HTTP ingress 的限制。

固定：

```text
API=1
worker=1
partitions=12
maxProbe=1
acks=all
requests=10000
concurrency=400
```

矩陣：

| Run | `KAFKA_SECKILL_CLIENT_LINGER_MS` | `KAFKA_SECKILL_CLIENT_BATCH_NUM_MESSAGES` | 說明 |
|---|---:|---:|---|
| A | 1 | 10000 | baseline |
| B | 5 | 10000 | 中等 linger |
| C | 20 | 10000 | 只提高 linger |
| D | 20 | 500 | 使用較小 batch buffer，驗證是否變差 |

主要觀察：

```text
requestPath.acceptRequestsPerSecond
requestPath.acceptLatencyMs.p95 / p99
intentCreation.createdThroughputPerSecond
backendTimings.seckill_publish.produce_call p95 / p99
backendTimings.seckill_publish.delivery_ack p95 / p99
request topic delta
result topic delta
```

判讀：

- 若提高 linger 後 rps 上升，表示 producer batching 對 full HTTP 有實質幫助。
- 若提高 linger 後 rps 下降或 latency 上升，表示 HTTP ingress 不是被小 batch 主導，或 linger 引入的等待超過 batching 收益。
- 若 `20ms / 500` 明顯變差，代表 batch buffer 不應低於目前壓力下的瞬時積壓。

## 實驗 2：High Pressure Producer Tuning

目的：確認在更高 offered load 下，producer tuning 是否能降低 c800 的排隊問題。

固定：

```text
API=1
worker=1
partitions=12
maxProbe=1
acks=all
requests=10000
concurrency=800
```

矩陣：

| Run | linger | batch buffer |
|---|---:|---:|
| A | 1ms | 10000 |
| B | 20ms | 10000 |

判讀：

- 若 c800 baseline p95 明顯上升且 rps 下降，代表 concurrency 已超過單 API 或 ingress path 的有效容量。
- 若 `20ms / 10000` 改善 c800，但不改善 c400，表示 batching 只在高壓時有價值。
- 若 c800 仍差，下一步應轉向 HTTP server、Swarm routing、runner 或 API CPU path。

## 實驗 3：HTTP Boundary Isolation

目的：拆分 HTTP/API path 與 Swarm ingress/routing path。

比較三條路徑：

| Run | Ingress | 說明 |
|---|---|---|
| A | runner -> `http://benchmark-go-backend:3000` | Swarm overlay service DNS 內部路徑 |
| B | runner/external -> published port | 經 Swarm published port / routing mesh |
| C | direct Kafka | 跳過 HTTP/API path |

固定：

```text
API=1
worker=1
partitions=12
maxProbe=1
requests=10000
concurrency=400 for HTTP
directKafkaBatchSize=500 for direct Kafka
```

判讀：

- A 明顯快於 B：Swarm published port / routing mesh 是重要限制。
- A 與 B 接近，但都遠低於 C：HTTP/API path 是主要限制。
- A 接近 C：先前差距主要來自外部 ingress 或 runner 模型。

## 實驗 4：API Replica Scale-Out

目的：在正確 offered load 下測 API scale-out。

固定：

```text
partitions=12
maxProbe=1
worker=1
broker=1
acks=all
使用實驗 1/2 找到的最佳 producer 設定
```

矩陣：

| API replicas | HTTP concurrency |
|---:|---:|
| 1 | 400 |
| 2 | 800 |
| 4 | 1600 |

判讀：

- 若 rps 隨 API replicas 上升，API path 是可水平擴展的。
- 若 rps 幾乎不變，限制在 shared downstream、Swarm routing、broker、worker、result sink 或 runner。
- 若 latency 隨 replicas 上升而 rps 不升，可能是共享瓶頸被更快打滿。

## 實驗 5：Partition Sweep

目的：在 reroute 關閉時測 partition / bucket 數是否改善 worker / Kafka path。

固定：

```text
API=1
concurrency=400
maxProbe=1
acks=all
requests=10000
```

矩陣：

| bucket / partitions |
|---:|
| 4 |
| 8 |
| 12 |
| 16 |

判讀：

- 若 partition 增加後 result throughput 上升，worker/Kafka partition parallelism 有幫助。
- 若 partition 增加後 rps 不變，限制更可能在 HTTP ingress 或單 broker。
- 若 partition 過高導致 Redpanda internal topic / memory 問題，需記錄為本機容量限制，不應解讀成業務邏輯錯誤。

## 實驗 6：真實 Reroute 語義成本

目的：量化 `maxProbe=4` 的成本。

固定：

```text
API=1
concurrency=400
partitions=12 或實驗 5 的最佳值
acks=all
requests=10000
```

矩陣：

| maxProbe |
|---:|
| 1 |
| 4 |

必看指標：

```text
request topic delta
retry_per_primary
result_per_primary
accepted rps
result topic rps
p95 / p99
```

判讀：

- `maxProbe=4` 若造成 request topic delta 約為 HTTP request 的 4 倍，代表下游成本被 reroute 放大。
- 若 `maxProbe=4` rps 下降但 result correctness 較完整，這是業務語義與吞吐量的取捨。
- 若 `maxProbe=1` 下 result_per_primary 穩定接近 1，則 benchmark 最大吞吐 baseline 應採用 `maxProbe=1`。

## 每輪必收資料

每次 run 應保存：

```text
run_id
git commit
service replica count
service env snapshot
topic list + partitions
accepted rps
result topic rps
HTTP p50 / p95 / p99
request topic delta
result topic delta
retry_per_primary
result_per_primary
go-backend timing snapshot
go-backend CPU / memory
Redpanda CPU / memory
worker CPU / memory
result sink CPU / memory
worker logs tail
result sink logs tail
```

其中 `go-backend` timing 至少包含：

```text
http_server.buy_intents.total
buy_intent.decode
buy_intent.classify
buy_intent.command_build
buy_intent.publish_seckill
seckill_publish.produce_call
seckill_publish.delivery_ack
```

## 建議執行順序

先不要一次跑完整矩陣。建議順序：

1. 工具正確性驗證：c300 observed concurrency。
2. Full HTTP baseline：`API=1, c400, p12, maxProbe=1, linger=1, batch=10000`。
3. Producer tuning：`linger=20, batch=10000`。
4. Direct Kafka 對照：`p12, maxProbe=1`。
5. High pressure：`API=1, c800, p12, maxProbe=1`。
6. 若 HTTP path 仍明顯落後 direct Kafka，再做 HTTP boundary isolation。
7. 最後才做 API scale-out 與 partition sweep。

## 初步假設

目前 OrbStack 結果顯示：

- `maxProbe=4` 會造成約 4 倍 Kafka request topic amplification。
- `maxProbe=1` 可以讓 request topic delta 回到 HTTP request 數量。
- 調大 linger 並未穩定提升 OrbStack full HTTP rps；本機環境抖動較大，需 homelab 驗證。
- `BENCHMARK_HTTP_CONCURRENCY` 應該只影響 full HTTP path；direct Kafka path 目前不受該參數控制。

Homelab 實驗應優先驗證這些假設，而不是直接調到最大規模。

## OrbStack 初步結果

以下結果在 OrbStack Docker Swarm 上取得，環境抖動較大，只作為 homelab 實驗設計依據。共同條件除表格列出者外為：

```text
API replicas = 1
worker replicas = 1
bucket / partitions = 12
acks = all
ingressSource = http
```

### Producer Tuning 對照

固定：

```text
requests = 10000
concurrency = 400
maxProbe = 1
```

| Run ID | linger | batch buffer | accepted rps | result rps | p95 | p99 | request topic delta | retry/primary | result/primary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `orb_api1_p12_c400_probe1_20260427T152656Z` | 1ms | 10000 | 1801.38 | 1815.11 | 403.61 ms | 498.10 ms | 10000 | 0 | 1.00 |
| `orb_api1_p12_c400_probe1_l1_b10000_rerun_20260428T074136Z` | 1ms | 10000 | 1560.05 | 1568.06 | 509.11 ms | 860.50 ms | 10000 | 0 | 1.00 |
| `orb_api1_p12_c400_probe1_l5_b10000_20260428T074026Z` | 5ms | 10000 | 1362.53 | 1368.90 | 475.61 ms | 659.96 ms | 10000 | 0 | 1.00 |
| `orb_api1_p12_c400_probe1_l20_b10000_20260428T073823Z` | 20ms | 10000 | 1679.63 | 1702.68 | 373.97 ms | 562.22 ms | 10000 | 0 | 1.00 |
| `orb_api1_p12_c400_probe1_l20_b500_20260428T073717Z` | 20ms | 500 | 1353.65 | 1359.38 | 535.48 ms | 559.76 ms | 10000 | 0 | 1.00 |

初步判讀：

- `20ms / 500` 明顯較差，batch buffer 降到 500 沒有改善 full HTTP ingress。
- `20ms / 10000` 在 2026-04-28 的同時段比 baseline rerun 好，但仍低於 2026-04-27 的 baseline。OrbStack 抖動明顯，不能把它當成穩定改善。
- `5ms / 10000` 在本機結果不佳。
- producer tuning 目前不是確定解法；homelab 應重跑同一矩陣。

### High Concurrency 對照

固定：

```text
requests = 10000
maxProbe = 1
linger = 1ms
batch buffer = 10000
```

| Run ID | concurrency | accepted rps | result rps | p95 | p99 | request topic delta | retry/primary | result/primary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `orb_api1_p12_c400_probe1_20260427T152656Z` | 400 | 1801.38 | 1815.11 | 403.61 ms | 498.10 ms | 10000 | 0 | 1.00 |
| `orb_api1_p12_c800_probe1_20260427T152747Z` | 800 | 1660.45 | 1679.68 | 953.86 ms | 1108.25 ms | 10000 | 0 | 1.00 |

初步判讀：

- c800 沒有提升吞吐，p95 / p99 明顯變差。
- 在 OrbStack 上，單 API 的有效 concurrency 甜蜜點比較接近 c400；c800 更像排隊。
- 這需要 homelab 驗證，因為 OrbStack 上同一 baseline 在不同時間可從 1560 到 1801 rps。

### Concurrency Instrumentation 驗證

已在 `scripts/benchmark-buy-intent-temporal.ts` 加入 HTTP burst path 的 observed concurrency 欄位。

驗證 run：

```text
run_id = orb_concurrency_probe_c300_after_rebuild_20260428T080402Z
requests = 1200
concurrency = 300
maxProbe = 1
linger = 1ms
batch buffer = 10000
```

結果：

```json
"requestPath": {
  "concurrency": {
    "configured": 300,
    "workers": 300,
    "maxInFlight": 300,
    "totalStarted": 1200,
    "totalCompleted": 1200
  }
}
```

該 run 的 throughput：

| accepted rps | result rps | p95 | p99 | request topic delta |
|---:|---:|---:|---:|---:|
| 976.28 | 998.56 | 732.29 ms | 735.89 ms | 1200 |

判讀：

- `BENCHMARK_HTTP_CONCURRENCY=300` 在 full HTTP burst path 確實形成 300 個 observed max in-flight requests。
- 這個短跑的 `seckillWorker` Prometheus counter 顯示 `primaryRequests=0`，但 result topic 與 command lifecycle 已回收 1200 個結果，推測是短跑與 Prometheus scrape timing 的觀測問題；正式 homelab run 應以較長 requests / steady-state 或更可靠的 Kafka/result counters 為準。
