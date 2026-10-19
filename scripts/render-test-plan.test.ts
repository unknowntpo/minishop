// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadCaseRows, renderSpec, renderSpecs, renderTable } from "./render-test-plan";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "render-test-plan-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("renderTable", () => {
  test("renders a header, a separator, and one line per row in first-row column order", () => {
    expect(
      renderTable([
        { id: "L7", body: "not json", status: 400 },
        { id: "L7", body: "{}", status: 400 },
      ]),
    ).toBe(
      "| id | body | status |\n| --- | --- | --- |\n| L7 | not json | 400 |\n| L7 | {} | 400 |\n",
    );
  });

  test("escapes pipes and renders null, missing, and boolean cells", () => {
    expect(
      renderTable([
        { id: "X1", text: "a|b", flag: true, note: null },
        { id: "X2", text: "c", flag: false },
      ]),
    ).toBe(
      "| id | text | flag | note |\n| --- | --- | --- | --- |\n| X1 | a\\|b | yes | — |\n| X2 | c | no | — |\n",
    );
  });

  test("rejects an empty plan", () => {
    expect(() => renderTable([])).toThrow("at least one row");
  });
});

describe("renderSpec", () => {
  test("replaces the stale table between the markers and keeps the surrounding text", async () => {
    const markdown =
      "intro\n<!-- test-plan:start a.cases.json -->\n| old |\n<!-- test-plan:end -->\noutro\n";
    const rendered = await renderSpec(markdown, async (casePath) => {
      expect(casePath).toBe("a.cases.json");
      return [{ id: "X1", ok: true }];
    });
    expect(rendered).toBe(
      "intro\n<!-- test-plan:start a.cases.json -->\n| id | ok |\n| --- | --- |\n| X1 | yes |\n<!-- test-plan:end -->\noutro\n",
    );
  });

  test("keeps dollar sequences in cells literal", async () => {
    const rendered = await renderSpec(
      "<!-- test-plan:start a.cases.json -->\n<!-- test-plan:end -->\n",
      async () => [{ id: "X1", body: "$& $1 $'" }],
    );
    expect(rendered).toContain("| X1 | $& $1 $' |");
  });

  test("leaves a spec without markers unchanged (positive control: a marker is rendered)", async () => {
    const load = async () => [{ id: "X1" }];
    expect(await renderSpec("no plan here\n", load)).toBe("no plan here\n");
    expect(
      await renderSpec("<!-- test-plan:start a.cases.json -->\n<!-- test-plan:end -->\n", load),
    ).toContain("| X1 |");
  });
});

describe("loadCaseRows", () => {
  test("loads testPlanRows from a TypeScript module and rows from a JSON array", async () => {
    const root = fixtureRepo({
      "cases/a.cases.ts": 'export const testPlanRows = [{ id: "X1", n: 1 }];\n',
      "cases/b.cases.json": '[{ "id": "X2", "n": 2 }]\n',
    });
    expect(await loadCaseRows(root, "cases/a.cases.ts")).toEqual([{ id: "X1", n: 1 }]);
    expect(await loadCaseRows(root, "cases/b.cases.json")).toEqual([{ id: "X2", n: 2 }]);
  });

  test("rejects a JSON case file that is not an array of objects", async () => {
    const root = fixtureRepo({ "cases/bad.cases.json": '{ "id": "X1" }\n' });
    await expect(loadCaseRows(root, "cases/bad.cases.json")).rejects.toThrow(
      "array of row objects",
    );
  });
});

describe("renderSpecs", () => {
  const specPath = "docs/specs/001-x/spec.md";
  const stale =
    "# Spec\n<!-- test-plan:start cases/x.cases.json -->\n| stale |\n<!-- test-plan:end -->\n";
  const fresh =
    "# Spec\n<!-- test-plan:start cases/x.cases.json -->\n| id | expected |\n| --- | --- |\n| X1 | 201 |\n<!-- test-plan:end -->\n";

  test("--check reports a drifted spec without writing it, and passes once it is rendered", async () => {
    const root = fixtureRepo({
      [specPath]: stale,
      "cases/x.cases.json": '[{ "id": "X1", "expected": 201 }]',
    });
    expect(await renderSpecs(root, { check: true })).toEqual([specPath]);
    expect(readFileSync(join(root, specPath), "utf8")).toBe(stale);

    expect(await renderSpecs(root, { check: false })).toEqual([specPath]);
    expect(readFileSync(join(root, specPath), "utf8")).toBe(fresh);
    expect(await renderSpecs(root, { check: true })).toEqual([]);
  });

  test("skips templates under docs/specs/_* (positive control: the same text in a spec drifts)", async () => {
    const root = fixtureRepo({
      "docs/specs/_template/spec.md": stale,
      [specPath]: stale,
      "cases/x.cases.json": '[{ "id": "X1", "expected": 201 }]',
    });
    expect(await renderSpecs(root, { check: true })).toEqual([specPath]);
  });
});

describe("renderSpec with several plans", () => {
  test("renders each marker block from its own case file", async () => {
    const markdown =
      "<!-- test-plan:start a.cases.json -->\n| old a |\n<!-- test-plan:end -->\nmiddle\n<!-- test-plan:start b.cases.json -->\n| old b |\n<!-- test-plan:end -->\n";
    const rendered = await renderSpec(markdown, async (casePath) => [{ id: casePath }]);
    expect(rendered).toBe(
      "<!-- test-plan:start a.cases.json -->\n| id |\n| --- |\n| a.cases.json |\n<!-- test-plan:end -->\nmiddle\n<!-- test-plan:start b.cases.json -->\n| id |\n| --- |\n| b.cases.json |\n<!-- test-plan:end -->\n",
    );
  });
});

describe("test-plan CLI", () => {
  const run = (args: string[]) => {
    const root = fixtureRepo({
      "docs/specs/001-x/spec.md":
        "<!-- test-plan:start cases/x.cases.json -->\n| stale |\n<!-- test-plan:end -->\n",
      "cases/x.cases.json": '[{ "id": "X1" }]',
    });
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(
      join(import.meta.dirname, "render-test-plan.ts"),
      join(root, "scripts/render-test-plan.ts"),
    );
    const result = spawnSync(
      join(import.meta.dirname, "../node_modules/.bin/tsx"),
      [join(root, "scripts/render-test-plan.ts"), ...args],
      { encoding: "utf8", timeout: 60_000 },
    );
    return { ...result, spec: readFileSync(join(root, "docs/specs/001-x/spec.md"), "utf8") };
  };

  test("--check exits 1 on drift without writing; without it the table is written", () => {
    const checked = run(["--check"]);
    expect(checked.status).toBe(1);
    expect(checked.spec).toContain("| stale |");
    const written = run([]);
    expect(written.status).toBe(0);
    expect(written.spec).toContain("| X1 |");
  });
});
