/**
 * Fails when an acceptance ID in a spec marked `Traceability: enforced` has no test whose name
 * contains `<ID>:`. Items tagged `[deploy]` or `[measure]` are proven outside tests and only
 * listed. Rows of a spec's test-plan case file count for that spec when some test runs the case
 * file. See docs/process/workflow.md.
 */
import { globSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCaseRows, specPaths } from "./render-test-plan";

const tsTestGlobs = ["src/**/*.test.ts", "scripts/**/*.test.ts", "e2e/**/*.spec.ts"];
const goTestGlob = "**/*_test.go";
const excludedDirs = ["**/node_modules", "**/vendor", "**/.git"];
/** The gates' own tests hold fixture titles for fake specs, so they never trace a real one. */
const gateTestPaths = new Set([
  "scripts/check-spec-traceability.test.ts",
  "scripts/render-test-plan.test.ts",
]);

export interface AcceptanceItem {
  readonly spec: string;
  readonly id: string;
  readonly tag?: "deploy" | "measure";
}

/** `draft` or `enforced` from the spec's `Traceability:` line; undefined when missing or unknown. */
export function traceabilityMode(markdown: string): "draft" | "enforced" | undefined {
  const match = /^Traceability:\s*(draft|enforced)(?:\s+\(.*\))?\s*$/mu.exec(markdown);
  return match?.[1] as "draft" | "enforced" | undefined;
}

export function acceptanceItems(spec: string, markdown: string): readonly AcceptanceItem[] {
  if (traceabilityMode(markdown) !== "enforced") return [];
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^## Acceptance\s*$/u.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return [...section.matchAll(/^- ([A-Z]+\d+):\s*(\[(deploy|measure)\])?/gmu)].map((match) => ({
    spec,
    id: match[1] as string,
    ...(match[3] === undefined ? {} : { tag: match[3] as "deploy" | "measure" }),
  }));
}

const unescapeLiteral = (text: string) => text.replace(/\\(.)/gu, "$1");

/** Titles passed to test/it/describe (and their `.each(...)` forms) in TypeScript sources. */
export function testTitles(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /\b(?:test|it|describe)(?:\.each\([^)]*\))?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gu,
    ),
  ].map((match) => unescapeLiteral(match[2] as string));
}

/** Titles passed to Ginkgo Describe/Context/When/It/DescribeTable/Entry and to `x.Run(...)`. */
export function goTestTitles(source: string): readonly string[] {
  return [
    ...source.matchAll(
      /(?:\b(?:Describe|Context|When|It|DescribeTable|Entry)|\b\w+\.Run)\(\s*(?:"((?:\\.|[^"\\])*)"|`([^`]*)`)/gu,
    ),
  ].map((match) => (match[1] === undefined ? (match[2] as string) : unescapeLiteral(match[1])));
}

export function untracedItems(
  items: readonly AcceptanceItem[],
  titles: readonly string[],
  caseIds: ReadonlySet<string> = new Set(),
): readonly AcceptanceItem[] {
  return items.filter(
    (item) =>
      item.tag === undefined &&
      !caseIds.has(`${item.spec}#${item.id}`) &&
      !titles.some((title) => new RegExp(`(^|[^A-Za-z0-9])${item.id}:`, "u").test(title)),
  );
}

/** Case files named by a spec's `<!-- test-plan:start … -->` markers (see render-test-plan.ts). */
export function testPlanCaseFiles(markdown: string): readonly string[] {
  return [...markdown.matchAll(/<!-- test-plan:start (\S+) -->/gu)].map(
    (match) => match[1] as string,
  );
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Whether a test runs the case file: a TypeScript test imports it and iterates with `.each`; a Go
 * `_test.go` file names its basename (e.g. in `os.ReadFile` or `//go:embed`).
 */
export function runsCaseFile(testPath: string, testSource: string, casePath: string): boolean {
  const file = basename(casePath);
  if (testPath.endsWith("_test.go")) {
    return new RegExp(`(?<![\\w.-])${escapeRegExp(file)}(?![\\w.-])`, "u").test(testSource);
  }
  const module = escapeRegExp(file.replace(/\.ts$/u, ""));
  return (
    new RegExp(`from ["'][^"']*/${module}(\\.[jt]s)?["']`, "u").test(testSource) &&
    /\b(?:test|it|describe)\.each\(/u.test(testSource)
  );
}

export async function checkTraceability(root: string): Promise<{
  items: AcceptanceItem[];
  listed: AcceptanceItem[];
  errors: string[];
}> {
  const sources = new Map<string, string>();
  for (const pattern of [...tsTestGlobs, goTestGlob]) {
    for (const path of globSync(pattern, { cwd: root, exclude: excludedDirs })) {
      if (gateTestPaths.has(path)) continue;
      sources.set(path, readFileSync(resolve(root, path), "utf8"));
    }
  }
  const titles = [...sources].flatMap(([path, source]) =>
    path.endsWith(".go") ? goTestTitles(source) : testTitles(source),
  );

  const items: AcceptanceItem[] = [];
  const errors: string[] = [];
  const caseIds = new Set<string>();
  for (const spec of specPaths(root)) {
    const markdown = readFileSync(resolve(root, spec), "utf8");
    if (traceabilityMode(markdown) === undefined) {
      errors.push(`${spec}: Traceability must start with "draft" or "enforced"`);
      continue;
    }
    const specItems = acceptanceItems(spec, markdown);
    if (specItems.length === 0) continue;
    items.push(...specItems);
    for (const casePath of testPlanCaseFiles(markdown)) {
      if (![...sources].some(([path, source]) => runsCaseFile(path, source, casePath))) {
        errors.push(`${spec}: no test runs ${casePath}`);
        continue;
      }
      for (const row of await loadCaseRows(root, casePath)) caseIds.add(`${spec}#${row.id}`);
    }
  }
  for (const item of untracedItems(items, titles, caseIds)) {
    errors.push(`${item.spec} ${item.id}: no test name contains "${item.id}:"`);
  }
  return { items, listed: items.filter((item) => item.tag !== undefined), errors };
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { items, listed, errors } = await checkTraceability(root);
  for (const item of listed) {
    console.log(`${item.spec} ${item.id}: proven by [${item.tag}], list it in the PR`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`traceability ok: ${items.length} acceptance items in enforced specs`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
