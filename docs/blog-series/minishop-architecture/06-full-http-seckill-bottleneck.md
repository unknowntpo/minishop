# Full HTTP seckill 瓶頸定位：不是 JSON，也不是 Go producer

基準版本：`codex/improve-full-http-seckit` at `981dcfc488c136c0019711b95d75bc172f614b6f`

相關 commit：

- `85685c54885b0d69974f045d1545ce450bfe80e9`：direct Kafka path 改用 Go/franz-go producer。
- `981dcfc488c136c0019711b95d75bc172f614b6f`：go-backend 新增 internal seckill produce benchmark endpoint。
- `372de937773409429b3f74d34cd0227a3eed7d0c`：新增 Go full HTTP load generator，用來隔離 Node.js HTTP client 的影響。

這篇文章記錄一次 full HTTP seckill throughput 瓶頸定位。重點不是把某一個 benchmark 數字寫成絕對效能，而是建立一條可檢查的證據鏈：哪一層慢、哪一層不慢，以及下一個實驗應該切在哪裡。

## 背景

Seckill full HTTP path 原本測的是 production-style ingress：

```text
benchmark runner
  -> go-backend HTTP API
  -> Kafka request topic
  -> seckill worker
  -> Kafka result topic
  -> result collector / PostgreSQL
```

Direct Kafka path 則是 benchmark-only 對照組：

```text
benchmark runner
  -> Kafka request topic
  -> seckill worker
  -> Kafka result topic
```

如果 direct Kafka 很快，但 full HTTP 很慢，不能直接得出「Kafka 沒問題」或「HTTP 一定有問題」。需要繼續拆出以下成本：

- request generator 是否真的送出足夠 concurrency。
- HTTP accepted 是否等於 Kafka durable accepted。
- JSON marshal 是否成為 CPU 熱點。
- go-backend 的 franz-go producer enqueue 是否卡住。
- Docker Swarm service VIP、routing mesh、HTTP connection scheduling 是否引入 queueing。

## Benchmark 語意修正

go-backend 的 seckill publish 使用 franz-go async `Produce()`。`Produce()` return 只代表 record 被 producer 接收並排入 client pipeline，不代表 broker 已經 ack。

因此 benchmark artifact 需要分開兩個概念：

- `requestPath.accepted`：client 收到 HTTP `202 Accepted` 的數量。
- `requestPath.kafkaDurableAccepted`：Kafka/Redpanda producer callback 回報成功 ack 的數量。

在 full HTTP path，`kafkaDurableAccepted` 由 go-backend Prometheus metrics 彙總：

```text
sum(minishop_backend_seckill_publish_delivery_success_total)
```

在 direct Kafka path，producer 已經移到 Go helper 內部，因此 durable accepted 由 direct producer callback 結果計算，不再讀 go-backend metrics。

這個修正避免把「HTTP accepted」誤讀成「Kafka durable accepted」。

## Direct Kafka 改用 Go/franz-go

原本 direct Kafka path 由 Node.js benchmark script 產生 payload，並使用 Node Kafka client 發送。為了讓 direct path 與 go-backend 使用同一類 Kafka producer，後來新增 `services/seckill-direct-franz-publisher`：

```text
Node benchmark script
  -> spawn Go helper once
  -> pass small config through stdin
  -> Go helper generates JSON payload and keys
  -> franz-go produces all records
  -> Go helper waits for callbacks
  -> Go helper returns command ids / accepted timestamps once
```

這裡沒有每筆 produce 都跨 Node/Go 溝通。Node 只負責傳入小型 config，Go helper 產生 payload、送 Kafka、等待 callback，最後一次性回傳結果。

Direct Kafka payload 與 full HTTP seckill payload 維持同一個語意：

- payload 是 `seckillBuyIntentRequest` 對應的 JSON。
- key 是 bucket processing key，例如 `sku_hot_001#03`。
- partition 由 bucket id 決定。
- command id、buyer id、idempotency key 由 benchmark run 產生。

