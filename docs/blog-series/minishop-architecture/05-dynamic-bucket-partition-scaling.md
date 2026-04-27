# 動態擴展 bucket 與 partition：Redis slot 類比的限制

Seckill scaling 最容易出現的一個直覺，是把 bucket 設計成類似 Redis Cluster slot：先切很多 virtual bucket，再把 bucket 分配到不同節點。如果需要擴容，就把部分 bucket 搬到新節點。

這個類比有幫助，但不能直接套用。

Minishop 的 seckill path 同時有三個不同概念：

- seckill bucket：hot SKU 的業務級庫存 shard。
- Kafka partition：log ordering 與 processing parallelism boundary。
- Kafka Streams task：consumer group generation 中實際擁有 partition 的處理單位。

把三者混成同一個「slot」會讓 scaling 設計變得危險。

## Partition 是第一個 processing ceiling

Kafka Streams active task 數量受 input topic partition count 限制。worker replicas 增加到超過 partition count 後，額外 replica 會閒置。

例如：

```text
request topic partitions = 8
worker replicas = 1   -> 1 個 process 擁有 8 個 task
worker replicas = 4   -> 每個 process 約 2 個 task
worker replicas = 8   -> 每個 process 約 1 個 task
worker replicas = 12  -> 4 個 replica 對這個 topic 沒 active task
```

因此第一版安全 scaling 應該是：

1. 預先建立足夠 partition。
2. 動態增加 worker replicas。
3. 等 Kafka consumer group stable。
4. 再開始 benchmark 或 production traffic。

這就是目前 `just seckill-worker-scale <replicas>` 的設計方向。

## 為什麼不先做 bucket migration

Redis-like bucket migration 需要完整 handoff protocol：

- source/destination ownership state
- in-flight message draining
- old/new owner 去重
- rollback
- bucket-level metrics
- migration status visibility

如果第一版就做這件事，複雜度會超過目前 benchmark 能驗證的範圍。更好的順序是先用足夠 partition 與 worker replicas 找到 processing ceiling，再決定是否需要真的遷移 bucket。

## Dynamic partition increase 不是免費線上擴容

Kafka 允許增加 topic partitions，但這不代表可以在 hot sale 中隨意調整。

風險包括：

- default partitioner 可能讓 key-to-partition mapping 改變。
- Kafka Streams consumer group 會 rebalance。
- state store 可能移動並 restore。
- benchmark measurement window 會混入 rebalance latency。
- 舊 message 與新 routing 規則可能難以對齊。

因此第一版應把 partition increase 視為 controlled drain-and-roll operation：

```text
停止新流量或切換新的 isolated run id
  -> 等 request topic lag drain
  -> 停 worker/result-sink 或切 fresh group id
  -> 增加或重建 request/result/DLQ topics
  -> 用一致 config 重啟 workers
  -> readiness checks
  -> 開始新 benchmark
```

這不是最華麗的 autoscaling，但它可驗證、可回滾，也不會讓 benchmark 數字失去解釋能力。

## Bucket count 需要 routing epoch

增加 bucket count 不是純粹 capacity 操作。它會改變 hot SKU 的 business key space。

安全設計需要 routing metadata，例如：

```json
{
  "sku_id": "sku_hot_001",
  "routing_epoch": 3,
  "bucket_count": 128,
  "partition_count": 128,
  "max_probe": 4,
  "effective_from": "2026-04-24T00:00:00Z"
}
```

每個 request 應帶上 `routing_epoch`。Worker 依照 message 所屬 epoch 解讀 bucket 與 fallback 規則。這讓新舊 epoch 可以在 transition 期間共存。

沒有 routing epoch 時，bucket-count change 可能導致：

- 舊 message 被新 bucket 規則解讀。
- fallback path 混雜。
- capacity accounting 重複或遺漏。
- benchmark artifact 難以解釋。

## Rebalance protocol 只能降低衝擊，不能消除成本

Kafka 的 cooperative 或 async rebalance 可以減少 stop-the-world，但不代表 state movement 免費。

rebalance 期間仍可能出現：

- task 暫停
- state restore
- cache 失效
- topic lag 變化
- latency spike

因此 benchmark dashboard 應該把含 rebalance 的 run 標示成獨立 scenario 或 tag，不能直接與 steady-state run 比較。

## 第一版 scaling roadmap

比較務實的 rollout 是：

```text
Phase 1: 固定較高 partition ceiling，例如 32 或 64
Phase 2: 支援 worker replica scaling command
Phase 3: 跑 partitions x replicas x ingress matrix
Phase 4: 設計 routing epoch 與 bucket-count transition
Phase 5: 只有在證據需要時，再做 bucket migration
```

矩陣應包含：

```text
partitions: 4, 8, 16, 32, 64
worker replicas: 1, 2, 4, 8
ingress: full-api, direct-kafka
style: burst, steady-state
```

目標不是一次找出完美值，而是拆清楚瓶頸落在哪裡：HTTP ingress、Kafka broker、partition/task count、Kafka Streams worker、result sink 或 DB。

## 最小可觀測指標

在討論 autoscaling 前，至少要能觀測：

- request topic produce rate
- request topic lag by partition
- result topic produce rate
- result topic lag by partition
- worker assigned task count
- worker rebalance count/duration
- per-bucket primary request count
- per-bucket retry count
- retry per primary
- result per primary
- result sink DB write latency
- go-backend HTTP p95/p99
- Kafka delivery ack p95/p99

沒有這些指標，autoscaling 只會把系統變成更難診斷的黑箱。

## 結論

partition 比較像 processing parallelism ceiling；bucket 比較像 hot SKU 的 business shard。兩者可以在第一版設成相同數字以降低認知成本，但設計上不應混為一談。

Minishop 的第一版策略是：先預留足夠 partition，動態 scale worker replicas；partition/bucket 數量變更用 drain-and-roll 與 routing epoch 管理。這比 Redis-like bucket migration 保守，但更適合目前仍在建立 benchmark 證據鏈的階段。
