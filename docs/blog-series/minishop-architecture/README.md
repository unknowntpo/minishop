# Minishop 架構設計文章系列

這個目錄整理 Minishop repo 目前累積在 Spectra 規格、benchmark 實作與 seckill 壓測中的設計決策。文章目標不是重述所有程式碼，而是把「為什麼這樣設計」、「遇到什麼問題」、「最後如何修正」整理成可連載的中文技術文章。

## 基準版本

- Branch: `main`
- Commit: `ce9d291796ff22c4496ca14ccb934bc962cf836c`
- 用途：本文系列的技術描述、檔案引用與 benchmark 架構，皆以此 commit 的 repo 狀態為基準。

## 文章列表

1. [從同步扣庫存到事件源流：Minishop 的第一個架構邊界](./01-event-sourced-checkout.md)
2. [先讓數字可信：PostgreSQL baseline、artifact schema 與 profiling](./02-benchmark-evidence.md)
3. [Queue-first checkout：CommandAccepted 與 CheckoutIntentCreated 為什麼要分開](./03-queue-first-checkout.md)
4. [Seckill 壓測路徑：為什麼 full API 與 direct Kafka 都要存在](./04-seckill-swarm-benchmark.md)
5. [動態擴展 bucket 與 partition：Redis slot 類比的限制](./05-dynamic-bucket-partition-scaling.md)
6. [Full HTTP seckill 瓶頸定位：不是 JSON，也不是 Go producer](./06-full-http-seckill-bottleneck.md)

## 主要資料來源

- `openspec/specs/event-sourced-buy-flow/spec.md`
- `openspec/specs/checkout-postgres-baseline/spec.md`
- `openspec/changes/archive/2026-04-19-add-event-sourced-buy-flow/design.md`
- `openspec/changes/archive/2026-04-20-add-benchmark-profiling-artifacts/design.md`
- `openspec/changes/design-checkout-scaling-architecture/design.md`
- `openspec/changes/design-seckill-dynamic-scaling/design.md`
- `docker-compose.benchmark.yml`
- `Justfile`
- `scripts/swarm-benchmark.sh`
- `scripts/benchmark-buy-intent-temporal.ts`
- `services/go-backend/main.go`

## 寫作原則

- 保留工程限制，不把 benchmark 結果寫成 production 承諾。
- 區分「已實作」、「已驗證」、「設計中」與「未來工作」。
- 將每個架構選擇連回它解決的具體問題。
- benchmark 數字只作為該環境下的證據，不泛化為絕對效能。