## 第一組對照：direct Kafka 與 full HTTP

測試環境：

- OrbStack Docker Swarm。
- requests：`10000`。
- HTTP concurrency：`300`。
- seckill buckets / Kafka partitions：`12`。
- `maxProbe=1`。
- seckill worker replicas：`1`。
- Redpanda：single broker。

結果：

| path | run id | accepted | Kafka durable accepted | accepted RPS | p95 latency |
|---|---:|---:|---:|---:|---:|
| direct Kafka franz-go | `orb_compare_direct_10k_20260428T093023Z` | 10000 | 10000 | `54,468/s` | `12.84ms` |
| full HTTP, API=4 | `orb_compare_full_http_10k_20260428T093111Z` | 10000 | 10000 | `1,279/s` | `437.83ms` |

這組結果表示 direct Kafka producer、broker request topic、seckill worker、result topic 在該環境下可以處理遠高於 full HTTP 的吞吐。full HTTP 的低 throughput 仍可能來自 HTTP ingress、Swarm service routing、client closed-loop scheduling，或 backend handler 本身。

因此還不能直接把原因歸給 Swarm。需要再切掉外部 HTTP fanout。

## 第二組對照：API replica 不增加 throughput

同樣 10k / concurrency 300 / 12 buckets / maxProbe 1，將 go-backend API replicas 改成 1：

| path | API replicas | HTTP accepted RPS | Kafka durable accepted | result throughput |
|---|---:|---:|---:|---:|
| full HTTP | 4 | `1,279/s` | 10000 | `1,285/s` |
| full HTTP | 1 | `1,674/s` | 10000 | `1,687/s` |

API=1 反而比 API=4 快。這不代表單一 API 在 production 中一定優於多 API，而是表示這次 OrbStack Swarm benchmark 中，增加 API replicas 沒有改善入口吞吐。

此時比較合理的推論是：

- go-backend process 數量不是當前限制。
- 多個 backend replica 透過 Swarm service VIP 接收流量，可能引入額外 routing / scheduling 成本。
- 所有 producer 最後仍寫入同一個 single-broker Redpanda，增加 API replica 不會改變 broker 拓樸。

## 第三組對照：在 go-backend 內部觸發 10k produce

為了確認 Go handler、JSON marshal、franz-go producer enqueue 是否為主瓶頸，go-backend 新增 internal benchmark endpoint：

```text
POST /api/internal/benchmarks/seckill-produce
```

這個 endpoint 只接收一個 HTTP request，然後在同一個 go-backend process 內部產生 N 筆 seckill command，呼叫與 full HTTP path 相同的 `publishSeckillCommand` 邏輯，並可選擇等待 Kafka ack。

測試 request：

```json
{
  "requests": 10000,
  "concurrency": 300,
  "skuId": "sku_hot_001",
  "stockLimit": 100,
  "waitForKafkaAck": true,
  "resetTimings": true
}
```

結果：

```text
enqueued             = 10000
deliverySuccess      = 10000
enqueueDurationMs    = 113.593
enqueuePerSecond     = 88,033/s
totalDurationMs      = 201.168
durablePerSecond     = 49,710/s
```

內部 timing：

```text
seckill_publish.payload_marshal p95 = 0.019ms
seckill_publish.produce_call p95    = 0.608ms
seckill_publish.delivery_ack p95    = 143.536ms
```

這個結果很關鍵：在排除外部 10k HTTP request fanout 後，go-backend 內部可以以約 `88k/s` 的速度 enqueue seckill records，並以約 `49.7k/s` 的速度完成 10k Kafka durable ack。這與 direct Kafka franz-go 的 `54.5k/s` 是同一個量級。

因此，以下項目不是這次 full HTTP `1.2k-1.7k/s` 的主要瓶頸：

- JSON marshal。
- seckill payload 建立。
- `publishSeckillCommand` 的 producer enqueue。
- franz-go producer 本身。
- single broker 在 10k burst 下的 durable ack 能力。

