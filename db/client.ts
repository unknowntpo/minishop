import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  minishopPool?: Pool;
};

export function getPool() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool =
    globalForDb.minishopPool ??
    new Pool({
      connectionString: databaseUrl,
      max: 10,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.minishopPool = pool;
  }

  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}
