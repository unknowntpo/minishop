import { readFile } from "node:fs/promises";
import path from "node:path";

const speedscopeRoot = path.join(process.cwd(), "node_modules", "speedscope", "dist", "release");

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

export async function GET(
  _: Request,
  context: { params: Promise<{ asset?: string[] }> },
) {
  const params = await context.params;
  const assetPath = params.asset?.length ? params.asset.join("/") : "index.html";
  const absolutePath = path.resolve(speedscopeRoot, assetPath);

  if (!absolutePath.startsWith(speedscopeRoot + path.sep) && absolutePath !== path.join(speedscopeRoot, "index.html")) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await readFile(absolutePath);
    const extension = path.extname(absolutePath);

    return new Response(file, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
      },
      status: 200,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
