# 從同步扣庫存到事件源流：Minishop 的第一個架構邊界

Minishop 一開始不是完整電商平台，而是一個高併發購買流程實驗。核心場景很小：大量使用者在短時間內對同一個 SKU 按下購買。這個限制反而讓架構問題更清楚：系統是否應該在按下 Buy 的 HTTP request path 內同步鎖定庫存？

Minishop 的第一個答案是：不要。

使用者按下 Buy 或送出 cart checkout 時，系統先建立 durable checkout intent。庫存保留、付款、訂單成立與失敗補償都放到後續事件處理流程。這個決策把「接受購買意圖」與「完成庫存決策」分開，避免所有買家在同一個 SKU 上等待同一把同步鎖。

## PostgreSQL 是第一版的事實邊界

第一版選擇 PostgreSQL event store 作為 durable source of truth。`CheckoutIntentCreated` 只有在事件成功寫入 PostgreSQL 後才成立。Kafka、Redis 或 Temporal 都不能在這個階段取代 event store 的事實邊界。

這個選擇有幾個目的：

- 先把 correctness 邊界固定下來，再討論吞吐量。
- 讓事件可以用 PostgreSQL transaction、unique constraint 與 idempotency key 保護。
- 讓 projection、admin verification 與 benchmark 都有同一個可檢查的 durable boundary。
- 避免第一版同時處理 Kafka replay、exactly-once、outbox relay 與 inventory consistency。

這不是否定 Kafka。相反地，Kafka 被刻意延後，因為必須先知道 PostgreSQL-only baseline 的極限在哪裡。

## Checkout intent 不是 inventory reservation

`CheckoutIntentCreated` 屬於 `checkout` aggregate。它表示系統收到購買意圖，但不表示 SKU 庫存已被扣減或保留。

SKU inventory 是另一個 consistency boundary。庫存事件使用 `aggregate_type = sku` 與 `aggregate_id = sku_id`。Product 只保留 catalog/display 的角色，不承擔庫存一致性。

這個切分避免了一個常見錯誤：把商品頁上的 product 當作庫存鎖定單位。實際可購買單位是 SKU；同一個 product 底下的不同 SKU 不應互相阻塞。

## Read model 與事件事實分離

客戶端讀取 projection table，而不是每次 replay event store。第一版重要 read model 包含：

- `sku_inventory_projection`
- `checkout_intent_projection`
- `order_projection`

這些 projection 是可重建的讀模型。event store 才是事實。這讓 UI 可以用 polling 取得狀態，而不是把 SSE 或 WebSocket 當成 correctness 的必要條件。

## 為什麼不是同步庫存鎖

同步庫存鎖的直覺很直接：買家送出 request，系統鎖住 SKU，扣庫存，回傳成功或失敗。問題在於高併發 hot SKU 下，這會把 HTTP latency 直接綁到鎖等待、DB transaction 與庫存決策。

Minishop 的實驗目標不是讓每個 request 在 request path 裡完成所有事情，而是讓系統可以承接 burst，並在後續 pipeline 中以可觀測、可重試、可補償的方式處理。

因此第一版的主要架構邊界是：

```text
HTTP request
  -> append CheckoutIntentCreated
  -> projection/polling
  -> later inventory/payment/order processing
```

這個邊界讓系統先具備可驗證的 durable fact，再逐步加入 queue、worker、Kafka 與 seckill fast path。

## 實作上的制約

這個選擇也帶來明確限制：

- PostgreSQL append throughput 會成為第一個瓶頸。
- projection worker 一開始可以在 Next.js 內部 route 或 scheduled handler 執行，但長期應抽到獨立 worker。
- polling 會增加 read traffic，因此 projection table 必須便宜可讀。
- payment provider callback 可能重複或延遲，因此後續流程必須 idempotent。

這些限制不是附帶細節，而是架構設計的一部分。Minishop 的策略是先讓事實邊界簡單、可測，再用 benchmark 證據決定下一個瓶頸在哪裡。
