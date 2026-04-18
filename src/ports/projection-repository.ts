import type { StoredEvent } from "@/src/ports/event-store";

export type ProjectionBatchResult = {
  locked: boolean;
  processedEvents: number;
  lastEventId: number;
};

export type ProjectionRepository = {
  processBatchWithLock(input: {
    projectionName: string;
    batchSize: number;
  }): Promise<ProjectionBatchResult>;
};
