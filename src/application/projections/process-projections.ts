import type {
  ProjectionBatchResult,
  ProjectionRepository,
} from "@/src/ports/projection-repository";

export type ProcessProjectionsInput = {
  projectionName?: string;
  batchSize?: number;
};

export type ProcessProjectionsDeps = {
  projectionRepository: ProjectionRepository;
};

const defaultProjectionName = "main";
const defaultBatchSize = 100;

export async function processProjections(
  input: ProcessProjectionsInput,
  deps: ProcessProjectionsDeps,
): Promise<ProjectionBatchResult> {
  const projectionName = input.projectionName ?? defaultProjectionName;
  const batchSize = input.batchSize ?? defaultBatchSize;

  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 1000) {
    throw new Error("batchSize must be an integer between 1 and 1000.");
  }

  if (projectionName.trim().length === 0) {
    throw new Error("projectionName is required.");
  }

  return deps.projectionRepository.processBatchWithLock({
    projectionName,
    batchSize,
  });
}
