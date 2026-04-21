import type { SeckillBuyIntentRequest } from "@/src/domain/seckill/seckill-buy-intent-request";

import type { SeckillPendingMessage } from "@/src/infrastructure/seckill/kafka-seckill-producer";

type SeckillPublishBatcherOptions = {
  batchSize: number;
  lingerMs: number;
  flush: (entries: SeckillPendingMessage[]) => Promise<void>;
};

export class SeckillPublishBatcher {
  private pendingBatch: SeckillPendingMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<void> | null = null;

  constructor(private readonly options: SeckillPublishBatcherOptions) {}

  publish(request: SeckillBuyIntentRequest, headers: Record<string, Buffer>) {
    return new Promise<void>((resolve, reject) => {
      this.pendingBatch.push({
        request,
        headers,
        resolve,
        reject,
      });

      if (this.pendingBatch.length >= this.options.batchSize) {
        this.clearFlushTimer();
        void this.flushPendingBatch();
        return;
      }

      this.scheduleFlush();
    });
  }

  private scheduleFlush() {
    if (this.flushTimer || this.pendingBatch.length === 0) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingBatch();
    }, Math.max(1, this.options.lingerMs));
  }

  private clearFlushTimer() {
    if (!this.flushTimer) {
      return;
    }

    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private flushPendingBatch() {
    if (this.activeFlush || this.pendingBatch.length === 0) {
      return this.activeFlush ?? Promise.resolve();
    }

    this.clearFlushTimer();
    const entries = this.pendingBatch;
    this.pendingBatch = [];
    this.activeFlush = this.startFlush(entries);
    return this.activeFlush;
  }

  private startFlush(entries: SeckillPendingMessage[]) {
    return (async () => {
      try {
        await this.options.flush(entries);
        for (const entry of entries) {
          entry.resolve();
        }
      } catch (error) {
        for (const entry of entries) {
          entry.reject(error);
        }
      } finally {
        this.activeFlush = null;

        if (this.pendingBatch.length > 0) {
          this.clearFlushTimer();
          if (this.pendingBatch.length >= this.options.batchSize) {
            void this.flushPendingBatch();
          } else {
            this.scheduleFlush();
          }
        }
      }
    })();
  }
}
