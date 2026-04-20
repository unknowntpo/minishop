import "dotenv/config";

import { execSync } from "node:child_process";

import { connect } from "nats";
import { Pool } from "pg";

const workdir = "/Users/unknowntpo/repo/unknowntpo/minishop/main";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/minishop";
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const appBaseUrl = process.env.MINISHOP_APP_BASE_URL ?? "http://localhost:3000";
const e2eLockKey = 20_260_420;

async function main() {
  execSync("docker compose up -d postgres nats", {
    cwd: workdir,
    stdio: "inherit",
  });

  await waitForPostgres(databaseUrl);
  await waitForNats(natsUrl);

  execSync("pnpm --config.engine-strict=false db:migrate", {
    cwd: workdir,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
  });

  try {
    await acquireExclusiveE2ELock(pool);
    await pool.query(`
      truncate table
        staging_buy_intent_command,
        command_status,
        event_store,
        checkout_intent_projection,
        order_projection,
        projection_checkpoint
      restart identity
    `);
  } finally {
    await releaseExclusiveE2ELock(pool);
    await pool.end();
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.NATS_URL = natsUrl;
  process.env.NATS_BUY_INTENT_INGEST_CONTINUOUS = "1";

  execSync("docker compose up -d --build --remove-orphans app worker-buy-intents-ingest worker-buy-intents-temporal worker-projections", {
    cwd: workdir,
    stdio: "inherit",
  });

  await waitForApp(appBaseUrl);

  const firstCommandId = await createBuyIntent(appBaseUrl, "idem-e2e");
  const firstStatus = await waitForCreatedStatus(appBaseUrl, firstCommandId);

  const secondCommandId = await createBuyIntent(appBaseUrl, "idem-e2e");
  const secondStatus = await waitForCreatedStatus(appBaseUrl, secondCommandId);

  if (firstStatus.isDuplicate) {
    throw new Error("First command unexpectedly resolved as duplicate.");
  }

  if (!secondStatus.isDuplicate) {
    throw new Error("Second command was expected to resolve as duplicate replay.");
  }

  if (firstStatus.checkoutIntentId !== secondStatus.checkoutIntentId) {
    throw new Error("Replay command did not resolve to the original checkout intent.");
  }

  if (!firstStatus.checkoutIntentId) {
    throw new Error("Created command did not include a checkout intent ID.");
  }

  const checkoutIntentId = firstStatus.checkoutIntentId;
  const checkoutStatus = await waitForCheckoutStatus(
    appBaseUrl,
    checkoutIntentId,
    (status) => status !== "queued" && status !== "reserving",
    "a display-ready status",
  );

  if (checkoutStatus.status !== "pending_payment") {
    throw new Error(`Expected pending_payment checkout status, got ${checkoutStatus.status}.`);
  }

  const paymentSignalResponse = await fetch(
    `${appBaseUrl}/api/internal/buy-intent-commands/${firstCommandId}/payment-demo`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        outcome: "succeeded",
      }),
    },
  );

  if (!paymentSignalResponse.ok) {
    throw new Error(`Expected payment signal to succeed, got ${paymentSignalResponse.status}.`);
  }

  const finalCheckoutStatus = await waitForCheckoutStatus(
    appBaseUrl,
    checkoutIntentId,
    (status) => status === "confirmed",
    "confirmed",
  );

  if (finalCheckoutStatus.status !== "confirmed") {
    throw new Error(`Expected confirmed checkout status, got ${finalCheckoutStatus.status}.`);
  }

  const completionPage = await fetch(`${appBaseUrl}/checkout-complete/${checkoutIntentId}`).then(
    (response) => response.text(),
  );

  if (!completionPage.includes(firstCommandId) && !completionPage.includes(secondCommandId)) {
    throw new Error("Completion page did not include any command id for the checkout intent.");
  }

  if (!completionPage.includes("confirmed")) {
    throw new Error("Completion page did not include the confirmed checkout status.");
  }

  if (!completionPage.includes("created")) {
    throw new Error("Completion page did not include the command lifecycle status.");
  }

  console.log(
    JSON.stringify(
      {
        firstCommandId,
        secondCommandId,
        checkoutIntentId,
        checkoutStatus: finalCheckoutStatus.status,
        firstEventId: firstStatus.eventId,
        secondEventId: secondStatus.eventId,
      },
      null,
      2,
    ),
  );
}

async function acquireExclusiveE2ELock(pool: Pool) {
  const result = await pool.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [e2eLockKey],
  );

  if (!result.rows[0]?.locked) {
    throw new Error(
      "Another buy-intent backend e2e run is already active. Wait for it to finish before starting a new one.",
    );
  }
}

async function releaseExclusiveE2ELock(pool: Pool) {
  try {
    await pool.query("select pg_advisory_unlock($1)", [e2eLockKey]);
  } catch {}
}

async function createBuyIntent(
  baseUrl: string,
  idempotencyKey: string,
) {
  const response = await fetch(`${baseUrl}/api/buy-intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": crypto.randomUUID(),
      "x-trace-id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      buyerId: "buyer_1",
      items: [
        {
          skuId: "sku_hot_001",
          quantity: 1,
          unitPriceAmountMinor: 1200,
          currency: "TWD",
        },
      ],
    }),
  });

  if (response.status !== 202) {
    throw new Error(`Expected 202 from buy-intents route, got ${response.status}.`);
  }

  const body = (await response.json()) as { commandId: string };
  return body.commandId;
}

async function waitForCreatedStatus(
  baseUrl: string,
  commandId: string,
) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/buy-intent-commands/${commandId}`);

    if (response.status === 200) {
      const body = (await response.json()) as {
        status: string;
        checkoutIntentId: string | null;
        eventId: string | null;
        isDuplicate: boolean;
      };

      if (body.status === "created") {
        return body;
      }
    }

    await sleep(250);
  }

  throw new Error(`Command ${commandId} did not reach created status in time.`);
}

async function waitForCheckoutStatus(
  baseUrl: string,
  checkoutIntentId: string,
  predicate: (status: string) => boolean,
  expectedDescription: string,
) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const processResponse = await fetch(`${baseUrl}/api/internal/projections/process`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectionName: "main",
        batchSize: 100,
      }),
    });

    if (!processResponse.ok && processResponse.status !== 409) {
      throw new Error(`Projection processing failed with ${processResponse.status}.`);
    }

    const response = await fetch(`${baseUrl}/api/checkout-intents/${checkoutIntentId}`);

    if (response.ok) {
      const body = (await response.json()) as {
        status: string;
      };

      if (predicate(body.status)) {
        return body;
      }
    }

    await sleep(250);
  }

  throw new Error(
    `Checkout intent ${checkoutIntentId} did not reach ${expectedDescription} in time.`,
  );
}

async function waitForPostgres(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 1,
  });
  const deadline = Date.now() + 30_000;

  try {
    while (Date.now() < deadline) {
      try {
        await pool.query("select 1");
        return;
      } catch {
        await sleep(500);
      }
    }
  } finally {
    await pool.end();
  }

  throw new Error("Postgres did not become ready in time.");
}

async function waitForNats(servers: string) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const nc = await connect({ servers });
      await nc.close();
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error("NATS did not become ready in time.");
}

async function waitForApp(baseUrl: string) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/products`);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(1_000);
  }

  throw new Error("App did not become ready in time.");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("buy_intent_backend_e2e_failed", error);
  process.exitCode = 1;
});