## 為什麼 Node full HTTP benchmark 仍然慢

最初的 full HTTP benchmark 慢在「每一筆 buy intent 都要由 Node.js runner 送出一次外部 HTTP request/response」。這與 internal endpoint 的差異如下：

```text
Node full HTTP benchmark:
  10000 external HTTP requests
  -> Swarm service VIP / routing
  -> go-backend request lifecycle
  -> response write
  -> client waits for 202

internal produce benchmark:
  1 external HTTP request
  -> go-backend internal loop produces 10000 Kafka records
  -> optional wait for Kafka ack
  -> 1 response
```

backend timing 顯示 handler 內部不慢，但 client 觀察到的 latency 很高：

```text
API=1 full HTTP:
  backend http_server.buy_intents.total p95 ≈ 1.997ms
  client HTTP accepted p95                  ≈ 287.49ms

API=4 full HTTP:
  client HTTP accepted p95                  ≈ 437.83ms
```

這種差距代表時間主要不在 handler function 內部，而在 handler 外圍的 request scheduling / network / service routing / client closed-loop 回應等待中。

更精確地說，目前可以寫成：

> 在 OrbStack Docker Swarm 的這組測試中，full HTTP seckill throughput 的主要限制不在 Kafka producer、JSON marshal 或 go-backend 的 seckill publish function，而是在外部 HTTP request fanout 到 backend service 之間的路徑。下一步應直接比較 Swarm service VIP、published port、以及單一 backend task IP。

這裡仍保留「在這組測試中」這個前提，因為 production 環境可能使用不同 L4 load balancer、host networking、kernel tuning、TLS、HTTP/2 或多 broker Redpanda。

## 第四組對照：full HTTP 改用 Go load generator

為了確認 Node.js benchmark client 是否混入限制，full HTTP path 也新增 Go load generator。設計與 direct Kafka Go helper 相同：Node benchmark script 只傳入一次小型 config，真正的 hot loop 由 Go binary 執行。

```text
Node benchmark script
  -> spawn Go HTTP load generator once
  -> pass target URLs / requests / concurrency / payload config through stdin
  -> Go load generator sends all HTTP /api/buy-intents requests
  -> Go load generator returns command ids / accepted timestamps once
  -> Node benchmark script continues result collection and artifact generation
```

這個做法沒有改 production go-backend，也沒有跳過 HTTP handler。它只把 benchmark client 從 Node fetch 換成 Go `net/http`，用來測量同一條 full HTTP API path 在較可靠 load generator 下的吞吐。

同樣 10k / concurrency 300 / 12 buckets / maxProbe 1 / single broker：

| client | target | run id | HTTP accepted RPS | Kafka durable accepted | p95 latency |
|---|---|---:|---:|---:|---:|
| Node fetch | Swarm service VIP | `orb_http_vip_c300_10k_20260428T101151Z` | `1,271/s` | 10000 | `378ms` |
| Go HTTP loadgen | Swarm service VIP | `orb_full_http_gohttp_c300_10k_20260428T105411Z` | `11,195/s` | 10000 | `58.61ms` |

這個結果改變了歸因：先前 `1k-2k/s` 的 full HTTP 數字不能直接代表 go-backend 或 Swarm service VIP 的上限。它很大一部分來自 benchmark client 本身。用 Go HTTP load generator 後，同一條 full HTTP API path 可以達到約 `11.2k/s`，並且 Kafka durable accepted 仍為 `10000/10000`。

因此目前的分層結論應改成：

- Kafka / worker pipeline 可達約 `54.5k/s`。
- go-backend internal produce durable ack 約 `49.7k/s`。
- full HTTP + Go HTTP loadgen 約 `11.2k/s`。
- full HTTP + Node fetch benchmark 約 `1.2k-1.7k/s`，這是 benchmark client path 的限制，不應當成 backend 容量。

