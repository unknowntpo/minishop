/* @vitest-environment node */

import { execSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { acceptBuyIntentCommand } from "@/src/application/checkout/accept-buy-intent-command";
import { processStagedBuyIntentCommandBatch } from "@/src/application/checkout/process-staged-buy-intent-command-batch";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";
import { createPostgresBuyIntentCommandBus } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-bus";
import { createPostgresBuyIntentCommandGateway } from "@/src/infrastructure/checkout-command/postgres-buy-intent-command-gateway";
import { createPostgresEventStore } from "@/src/infrastructure/event-store/postgres-event-store";
import type { BuyIntentCommandOrchestrator } from "@/src/ports/buy-intent-command-orchestrator";

const workdir = "/Users/unknowntpo/repo/unknowntpo/minishop/main";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/minishop";

const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
});

const gateway = createPostgresBuyIntentCommandGateway(pool);
const bus = createPostgresBuyIntentCommandBus(pool);
const orchestrator: BuyIntentCommandOrchestrator = {
  async start() {},
  async markProcessing() {},
  async markCreated() {},
  async markFailed() {},
};
const eventStore = createPostgresEventStore(pool);

describe("async buy-intent command flow integration", () => {
  beforeAll(async () => {
    execSync("docker compose up -d postgres", {
      cwd: workdir,
      stdio: "inherit",
    });

    await waitForPostgres();

    execSync("pnpm --config.engine-strict=false db:migrate", {
      cwd: workdir,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    });
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table
        staged_buy_intent_command,
        command_status,
        event_store,
        checkout_intent_projection,
        order_projection,
        projection_checkpoint
      restart identity
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("accepts, stages, merges, and exposes a created command result", async () => {
    const accepted = await acceptBuyIntentCommand(buildAcceptInput("idem-created"), {
      bus,
      idGenerator: fixedIds("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
      clock: fixedClock(),
    });

    const processed = await processStagedBuyIntentCommandBatch(
      {},
      {
        gateway,
        orchestrator,
        eventStore,
        idGenerator: fixedIds(
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
        ),
        clock: fixedClock(),
      },
    );

    const status = await gateway.readStatus(accepted.commandId);

    expect(processed).toMatchObject({
      claimedCount: 1,
      createdCount: 1,
      failedCount: 0,
      duplicateCommandCount: 0,
    });
    expect(status).toMatchObject({
      commandId: accepted.commandId,
      correlationId: accepted.correlationId,
      status: "created",
      checkoutIntentId: "44444444-4444-4444-8444-444444444444",
      eventId: "55555555-5555-4555-8555-555555555555",
      isDuplicate: false,
    });

    const countResult = await pool.query<{ count: string }>("select count(*)::text as count from event_store");
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(1);
  });

  it("marks a second command with the same idempotency key as replay-created", async () => {
    const first = await acceptBuyIntentCommand(buildAcceptInput("idem-replay"), {
      bus,
      idGenerator: fixedIds("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"),
      clock: fixedClock(),
    });

    await processStagedBuyIntentCommandBatch(
      {},
      {
        gateway,
        orchestrator,
        eventStore,
        idGenerator: fixedIds(
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
        ),
        clock: fixedClock(),
      },
    );

    const second = await acceptBuyIntentCommand(buildAcceptInput("idem-replay"), {
      bus,
      idGenerator: fixedIds("66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"),
      clock: fixedClock(),
    });

    const processed = await processStagedBuyIntentCommandBatch(
      {},
      {
        gateway,
        orchestrator,
        eventStore,
        idGenerator: fixedIds(
          "88888888-8888-4888-8888-888888888888",
          "99999999-9999-4999-8999-999999999999",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        clock: fixedClock(),
      },
    );

    const firstStatus = await gateway.readStatus(first.commandId);
    const secondStatus = await gateway.readStatus(second.commandId);
    const countResult = await pool.query<{ count: string }>("select count(*)::text as count from event_store");

    expect(processed).toMatchObject({
      claimedCount: 1,
      createdCount: 1,
      failedCount: 0,
      duplicateCommandCount: 0,
    });
    expect(firstStatus?.status).toBe("created");
    expect(firstStatus?.isDuplicate).toBe(false);
    expect(secondStatus).toMatchObject({
      status: "created",
      checkoutIntentId: "44444444-4444-4444-8444-444444444444",
      eventId: "55555555-5555-4555-8555-555555555555",
      isDuplicate: true,
    });
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(1);
  });

  it("dedupes a restaged duplicate command in merge", async () => {
    const command = buildCommand({
      commandId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "idem-duplicate-command",
    });

    await gateway.ensureAcceptedBatch([
      {
        commandId: command.command_id,
        correlationId: command.correlation_id,
        ...(command.idempotency_key ? { idempotencyKey: command.idempotency_key } : {}),
      },
    ]);
    await gateway.stage({ command });

    await processStagedBuyIntentCommandBatch(
      {},
      {
        gateway,
        orchestrator,
        eventStore,
        idGenerator: fixedIds(
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
        ),
        clock: fixedClock(),
      },
    );

    await gateway.stage({ command });

    const processed = await processStagedBuyIntentCommandBatch(
      {},
      {
        gateway,
        orchestrator,
        eventStore,
        idGenerator: fixedIds(
          "66666666-6666-4666-8666-666666666666",
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ),
        clock: fixedClock(),
      },
    );

    const status = await gateway.readStatus(command.command_id);
    const countResult = await pool.query<{ count: string }>("select count(*)::text as count from event_store");

    expect(processed).toMatchObject({
      claimedCount: 1,
      createdCount: 0,
      failedCount: 0,
      duplicateCommandCount: 1,
    });
    expect(status).toMatchObject({
      status: "created",
      isDuplicate: false,
      checkoutIntentId: "44444444-4444-4444-8444-444444444444",
      eventId: "55555555-5555-4555-8555-555555555555",
    });
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(1);
  });
});

function buildAcceptInput(idempotencyKey: string) {
  return {
    buyer_id: "buyer_1",
    items: [
      {
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 1200,
        currency: "TWD",
      },
    ],
    idempotency_key: idempotencyKey,
    metadata: {
      request_id: "req_1",
      trace_id: "trace_1",
      source: "web" as const,
      actor_id: "buyer_1",
    },
  };
}

function buildCommand(input: {
  commandId: string;
  correlationId: string;
  idempotencyKey: string;
}): BuyIntentCommand {
  return {
    command_id: input.commandId,
    correlation_id: input.correlationId,
    buyer_id: "buyer_1",
    idempotency_key: input.idempotencyKey,
    items: [
      {
        sku_id: "sku_hot_001",
        quantity: 1,
        unit_price_amount_minor: 1200,
        currency: "TWD",
      },
    ],
    metadata: {
      request_id: "req_1",
      trace_id: "trace_1",
      source: "web" as const,
      actor_id: "buyer_1",
    },
    issued_at: "2026-04-20T03:00:00.000Z",
  };
}

function fixedClock() {
  return {
    now() {
      return new Date("2026-04-20T03:00:00.000Z");
    },
  };
}

function fixedIds(...values: string[]) {
  let index = 0;

  return {
    randomUuid() {
      const value = values[index];

      if (!value) {
        throw new Error("No more fixed ids available.");
      }

      index += 1;
      return value;
    },
  };
}

async function waitForPostgres() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      await pool.query("select 1");
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error("Postgres did not become ready in time.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
