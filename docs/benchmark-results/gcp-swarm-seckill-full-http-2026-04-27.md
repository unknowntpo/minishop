# GCP Docker Swarm 秒殺壓測紀錄 - 2026-04-27

## 可追蹤資訊

- Minishop 分支：`feat/swarm-benchmark-mainbase`
- Minishop 受測 commit：`9f9a7edf33684a7c4e8080a5b5d72a9b599dea40`
- Infra 分支：`codex/gcp-swarm-ce`
- Infra 執行時 commit：`e210e2a2527ee0f71ecef85b0a3236d06f10d2dd`
- Infra stack commit：`9948d3b` (`Add GCP benchmark swarm stack`)
- GCP 專案：已在原始執行紀錄中保存；提交版不記錄實際 project ID
- 區域 / zone：`us-central1` / `us-central1-a`
- Artifact Registry：提交版不記錄完整 registry path；執行時使用短期 benchmark repo `swarm-bench`
- 原始 artifact：`benchmark-results/gcp-swarm-20260427/minishop-benchmark-results`

## 叢集配置

- Swarm manager：`swarm-bench-dev-mgr-01`，`e2-small`，`Drain`
- Worker：
  - `swarm-bench-dev-worker-01`，`e2-standard-2`，8GB
  - `swarm-bench-dev-worker-02`，`e2-standard-2`，8GB
  - `swarm-bench-dev-worker-03`，`e2-standard-2`，8GB
- 部署方式是 Docker Swarm，不是 GKE。
- 自製 image 先 push 到 Artifact Registry，再由 VM pull。

## 執行方式說明

這次 GCP 遠端壓測沒有直接用本地 Justfile 執行。原因是目前 `just` / `scripts/swarm-benchmark.sh` 假設執行 Docker CLI 的 node 可以用 `docker ps` 看見 runner、Postgres、Redpanda container。

但這次 GCP 拓撲刻意讓 manager 維持 `Drain`，所有 benchmark containers 都跑在 workers。因此實際執行方式是在 `worker-03` 的 runner container 內直接執行相同 benchmark command。

後續應該把這段正式封裝成 GCP remote Swarm runner helper，讓未來可以透過 `just` 啟動遠端壓測，避免手動 SSH 命令漂移。

## 壓測結果

### 基準情境

| 情境 | 請求數 | 錯誤數 | 吞吐量 | p95 延遲 |
|---|---:|---:|---:|---:|
| checkout Postgres baseline | 1000 | 0 | 564.25 rps | 1300 ms |
| direct Kafka seckill | 10000 | 0 | 23428.21 rps | 28.9 ms |
| full HTTP seckill，API=1，1k | 1000 | 0 | 695.8 rps | 243.75 ms |
| NATS checkout flow | 1000 | 0 | 691.49 rps | 250.84 ms |

### Full HTTP seckill API scale 測試

以下三組都使用 10000 requests、HTTP concurrency 200。

| Go API / ingress replicas | 請求數 | 錯誤數 | 吞吐量 | p95 延遲 |
|---:|---:|---:|---:|---:|
| 1 | 10000 | 0 | 1182.49 rps | 289.7 ms |
| 2 | 10000 | 0 | 1142.3 rps | 307.35 ms |
| 4 | 10000 | 0 | 1035.72 rps | 282.56 ms |

## 分析

這次 10k full HTTP seckill 結果沒有顯示增加 Go API / ingress replicas 能改善吞吐量。scale 1 反而略高於 scale 2 和 scale 4。這個差距不適合解讀成精準排名，但足以說明：在目前 3 台 `e2-standard-2` worker 的 Swarm 拓撲下，HTTP API replica 數不是主要瓶頸。

更可能的瓶頸在下游或平台層：Swarm routing mesh、Redpanda、seckill worker / result sink、每輪重建 Kafka topics 的殘留狀態，或小型 worker 上的資源競爭。

Direct Kafka seckill 的 rps 很高，但不能直接拿來和 full HTTP seckill 當同一種端到端吞吐比較。Direct Kafka 的 `ingress_throughput` 是 runner 直接 publish 到 Kafka request topic 的速度；full HTTP 的 `ingress_throughput` 是 HTTP request 進入 Go API / ingress service，經過 HTTP server、Swarm service routing、request parsing、application checks、可能的 config/cache/database work，再 publish 到 Kafka 的速度。

也就是說，兩者的 metric label 類似，但 measurement boundary 不同。Direct Kafka 更像是 Kafka producer path 的上限探測；full HTTP 才是使用者請求走完整 HTTP 入口的路徑。

## 後續建議

- 把 GCP remote Swarm runner 正式包進 Justfile。
- 補 20k 或 30 分鐘 steady-state 測試，降低短跑抖動。
- 若要精準測 API scale-out，加入 placement preferences 或 explicit spread constraints，避免 replicas 分布不穩。
- 若要確認 Swarm routing mesh 是否是瓶頸，下一輪比較 direct-to-ingress / host networking / routing mesh 三種入口。
