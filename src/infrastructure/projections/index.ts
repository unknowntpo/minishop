import { getPool } from "@/db/client";
import { createPostgresProjectionRepository } from "@/src/infrastructure/projections/postgres-projection-repository";
import type { ProjectionRepository } from "@/src/ports/projection-repository";

export const postgresProjectionRepository: ProjectionRepository = {
  processBatchWithLock(input) {
    return createPostgresProjectionRepository(getPool()).processBatchWithLock(input);
  },
};
