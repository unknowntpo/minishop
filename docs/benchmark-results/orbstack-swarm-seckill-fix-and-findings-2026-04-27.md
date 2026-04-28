# OrbStack Docker Swarm 秒殺 full HTTP 修正與發現 - 2026-04-27

## 結論

這次修正的最大價值不是直接把 full HTTP seckill 推到很高的 rps，而是先把壓測工具修到可以可信地回答問題。

本機 OrbStack Docker Swarm 復測後，最有影響的發現是：

- 固定 200 in-flight 的 closed-loop runner 會限制觀察 API scale-out 的能力。
- 之前部分壓測參數沒有真正傳進 Swarm runner 和服務模板，導致 concurrency、bucket count、partition count 的 sweep 可能沒有照預期生效。
- 目前 HEAD 的 Go backend 已經不是每個 HTTP request 都同步 `ProduceSync`；它使用 async `Produce`。因此「同步 Kafka produce 是 HTTP handler 的直接瓶頸」這個診斷不適用於目前版本。
- 把秒殺 bucket / Kafka request topic partition 從 4 提高到 12，在本機復測中有可觀改善。
- 只增加 Go API replicas，吞吐量沒有線性提升；在本機單 Redpanda / Swarm routing mesh / worker / result sink 共享下游路徑下，吞吐量約停在 2k rps 左右，延遲會先上升。
- 過多 Kafka Streams application id 會留下 changelog topics，長時間反覆壓測會污染後續結果；這次已把舊 changelog topic 清理納入 benchmark helper。

## 修正內容

### 1. 讓 Swarm runner 接到真實壓測參數

修正 `scripts/swarm-benchmark.sh`，把 host 端設定的 benchmark env 傳進 Swarm runner container，例如：

- `BENCHMARK_REQUESTS`
- `BENCHMARK_HTTP_CONCURRENCY`
- `BENCHMARK_STYLE`
- `BENCHMARK_SECKILL_BUCKET_COUNT`
- `BENCHMARK_CREATED_TIMEOUT_MS`
- `KAFKA_SECKILL_CLIENT_REQUIRED_ACKS`

這個修正很重要。否則本機或遠端執行時，即使命令列看起來在跑 400、800 concurrency，runner 也可能仍然使用預設值，導致 scale-out 結論不可信。

### 2. 讓 bucket / partition sweep 真正套用到服務

修正 `scripts/swarm-benchmark.sh` 的秒殺準備流程：

- 更新 `go-backend` 的 `SECKILL_BUCKET_COUNT`
- 更新 `worker-seckill` 的 `KAFKA_SECKILL_REQUEST_TOPIC_PARTITIONS`
- 更新 `go-seckill-result-sink` 的 result / DLQ partition 設定
- 重建 request / result / DLQ topics
- 重啟相關服務，避免服務模板和 topic 實際狀態不一致

同時修正 `workers/kafka-seckill/src/main/kotlin/dev/minishop/seckill/Main.kt`，讓 worker 建 topic 時使用 env 裡的 partition 設定，而不是硬編碼的 `6`。

### 3. 加入 Kafka Streams changelog topic 清理

反覆壓測時，benchmark helper 會產生新的 Kafka Streams application id。這會留下類似以下 topic：

- `minishop-seckill-worker-benchmark-...-dedupe-store-changelog`
- `minishop-seckill-worker-benchmark-...-inventory-store-changelog`

這些 topic 在本機單 Redpanda 環境累積後，會讓後續 worker 啟動或 internal topic 建立失敗，進而造成「HTTP 全部 accepted，但 result sink 沒有結果」的假象。

這次已在 `scripts/swarm-benchmark.sh` 加入清理舊 changelog topics 的流程，讓每輪壓測更接近乾淨狀態。

### 4. 讓 Go backend 的 Kafka ack 模式可設定

修正 `services/go-backend/main.go`，加入：

```text
KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all|leader|none
```

