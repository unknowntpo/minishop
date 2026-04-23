import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, expect, type Page } from "@playwright/test";

type DashboardProduct = {
  productName: string;
  seckillEnabled: boolean;
  skuId: string;
};

type DashboardResponse = {
  products: DashboardProduct[];
  refreshedAt: string;
};

type CommandStatusResponse = {
  checkoutIntentId: string | null;
  commandId: string;
  failureCode: string | null;
  failureMessage: string | null;
  status: "accepted" | "processing" | "created" | "failed";
};

type BenchmarkResult = {
  artifactPath: string;
  bucketCount: number;
  completed: number;
  concurrency: number;
  created: number;
  durationMs: number;
  errors: string[];
  failed: number;
  p95Ms: number;
  requests: number;
  runId: string;
  scenario: string;
  throughputPerSecond: number;
};

const appUrl = requiredUrl("BUYER_WEB_BENCH_APP_URL", "http://127.0.0.1:3001");
const apiUrl = requiredUrl("BUYER_WEB_BENCH_API_URL", "http://127.0.0.1:3005");
const requests = positiveInt("BUYER_WEB_BENCH_REQUESTS", 120);
const concurrency = positiveInt("BUYER_WEB_BENCH_CONCURRENCY", 12);
const seckillStock = positiveInt("BUYER_WEB_BENCH_SECKILL_STOCK", requests);
const bucketCount = positiveInt("BUYER_WEB_BENCH_BUCKET_COUNT", 4);
const scenario = process.env.BUYER_WEB_BENCH_SCENARIO?.trim() || "buyer-web-hot-seckill";
const runId = process.env.BUYER_WEB_BENCH_RUN_ID?.trim() || `buyer_web_${Date.now()}`;
const resultsDir = process.env.BUYER_WEB_BENCH_RESULTS_DIR?.trim() || "benchmark-results";

function requiredUrl(name: string, fallback: string) {
  const value = process.env[name]?.trim() || fallback;
  return value.replace(/\/$/, "");
}

function positiveInt(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index] ?? 0;
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${pathname} -> ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

async function waitForCommandStatus(commandId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiUrl}/api/buy-intent-commands/${commandId}`, {
      cache: "no-store",
    });
    if (response.status === 404) {
      await sleep(250);
      continue;
    }
    if (!response.ok) {
      throw new Error(`/api/buy-intent-commands/${commandId} -> ${response.status}`);
    }
    const body = (await response.json()) as CommandStatusResponse;
    if (body.status === "created" || body.status === "failed") {
      return body;
    }
    await sleep(250);
  }
  throw new Error(`command ${commandId} did not reach terminal status`);
}

async function enableSeckill() {
  await requestJson<{ ok: boolean }>("/api/internal/admin/seckill", {
    method: "POST",
    body: JSON.stringify({
      skuId: "sku_hot_001",
      enabled: true,
      stockLimit: seckillStock,
    }),
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const dashboard = await requestJson<DashboardResponse>("/api/internal/admin/dashboard", { method: "GET" });
    const product = dashboard.products.find((row) => row.skuId === "sku_hot_001");
    if (product?.seckillEnabled) {
      return;
    }
    await sleep(500);
  }

  throw new Error("seckill enable did not become visible in admin dashboard");
}

async function waitForCheckoutTerminal(page: Page, commandId: string) {
  try {
    await page.waitForFunction(() => window.location.pathname.startsWith("/checkout-complete/"), undefined, {
      timeout: 60_000,
    });
    await page.locator(".checkout-complete-panel").waitFor({ timeout: 15_000 });
    const statusText = (await page.locator(".completion-grid").textContent()) ?? "";
    return { pageStatus: statusText.toLowerCase(), commandStatus: null as CommandStatusResponse | null };
  } catch {
    const commandStatus = await waitForCommandStatus(commandId);
    return { pageStatus: null, commandStatus };
  }
}

async function runWorker(workerIndex: number, iterations: number) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const durations: number[] = [];
  const errors: string[] = [];
  let created = 0;
  let failed = 0;

  try {
    for (let i = 0; i < iterations; i += 1) {
      const label = `worker-${workerIndex}-iter-${i}`;
      try {
        await page.goto(`${appUrl}/products/limited-runner`, { timeout: 30_000 });
        await expect(page).toHaveURL(/\/products\/limited-runner$/, { timeout: 15_000 });
        await expect(page.getByText(/秒殺|seckill/i).first()).toBeVisible({ timeout: 15_000 });

        const startedAt = performance.now();
        const buyIntentAccepted = page.waitForResponse(
          (response) =>
            response.url() === `${apiUrl}/api/buy-intents` &&
            response.request().method() === "POST" &&
            response.status() === 202,
          { timeout: 30_000 },
        );

        await page.getByRole("button", { name: /立即購買|Buy now/i }).click();
        const acceptedResponse = await buyIntentAccepted;
        const body = (await acceptedResponse.json()) as { commandId: string };
        const terminal = await waitForCheckoutTerminal(page, body.commandId);

        if (terminal.commandStatus?.status === "failed") {
          failed += 1;
          throw new Error(terminal.commandStatus.failureMessage ?? terminal.commandStatus.failureCode ?? "command failed");
        }

        if (terminal.pageStatus && !terminal.pageStatus.includes("confirmed")) {
          failed += 1;
          throw new Error(`unexpected checkout terminal page: ${terminal.pageStatus}`);
        }

        created += 1;
        durations.push(performance.now() - startedAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${label}: ${message}`);
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  return { created, durations, errors, failed };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await enableSeckill();

  const perWorker = Math.floor(requests / concurrency);
  const remainder = requests % concurrency;
  const workerIterations = Array.from({ length: concurrency }, (_, index) => perWorker + (index < remainder ? 1 : 0));

  const startedAt = performance.now();
  const settled = await Promise.all(workerIterations.map((iterations, index) => runWorker(index, iterations)));
  const endedAt = performance.now();

  const durations = settled.flatMap((entry) => entry.durations).sort((a, b) => a - b);
  const errors = settled.flatMap((entry) => entry.errors);
  const created = settled.reduce((sum, entry) => sum + entry.created, 0);
  const failed = settled.reduce((sum, entry) => sum + entry.failed, 0);
  const completed = durations.length;
  const durationMs = endedAt - startedAt;
  const throughputPerSecond = completed / (durationMs / 1000);
  const p95Ms = percentile(durations, 95);

  const outputDir = path.join(resultsDir, scenario);
  await mkdir(outputDir, { recursive: true });

  const artifactName = `${new Date().toISOString().replaceAll(":", "-")}_${runId}.json`;
  const artifactPath = path.join(outputDir, artifactName);

  const result: BenchmarkResult = {
    artifactPath,
    bucketCount,
    completed,
    concurrency,
    created,
    durationMs,
    errors,
    failed,
    p95Ms,
    requests,
    runId,
    scenario,
    throughputPerSecond,
  };

  await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
