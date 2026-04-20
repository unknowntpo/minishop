import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

declare global {
  var minishopPool: Pool | undefined;
}

export function getPool() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool =
    globalThis.minishopPool ??
    new Pool({
      connectionString: databaseUrl,
      max: 10,
    });

  // Reuse one process-wide pool in both dev and production. In dev this avoids
  // hot-reload churn; in production it prevents creating a fresh pg pool per call.
  globalThis.minishopPool = pool;

  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