對應 franz-go：

- `all` -> `kgo.AllISRAcks()`
- `leader` -> `kgo.LeaderAck()`
- `none` -> `kgo.NoAck()`

目前 smoke test 使用 `all` 已通過。`leader` 需要在清理 changelog topics 後重新正式測，之前那輪因 worker internal topic 失敗，不能拿來當作 ack mode 結論。

## 本機 OrbStack 復測結果

以下結果是在本機 OrbStack Docker Swarm 上測得，用來找瓶頸方向，不等同於 GCP 結論。

| 情境 | request / concurrency | bucket / partition | API replicas | ack | accepted rps | p95 | 備註 |
|---|---:|---:|---:|---|---:|---:|---|
| baseline | 10000 / 100 | 4 | 1 | all | 1511.91 | 未記錄 | 修正 env propagation 後 |
| 提高 concurrency | 10000 / 200 | 4 | 1 | all | 1536.95 | 未記錄 | 比 c100 只小幅增加 |
| 更高 concurrency | 10000 / 400 | 4 | 1 | all | 1833.88 | 404.67 ms | worker retry amplification 明顯 |
| 提高 partition | 10000 / 400 | 12 | 1 | all | 1961.22 | 383.41 ms | retry amplification 降到 0，結果完整 |
| API scale-out | 10000 / 400 | 12 | 4 | all | 2013.95 | 417.74 ms | 只比 1 replica 小幅增加 |
| 更高 offered load | 10000 / 800 | 12 | 4 | all | 2057.77 | 672.83 ms | throughput 幾乎到平台上限，延遲上升 |

最後清理流程修正後，另跑了一次 smoke：

| 情境 | request / concurrency | bucket / partition | API replicas | ack | accepted rps | result rps | p95 | pass |
|---|---:|---:|---:|---|---:|---:|---:|---|
| cleanup smoke | 2000 / 200 | 12 | 目前 stack 設定 | all | 1474.72 | 1491.3 | 259.27 ms | true |

## Finding

### 1. 固定 200 in-flight 會讓 API scale-out 看不出來

這點成立。`scripts/benchmark-checkout-postgres.ts` 使用 closed-loop concurrency：同一時間最多只有 `BENCHMARK_HTTP_CONCURRENCY` 個 request in-flight。

如果固定 200 concurrency：

- 1 個 API replica 約吃 200 in-flight
- 4 個 API replicas 約平均每個只吃 50 in-flight

這種情境下，replica 數增加不代表 offered load 增加，所以看不到 scale-out 是合理的。要測 API replica scale-out，concurrency 必須跟著 replica 數提高，例如 1 replica 跑 200，4 replicas 至少跑 800。

但本機復測也顯示，即使把 concurrency 提到 400 / 800，throughput 沒有線性上升，代表後面還有共享瓶頸。

### 2. 目前 HEAD 不是 `ProduceSync` 每請求同步阻塞

先前診斷提到 `ProduceSync + AllISRAcks` 是 HTTP handler 的主瓶頸。這對目前 HEAD 不成立。

目前 `services/go-backend/main.go` 使用 async `a.kafka.Produce(...)`。HTTP handler 仍會經過 request parsing、秒殺設定讀取、bucket 計算、trace injection、producer buffer/backpressure 等成本，但不是每個 request 都同步等待 Kafka ack 才回 HTTP。

因此後續分析要避免把舊版本的 `ProduceSync` 結論直接套到現在的 code。

`AllISRAcks` 仍然可能影響 producer drain、broker 壓力與尾延遲，但它不是目前 full HTTP handler 的單一同步等待點。

### 3. 12 partitions / buckets 是目前最明確的正向改善

在本機同樣 1 API replica、400 concurrency 下：

- 4 partitions / buckets：約 1833.88 rps，p95 約 404.67 ms
- 12 partitions / buckets：約 1961.22 rps，p95 約 383.41 ms

