import "dotenv/config";

import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for dev database reset.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
const allowedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  ...readCsvEnv("MINISHOP_ALLOWED_RESET_HOSTS"),
]);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, "");

if (process.env.MINISHOP_ALLOW_DB_RESET !== "1") {
  throw new Error("Set MINISHOP_ALLOW_DB_RESET=1 to reset the development database.");
}

if (!allowedHosts.has(parsedDatabaseUrl.hostname) || databaseName !== "minishop") {
  throw new Error("Refusing to reset a database that is not local minishop.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

function readCsvEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  // Reset app tables and Drizzle's migration journal together so migrate never reports a false clean state.
  await pool.query(`
    drop schema if exists public cascade;
    drop schema if exists drizzle cascade;
    create schema public;
    grant all on schema public to public;
  `);

  console.log(`Reset development database "${databaseName}" on ${parsedDatabaseUrl.host}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
