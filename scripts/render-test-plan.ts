/**
 * Renders each spec's test-plan table from the case file named in its marker, so the table a
 * human reviews is the data the tests run (docs/process/workflow.md). `--check` fails instead
 * of writing when a table is out of date.
 *
 *   <!-- test-plan:start docs/specs/001-x/x.cases.json -->
 *   …generated table…
 *   <!-- test-plan:end -->
 *
 * A case file is a TypeScript module exporting `testPlanRows` or a `.json` file holding an array
 * of row objects (readable from Go table tests).
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Cell = string | number | boolean | null;
export type Row = Readonly<Record<string, Cell>>;

const block = /(<!-- test-plan:start (\S+) -->\n)[\s\S]*?(<!-- test-plan:end -->)/gu;

/** Spec files under docs/specs, excluding templates in docs/specs/_*. */
export function specPaths(root: string): string[] {
  return globSync("docs/specs/*/spec.md", { cwd: root })
    .filter((path) => !path.startsWith("docs/specs/_"))
    .sort();
}

export function renderTable(rows: readonly Row[]): string {
  if (rows.length === 0) throw new Error("A test plan needs at least one row");
  const columns = Object.keys(rows[0] ?? {});
  const cell = (value: Cell) =>
    value === null
      ? "—"
      : typeof value === "boolean"
        ? value
          ? "yes"
          : "no"
        : String(value).replaceAll("|", "\\|");
  return `${[
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((column) => cell(row[column] ?? null)).join(" | ")} |`),
  ].join("\n")}\n`;
}

export async function renderSpec(
  markdown: string,
  loadRows: (casePath: string) => Promise<readonly Row[]>,
): Promise<string> {
  let rendered = markdown;
  for (const match of markdown.matchAll(block)) {
    const table = renderTable(await loadRows(match[2] as string));
    rendered = rendered.replace(match[0], () => `${match[1]}${table}${match[3]}`);
  }
  return rendered;
}

export async function loadCaseRows(root: string, casePath: string): Promise<readonly Row[]> {
  const path = join(root, casePath);
  const rows: unknown = casePath.endsWith(".json")
    ? JSON.parse(readFileSync(path, "utf8"))
    : (await import(pathToFileURL(path).href)).testPlanRows;
  if (
    !Array.isArray(rows) ||
    !rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))
  ) {
    throw new Error(`${casePath}: a case file must hold an array of row objects`);
  }
  return rows;
}

/** Returns the specs whose tables differ from their case files; writes them unless `check`. */
export async function renderSpecs(root: string, { check }: { check: boolean }): Promise<string[]> {
  const changed: string[] = [];
  for (const path of specPaths(root)) {
    const markdown = readFileSync(join(root, path), "utf8");
    const rendered = await renderSpec(markdown, (casePath) => loadCaseRows(root, casePath));
    if (rendered === markdown) continue;
    changed.push(path);
    if (!check) writeFileSync(join(root, path), rendered);
  }
  return changed;
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const check = process.argv.includes("--check");
  const changed = await renderSpecs(root, { check });
  if (check && changed.length > 0) {
    for (const path of changed) {
      console.error(`${path}: test-plan table differs from its case file; run pnpm docs:test-plan`);
    }
    process.exit(1);
  }
  console.log(check ? "test plans ok" : `test plans rendered (${changed.length} updated)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