改善幅度不是數倍，但方向明確，而且 12 partitions 那輪的 worker retry amplification 明顯降低。

這表示 4 bucket / partition 對 full HTTP seckill 偏少。後續正式測試應至少用 12 作為 baseline，再依 broker / worker 數量調整。

### 4. 只加 API replicas 不是主要解法

在 12 partitions / buckets 下：

- 1 API replica，400 concurrency：約 1961.22 rps
- 4 API replicas，400 concurrency：約 2013.95 rps
- 4 API replicas，800 concurrency：約 2057.77 rps，但 p95 升到約 672.83 ms

這表示本機環境中，API replica 不是主要瓶頸。更可能的上限在共享路徑：

- 單 Redpanda broker
- Swarm routing mesh
- Kafka Streams worker
- result sink
- topic / changelog topic 狀態
- 本機 OrbStack 資源限制

如果目標是讓 full HTTP seckill 吃更多 request，下一步不應只增加 API replicas，而應該同步擴 broker、partition、worker 和 result path。

### 5. 32 partitions 在本機單 Redpanda 失敗，不應當成應用邏輯失敗

32 bucket / partition 的本機測試出現「HTTP 全 accepted，但沒有 result」。

worker log 顯示 Kafka Streams 建 internal changelog topic 時失敗：

```text
InvalidPartitionsException: Can not increase partition count due to memory limit
```

這比較像是本機單 Redpanda / OrbStack 資源限制，加上舊 changelog topics 累積造成的 internal topic 建立問題，不應解讀成 full HTTP path 的業務邏輯錯誤。

這也驗證了 benchmark helper 必須清理 Kafka Streams internal topics，否則後面的結果會被前面的測試污染。

## 對 GCP 結論的修正

原本 GCP 文件觀察到 1 / 2 / 4 API replicas 沒有 scale。這個現象仍然值得保留，但原因要更精確：

- 固定 200 concurrency 確實讓 API scale-out 測試先天不足。
- 目前 HEAD 不應再用 `ProduceSync` 作為主因解釋。
- 單 Redpanda / partition 數 / worker / result sink / Swarm routing mesh 才是下一輪要拆開驗證的共享瓶頸。

也就是說，GCP 那輪可以說「增加 API replicas 沒有改善 full HTTP throughput」，但不應直接說「因為 HTTP handler 每請求同步 `ProduceSync` 等待 Kafka ack」。

## 建議下一步

1. 用修正後的 benchmark helper 重跑 GCP。
2. API scale-out 測試必須讓 concurrency 跟 replicas 成比例上升，例如：
   - API=1，concurrency=200
   - API=2，concurrency=400
   - API=4，concurrency=800
3. partition / bucket baseline 改成 12，不要再用 4 當主測試值。
4. 分別測 `KAFKA_SECKILL_CLIENT_REQUIRED_ACKS=all` 和 `leader`，但要先確認 worker changelog topic 清理成功。
5. 若 4 API replicas 仍停在約同一吞吐量，下一輪要拆：
   - 單 broker vs 多 broker Redpanda
   - Swarm routing mesh vs host-mode publish / external L4 LB
   - worker replicas / stream threads
   - result sink parallelism
6. 每輪保留 worker log、topic list、service env snapshot，避免把「服務模板沒更新」或「舊 topic 污染」誤判成系統瓶頸。

## 實務結論

目前最可靠的改善路線是：

1. 先固定使用修正後的 benchmark helper。
2. 把 bucket / partition 數提高到 12。
3. 用隨 replica 數成比例增加的 concurrency 重測 API scale-out。
4. 若吞吐量仍卡住，優先擴 Redpanda / worker / result path，而不是只加 API replicas。

這次本機測試已經證明：full HTTP seckill 的上限不是單純靠 Go API replica 數就能推上去。要讓它處理更多 request，壓測本身、partition 設定、broker 能力、worker 消費能力和 result sink 都必須一起納入同一個端到端容量模型。
