import { readFile } from "node:fs/promises";
import path from "node:path";

const benchmarkResultsRoot = path.join(process.cwd(), "benchmark-results");

export async function GET(request: Request) {
  const url = new URL(request.url);
  const relativePath = url.searchParams.get("file")?.trim() ?? "";

  if (!relativePath || relativePath.includes("\0")) {
    return jsonError("Missing profile file.", 400);
  }

  const absolutePath = path.resolve(benchmarkResultsRoot, relativePath);

  if (!absolutePath.startsWith(benchmarkResultsRoot + path.sep)) {
    return jsonError("Invalid profile path.", 400);
  }

  try {
    const raw = await readFile(absolutePath, "utf8");

    return new Response(raw, {
      headers: corsHeaders({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      }),
      status: 200,
    });
  } catch {
    return jsonError("Profile could not be read.", 404);
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: corsHeaders(),
    status: 204,
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    headers: corsHeaders({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    }),
    status,
  });
}

function corsHeaders(headers: HeadersInit = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    ...headers,
  };
}
