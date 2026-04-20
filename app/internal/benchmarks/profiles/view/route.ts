import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const speedscopeRoot = path.join(process.cwd(), "node_modules", "speedscope", "dist", "release");

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file")?.trim() ?? "";
  const scenario = url.searchParams.get("scenario")?.trim() ?? "";
  const run = url.searchParams.get("run")?.trim() ?? "";
  const backHref = benchmarkBackHref(scenario, run);
  const profileUrl = `/api/internal/benchmarks/profiles/raw?file=${encodeURIComponent(file)}`;
  const title = path.basename(file) || "CPU profile";
  const assets = await resolveSpeedscopeAssets();

  if (!file || file.includes("\0")) {
    return htmlResponse(renderErrorHtml("Missing profile file.", backHref), 400);
  }

  return htmlResponse(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} · speedscope</title>
    <link rel="stylesheet" href="${assets.cssPath}">
    <link rel="icon" type="image/png" sizes="32x32" href="${assets.favicon32}">
    <link rel="icon" type="image/png" sizes="16x16" href="${assets.favicon16}">
    <link rel="icon" type="image/x-icon" href="${assets.faviconIco}">
    <style>
      #benchmark-back-link {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 11px;
        border-radius: 999px;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(255, 255, 255, 0.86);
        color: #111827;
        font: 600 13px/1.2 ui-sans-serif, system-ui, sans-serif;
        text-decoration: none;
        box-shadow: 0 6px 20px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(8px);
        opacity: 0.72;
        transition: opacity 140ms ease, transform 140ms ease, background 140ms ease;
      }
      #benchmark-back-link:hover,
      #benchmark-back-link:focus-visible {
        opacity: 1;
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.96);
      }
      #benchmark-back-link span {
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <a id="benchmark-back-link" href="${escapeHtml(backHref)}" aria-label="Back to benchmark results">
      <span>↩</span>
      <span>Bench</span>
    </a>
    <script>
      window.location.hash = "profileURL=${encodeURIComponent(profileUrl)}&title=${encodeURIComponent(title)}";
    </script>
    <script src="${assets.jsPath}"></script>
  </body>
</html>`,
    200,
  );
}

async function resolveSpeedscopeAssets() {
  const files = await readdir(speedscopeRoot);
  const cssPath = assetPath(findRequired(files, /^speedscope-.*\.css$/));
  const jsPath = assetPath(findRequired(files, /^speedscope-.*\.js$/));
  const favicon16 = assetPath(findRequired(files, /^favicon-16x16-.*\.png$/));
  const favicon32 = assetPath(findRequired(files, /^favicon-32x32-.*\.png$/));
  const faviconIco = assetPath(findRequired(files, /^favicon-.*\.ico$/));

  return { cssPath, favicon16, favicon32, faviconIco, jsPath };
}

function findRequired(files: string[], pattern: RegExp) {
  const found = files.find((file) => pattern.test(file));

  if (!found) {
    throw new Error(`Missing speedscope asset for pattern: ${pattern.source}`);
  }

  return found;
}

function assetPath(file: string) {
  return `/internal/benchmarks/speedscope/${file}`;
}

function benchmarkBackHref(scenarioName?: string, runId?: string) {
  const searchParams = new URLSearchParams();

  if (scenarioName) {
    searchParams.set("scenario", scenarioName);
  }

  if (runId) {
    searchParams.set("run", runId);
  }

  const query = searchParams.toString();

  return query ? `/internal/benchmarks?${query}` : "/internal/benchmarks";
}

function renderErrorHtml(message: string, backHref: string) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Profile viewer</title>
    <style>
      body {
        margin: 0;
        padding: 32px;
        font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
        color: #111827;
        background: #f8fafc;
      }
      a {
        color: #0f172a;
      }
      main {
        max-width: 720px;
      }
    </style>
  </head>
  <body>
    <main>
      <p><a href="${escapeHtml(backHref)}">Back to benchmark results</a></p>
      <h1>Profile viewer error</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlResponse(body: string, status: number) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    },
    status,
  });
}
