# 先讓數字可信：PostgreSQL baseline、artifact schema 與 profiling

Minishop 的架構演進高度依賴 benchmark。這代表 benchmark 本身不能只是「跑起來看一下」。如果 benchmark artifact 不穩定、路徑不清楚、profile 無法回溯到 run，就無法用數字做架構決策。

因此 Minishop 把 benchmark 視為一個獨立平台，而不是臨時 script。

## Baseline 的目的不是追求最高分

PostgreSQL-only checkout baseline 的目的，是建立第一條可信比較線。這條線回答的是：

- 同步 append `CheckoutIntentCreated` 能承受多少吞吐？
- p95/p99 latency 在不同 concurrency 下如何變化？
- 錯誤率是否來自 HTTP、DB、projection 或 benchmark runner？
- 後續加入 queue 或 Kafka 後，是否真的改善了原本瓶頸？

沒有 baseline，任何「Kafka 比較快」、「async 比較好」都只是猜測。

## Artifact schema 是 benchmark 的 API

benchmark runner 會輸出 JSON artifact。後來 dashboard 不再硬編欄位，而是讀 artifact 裡的 `measurements[]` 與 `series[]`。

這個設計有兩個重要效果：

- `measurements[]` 表示單次 run 的 scalar evidence，例如 throughput、p95 latency、errors。
- `series[]` 表示一條曲線，例如 concurrency 到 throughput 的 sweep。

Dashboard 不應知道「checkout 一定有 queued/sec」或「seckill 一定有 result topic throughput」。這些解釋屬於 artifact metadata。Dashboard 的責任是讀取、比較、呈現。

## 場景名稱與 tag 必須分開

benchmark scenario 應回答「測什麼」。run tag 才回答「怎麼測」。

例如 seckill full API 可以是同一個 scenario family，但不同 run 會有不同 tag：

```text
ingress=http
style=steady_state
bucket=4
maxProbe=4
workerReplicas=2
concurrency=100
```

如果每個參數組合都變成一個新的 scenario name，dashboard 很快會失去比較能力。相反地，scenario 穩定、tag 可變，才能支援 sweep、matrix 與歷史比較。

## Profiling 必須連回 benchmark run

早期 repo 中已經有 `.cpuprofile`，但那些檔案比較像 ad hoc 診斷。後來的設計把 profiling 納入 artifact contract：profile payload 不放進 JSON，而是以外部檔案引用方式連到 run。

這個設計避免兩個問題：

- profile 檔案通常很大，不適合嵌入 benchmark summary。
- 如果 profile 不能連回 run id，就很難判斷它對應哪一次 concurrency、哪個 commit、哪個 scenario。

Go backend 也加入 pprof hook。實際檢查 seckill full API 時，`Produce()` call latency 一開始被誤讀為 Kafka produce 完成時間；後來改成在 franz-go callback 內量 `delivery_ack`，才區分出 enqueue cost 與 broker ack latency。

這個例子說明 benchmark instrumentation 的精度會直接影響架構判讀。

## Swarm benchmark stack 的角色

後來 benchmark 不再只是單機 compose baseline，而是被擴展成 Docker Swarm stack：

```text
db      -> benchmark-postgres
msg     -> benchmark-nats, benchmark-redpanda
api     -> benchmark-go-backend
worker  -> worker-seckill, result sink, projection workers
bench   -> benchmark-runner
obs     -> prometheus
```

`benchmark-runner` 改成常駐 container，artifact 寫到 `/tmp/benchmark-results`，並掛在 named volume 中。跑完後使用 `docker cp` 拉回本地，而不是用 local bind mount。這讓 stack 更接近多機部署，也避免 artifact 路徑依賴本機檔案系統。

Justfile 成為 benchmark console。`just --list` 可以直接看到可執行操作，例如：

- `stack-deploy`
- `stack-wait`
- `checkout-reset`
- `nats-bypass`
- `seckill-full-api`
- `seckill-direct-kafka`
- `artifact-pull`

這不是便利性而已。benchmark 若要長期使用，入口必須穩定且可被他人重跑。

## 數字可信之後，才談優化

這個 repo 的幾個重要修正都來自 benchmark 證據：

- full API path 慢時，不能直接假設 Kafka producer 是瓶頸。
- async `Produce()` return 只代表 enqueue，不代表 broker ack。
- callback ack latency 必須另行量測。
- pprof 顯示 HTTP path、middleware、syscall、JSON 與 response write 也可能是成本來源。
- direct Kafka path 與 full API path 的比較能分離「broker/worker 極限」與「HTTP ingress 極限」。

benchmark 的價值不在於一次數字，而在於讓每個架構假設都有證據可以反駁。