full HTTP 仍低於 internal produce，這是合理的：每筆 request 仍要經過 HTTP parse、request body decode、response write、connection scheduling、service network path 與 client-side receive loop。新的重點不再是「Go API server 是否只能處理 1k/s」，而是「production 入口層與 load generator 是否能提供足夠並行連線與 request fanout」。

## 已建立的證據鏈

目前 evidence 可整理為：

| 層級 | 測試方式 | 結果 | 推論 |
|---|---|---:|---|
| Kafka / worker pipeline | direct Kafka franz-go | `54.5k/s` durable ack | Kafka path 可遠高於 full HTTP |
| go-backend internal produce | one HTTP trigger, internal 10k produce | `49.7k/s` durable ack | Go producer path 與 direct Kafka 同量級 |
| JSON marshal | internal timing | p95 `0.019ms` | JSON 不是主要瓶頸 |
| producer enqueue | internal timing | p95 `0.608ms` | `Produce()` enqueue 不是主要瓶頸 |
| full HTTP, Go HTTP loadgen | 10k external HTTP requests | `11.2k/s` HTTP accepted | Go backend + HTTP API path 可明顯高於 Node benchmark 數字 |
| full HTTP API=1, Node fetch | 10k external HTTP requests | `1.67k/s` HTTP accepted | Node benchmark client path 有明顯成本 |
| full HTTP API=4, Node fetch | 10k external HTTP requests | `1.28k/s` HTTP accepted | 加 API replica 未改善此環境瓶頸 |

## 下一個實驗

下一步應保持 workload 不變，只改 ingress target：

```text
benchmark runner -> benchmark-go-backend:3000      # Swarm service VIP
benchmark runner -> <single backend task IP>:3000  # single task/container IP
host/client       -> localhost:3300                # published port / routing mesh
```

如果 single backend task IP 明顯高於 service VIP，瓶頸更接近 Swarm VIP / routing mesh / service load balancing。

如果 single backend task IP 仍然只有 `1k-2k/s`，則應繼續檢查 benchmark runner 的 HTTP client、connection reuse、Node fetch implementation、request body construction、以及 backend HTTP server connection scheduling。Go HTTP load generator 已證明 Node fetch path 會顯著低估 full HTTP 能力；後續容量測試應預設使用 Go HTTP load generator 或 k6，而不是 Node fetch。

如果 published port 比 overlay service VIP 更慢，則 routing mesh 成本可以被獨立標記，不應把它混入 go-backend 或 Kafka 的容量判斷。

## 結論

這次定位的重點不是「direct Kafka 比 full HTTP 快」這個表面結果，而是將原因逐層排除：

1. Direct Kafka 改用 Go/franz-go 後，10k durable ack 約 `54.5k/s`。
2. go-backend 內部觸發同一套 seckill publish code，10k durable ack 約 `49.7k/s`。
3. JSON marshal p95 只有 `0.019ms`，`Produce()` enqueue p95 只有 `0.608ms`。
4. full HTTP + Go HTTP loadgen 10k external request 約 `11.2k/s`，Kafka durable accepted `10000/10000`。
5. full HTTP + Node fetch benchmark 只有 `1.2k-1.7k/s`，不能代表 backend 容量。
6. API replicas 從 1 增加到 4 沒有改善 Node benchmark 結果，反而下降。

因此，目前最合理的結論是：full HTTP seckill 的主要限制不是 Kafka producer、JSON encode 或 Go handler 本身。若使用 Node benchmark client，主要限制會落在 benchmark client / HTTP fanout path；若改用 Go HTTP load generator，同一條 full HTTP API path 可以達到約 `11.2k/s`。

這個結論會直接影響後續優化方向。若目標是提高 production full HTTP throughput，下一步不應先重寫 Kafka payload，也不應先調整 JSON encoder；應使用 Go HTTP load generator 或 k6 重新做 API replica、concurrency、Swarm service VIP、single task IP、host-mode publish、外部 L4 load balancer 的矩陣測試。
