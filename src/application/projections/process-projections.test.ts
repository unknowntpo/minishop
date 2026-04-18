import { describe, expect, it } from "vitest";

import { processProjections } from "@/src/application/projections/process-projections";
import type {
  ProjectionBatchResult,
  ProjectionRepository,
} from "@/src/ports/projection-repository";

describe("processProjections", () => {
  it("processes a bounded batch through the projection repository", async () => {
    const repository = new FakeProjectionRepository({
      locked: true,
      processedEvents: 2,
      lastEventId: 42,
    });

    const result = await processProjections(
      {
        projectionName: "main",
        batchSize: 2,
      },
      {
        projectionRepository: repository,
      },
    );

    expect(result).toEqual({
      locked: true,
      processedEvents: 2,
      lastEventId: 42,
    });
    expect(repository.calls).toEqual([
      {
        projectionName: "main",
        batchSize: 2,
      },
    ]);
  });

  it("returns a skipped result when another processor holds the advisory lock", async () => {
    const repository = new FakeProjectionRepository({
      locked: false,
      processedEvents: 0,
      lastEventId: 7,
    });

    await expect(
      processProjections(
        {
          projectionName: "main",
          batchSize: 100,
        },
        {
          projectionRepository: repository,
        },
      ),
    ).resolves.toEqual({
      locked: false,
      processedEvents: 0,
      lastEventId: 7,
    });
  });

  it("rejects unbounded batch sizes", async () => {
    await expect(
      processProjections(
        {
          batchSize: 1001,
        },
        {
          projectionRepository: new FakeProjectionRepository({
            locked: true,
            processedEvents: 0,
            lastEventId: 0,
          }),
        },
      ),
    ).rejects.toThrow("batchSize must be an integer between 1 and 1000.");
  });
});

class FakeProjectionRepository implements ProjectionRepository {
  readonly calls: Array<{ projectionName: string; batchSize: number }> = [];

  constructor(private readonly result: ProjectionBatchResult) {}

  async processBatchWithLock(input: { projectionName: string; batchSize: number }) {
    this.calls.push(input);
    return this.result;
  }
}
