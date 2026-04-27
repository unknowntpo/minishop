# Queue-first checkout：CommandAccepted 與 CheckoutIntentCreated 為什麼要分開

基準版本：`main` at `ce9d291796ff22c4496ca14ccb934bc962cf836c`

PostgreSQL event store baseline 讓 Minishop 有了清楚的 durable fact boundary，但也暴露出下一個問題：如果每個 HTTP request 都要同步建立 `CheckoutIntentCreated`，client latency 與 burst handling 會被 PostgreSQL append capacity 直接制約。

Queue-first checkout 的目標不是把 PostgreSQL 移除，而是把 request path 與 durable fact creation 解耦。

## 兩種 lifecycle

這個設計最重要的概念是區分兩種 lifecycle：

- command lifecycle
- domain event lifecycle

`CommandAccepted` 只表示系統接受了處理責任。它不是 checkout 事實。

`CheckoutIntentCreated` 只有在事件成功寫入 PostgreSQL `event_store` 後才成立。它才是 durable business fact。

這個差異會反映在 API contract 上。Ingress API 可以快速回傳：

```json
{
  "command_id": "cmd_...",
  "correlation_id": "corr_...",
  "status": "accepted"
}
```

Client 接著透過 polling 查 `command_status`，直到狀態變成 `created`、`duplicate` 或 `failed`。

## 為什麼 completion 不走 broker reply

Queue-first 設計使用 NATS JetStream 作為 command bus，但不依賴 broker request-reply 來回傳完成結果。

原因是 completion 是 client-visible contract，應該由 durable status store 提供。Broker reply channel 容易受到 connection、consumer lifecycle 與 client retry 影響。`command_status` 則能跨 process restart、deploy 與 client reconnect 保留狀態。

因此 command bus 是單向 buffering layer：

```text
API -> command_status accepted -> NATS JetStream -> worker -> staging/merge -> event_store -> command_status created/failed
```

## NATS 與 Temporal 的分工

這個設計保留 Temporal，但不把 Temporal 當 queue，也不讓它成為 durable business fact。

分工是：

- NATS JetStream：command buffering、ack/retry、consumer concurrency。
- PostgreSQL：`CheckoutIntentCreated` 等 business facts 的 durable truth。
- Temporal：workflow lifecycle、timeout、retry coordination、未來 compensation。
- OpenTelemetry：觀測 request/command path，但不負責 orchestration。

這裡容易混淆的是 Temporal 與 tracing。Tracing 能說明某次 request 經過哪些 service、在哪裡耗時、哪個 span 失敗。Temporal 則負責 workflow state、timer、signal、retry 與 process restart 後的恢復。兩者解決不同問題。

## 為什麼不是直接 COPY 進 event_store

Worker 可以使用 PostgreSQL `COPY` 提升吞吐，但 COPY 的目標不應是最終 `event_store`。設計上應先寫 staging table，再由 merge worker 負責最終 append。

原因是 staging phase 可以隔離：

- malformed command payload
- duplicate command
- replayed idempotency key
- retryable merge failure
- per-command result accounting

Final merge phase 才執行 domain validation、dedupe、append event store、更新 command status。這避免 command consumer throughput 直接污染 event store 的一致性邊界。

## At-least-once 加 idempotency，而不是追求 transport exactly-once

第一版不要求 broker 層端到端 exactly-once。實務上更重要的是 effectively-once business outcome。

這依賴：

- NATS JetStream at-least-once delivery
- `command_id` 去重
- `idempotency_key` 去重
- event identity 或 unique constraint 保護
- merge worker idempotent processing

這種設計承認 transport 可能重送，但保證 business fact 不重複成立。

## 何時可以拿掉 Temporal

Spectra 設計也保留了移除 Temporal 的判準。如果 checkout pipeline 長期維持單階段 queue consume + deterministic merge write，而且沒有 timer、signal、跨服務 compensation 或長流程 visibility，plain workers 會更簡單。

因此 Temporal 不是不可逆的基礎設施。它被保留，是因為 checkout lifecycle 預期會走向 inventory reservation、payment coordination、expiration、compensation，而不是因為目前 queue-first ingestion 必須依賴 Temporal 才能成立。

這個取捨讓架構保持兩件事：

- 現在的 ingestion path 不被過度 workflow 化。
- 未來需要長流程 orchestration 時，邊界已經清楚。
