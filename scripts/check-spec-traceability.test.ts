// @vitest-environment node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acceptanceItems,
  checkTraceability,
  goTestTitles,
  runsCaseFile,
  testPlanCaseFiles,
  testTitles,
  traceabilityMode,
  untracedItems,
} from "./check-spec-traceability";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-spec-traceability-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const enforcedSpec = (traceability: string, extra = "") => `# Spec 001: X

Traceability: ${traceability}

## Acceptance

### Behavior
- X1: precondition → action → result → evidence.
- X2: [measure] measured value.
- X3: [deploy] deployed check.
${extra}
## Non-goals
- X9: not an acceptance item.
`;

describe("acceptanceItems", () => {
  test("parses IDs and tags from the Acceptance section of an enforced spec", () => {
    expect(acceptanceItems("s.md", enforcedSpec("enforced"))).toEqual([
      { spec: "s.md", id: "X1" },
      { spec: "s.md", id: "X2", tag: "measure" },
      { spec: "s.md", id: "X3", tag: "deploy" },
    ]);
  });

  test("ignores specs that are not enforced (positive control: same text enforced has items)", () => {
    expect(acceptanceItems("s.md", enforcedSpec("draft"))).toEqual([]);
    expect(acceptanceItems("s.md", enforcedSpec("enforced"))).toHaveLength(3);
  });
});

describe("testTitles (TypeScript)", () => {
  test("extracts test, it, describe, and .each titles in all quote styles", () => {
    const source = [
      'test("X1: double", () => {});',
      "it('X2: single', () => {});",
      "describe(`X3: backtick`, () => {});",
      'test.each(rows)("X4: each %s", () => {});',
      "it.each([1, 2])('X5: it each', () => {});",
      'describe.each(rows)("X6: describe each", () => {});',
      'submit("NOT1: not a test");',
    ].join("\n");
    expect(testTitles(source)).toEqual([
      "X1: double",
      "X2: single",
      "X3: backtick",
      "X4: each %s",
      "X5: it each",
      "X6: describe each",
    ]);
  });

  test("keeps escaped quotes inside a title", () => {
    expect(testTitles('test("X1: says \\"hi\\" twice", () => {});')).toEqual([
      'X1: says "hi" twice',
    ]);
    expect(testTitles("it('X2: it\\'s fine', () => {});")).toEqual(["X2: it's fine"]);
  });
});

describe("goTestTitles", () => {
  test("extracts Ginkgo container, spec, and table titles and t.Run names", () => {
    const source = [
      'var _ = Describe("ledger hold", func() {',
      '  Context("X1: empty table", func() {',
      '    It("X2: inserts one row", func() {})',
      "  })",
      '  DescribeTable("X3: invalid bodies", func(body string) {},',
      '    Entry("X4: not json", "not json"),',
      "  )",
      "})",
      "func TestPayload(t *testing.T) {",
      '  t.Run("X5: ledger scenario", func(t *testing.T) {})',
      "  t.Run(`X6: raw string`, func(t *testing.T) {})",
      '  fmt.Println("NOT1: not a test")',
      "  It(name, func() {})",
      "}",
    ].join("\n");
    expect(goTestTitles(source)).toEqual([
      "ledger hold",
      "X1: empty table",
      "X2: inserts one row",
      "X3: invalid bodies",
      "X4: not json",
      "X5: ledger scenario",
      "X6: raw string",
    ]);
  });

  test("keeps escaped quotes in interpreted strings and backslashes in raw strings", () => {
    expect(goTestTitles('It("X1: body \\"x\\"", func() {})')).toEqual(['X1: body "x"']);
    expect(goTestTitles("t.Run(`X2: a\\b`, nil)")).toEqual(["X2: a\\b"]);
  });
});

describe("untracedItems", () => {
  const items = acceptanceItems("s.md", enforcedSpec("enforced"));

  test("reports an untagged item without a test (positive control: a matching title clears it)", () => {
    expect(untracedItems(items, ["unrelated"]).map((item) => item.id)).toEqual(["X1"]);
    expect(untracedItems(items, ["X1: covered"])).toEqual([]);
  });

  test("requires the ID followed by a colon and not inside another ID", () => {
    expect(
      untracedItems(items, ["X1 without colon", "AX1: other id", "X12: other id"]),
    ).toHaveLength(1);
    expect(untracedItems(items, ["case (X1: inside)"])).toEqual([]);
  });

  test("counts case-file rows for their own spec only", () => {
    expect(untracedItems(items, [], new Set(["s.md#X1"]))).toEqual([]);
    expect(untracedItems(items, [], new Set(["other.md#X1"]))).toHaveLength(1);
  });
});

describe("testPlanCaseFiles", () => {
  test("lists case files named by test-plan markers", () => {
    expect(
      testPlanCaseFiles(
        "<!-- test-plan:start a/b.cases.ts -->\n<!-- test-plan:end -->\n<!-- test-plan:start c.cases.json -->\n",
      ),
    ).toEqual(["a/b.cases.ts", "c.cases.json"]);
  });
});

describe("runsCaseFile", () => {
  test("TypeScript: imports the case module and iterates it with .each", () => {
    const runs =
      'import { testPlanRows } from "./ledger.cases";\ntest.each(testPlanRows)("%s", () => {});';
    expect(runsCaseFile("src/a.test.ts", runs, "src/ledger.cases.ts")).toBe(true);
    expect(
      runsCaseFile("src/a.test.ts", runs.replace("test.each", "it.each"), "src/ledger.cases.ts"),
    ).toBe(true);
    expect(
      runsCaseFile(
        "src/a.test.ts",
        'import { x } from "./ledger.cases";\ntest("X1: one", () => {});',
        "src/ledger.cases.ts",
      ),
    ).toBe(false);
    expect(
      runsCaseFile(
        "src/a.test.ts",
        'import { x } from "./other.cases";\ntest.each(x)("%s", () => {});',
        "src/ledger.cases.ts",
      ),
    ).toBe(false);
  });

  test("Go: a _test.go file references the case file by basename", () => {
    const runs = 'data, err := os.ReadFile("../../docs/specs/001-x/ledger.cases.json")';
    expect(runsCaseFile("services/x/a_test.go", runs, "docs/specs/001-x/ledger.cases.json")).toBe(
      true,
    );
    expect(
      runsCaseFile(
        "services/x/a_test.go",
        "//go:embed testdata/ledger.cases.json",
        "testdata/ledger.cases.json",
      ),
    ).toBe(true);
    expect(
      runsCaseFile(
        "services/x/a_test.go",
        'os.ReadFile("other.cases.json")',
        "docs/ledger.cases.json",
      ),
    ).toBe(false);
    expect(
      runsCaseFile(
        "services/x/a_test.go",
        'os.ReadFile("xledger.cases.json")',
        "docs/ledger.cases.json",
      ),
    ).toBe(false);
    expect(runsCaseFile("services/x/a.go", runs, "docs/specs/001-x/ledger.cases.json")).toBe(false);
  });
});

describe("checkTraceability", () => {
  const spec = (traceability: string) =>
    `# Spec 001\n\nTraceability: ${traceability}\n\n## Acceptance\n\n- L1: ts behavior.\n- L2: go behavior.\n- L3: table rows.\n- L4: [measure] benchmark.\n\n<!-- test-plan:start docs/specs/001-x/l3.cases.json -->\n<!-- test-plan:end -->\n`;
  const files = {
    "docs/specs/001-x/spec.md": spec("enforced"),
    "docs/specs/_template/spec.md": "Traceability: enforced\n\n## Acceptance\n\n- X1: template.\n",
    "docs/specs/001-x/l3.cases.json": '[{ "id": "L3", "body": "not json" }]',
    "src/a.test.ts": 'test("L1: ts", () => {});',
    "services/svc/a_test.go":
      'func TestA(t *testing.T) { t.Run("L2: go", nil); os.ReadFile("../../docs/specs/001-x/l3.cases.json") }',
    "node_modules/pkg/x_test.go": 't.Run("ZZ1: ignored", nil)',
  };

  test("passes when every untagged item is traced through TS, Go, or a case file Go runs", async () => {
    const result = await checkTraceability(fixtureRepo(files));
    expect(result.errors).toEqual([]);
    expect(result.items.map((item) => item.id)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(result.listed.map((item) => item.id)).toEqual(["L4"]);
  });

  test("fails for an untested item and for a case file no test runs", async () => {
    const result = await checkTraceability(
      fixtureRepo({
        ...files,
        "src/a.test.ts": "",
        "services/svc/a_test.go": 'func TestA(t *testing.T) { t.Run("L2: go", nil) }',
      }),
    );
    expect(result.errors).toEqual([
      "docs/specs/001-x/spec.md: no test runs docs/specs/001-x/l3.cases.json",
      'docs/specs/001-x/spec.md L1: no test name contains "L1:"',
      'docs/specs/001-x/spec.md L3: no test name contains "L3:"',
    ]);
  });

  test("ignores fixture titles in the gate's own tests (positive control: same text elsewhere traces)", async () => {
    const leak = 'test("L1: ts", () => {});';
    const gateTest = await checkTraceability(
      fixtureRepo({
        ...files,
        "src/a.test.ts": "",
        "scripts/check-spec-traceability.test.ts": leak,
      }),
    );
    expect(gateTest.errors).toEqual(['docs/specs/001-x/spec.md L1: no test name contains "L1:"']);
    const elsewhere = await checkTraceability(
      fixtureRepo({ ...files, "src/a.test.ts": "", "scripts/other.test.ts": leak }),
    );
    expect(elsewhere.errors).toEqual([]);
  });

  test("ignores a draft spec (positive control: the enforced copy fails on the same tests)", async () => {
    const bare = {
      "docs/specs/001-x/spec.md": spec("draft"),
      "docs/specs/001-x/l3.cases.json": "[]",
    };
    expect((await checkTraceability(fixtureRepo(bare))).errors).toEqual([]);
    const enforced = { ...bare, "docs/specs/001-x/spec.md": spec("enforced") };
    expect((await checkTraceability(fixtureRepo(enforced))).errors.length).toBeGreaterThan(0);
  });
});

describe("traceabilityMode", () => {
  test("reads draft or enforced as the first word, with an optional parenthetical", () => {
    expect(traceabilityMode("Traceability: enforced\n")).toBe("enforced");
    expect(traceabilityMode("Traceability: enforced (since PR 12)\n")).toBe("enforced");
    expect(traceabilityMode("Traceability: draft (becomes `enforced` later)\n")).toBe("draft");
  });

  test("rejects an unknown value or a missing line (positive control: a valid line parses)", () => {
    expect(traceabilityMode("Traceability: not enforced\n")).toBeUndefined();
    expect(traceabilityMode("Traceability: enforced-ish\n")).toBeUndefined();
    expect(traceabilityMode("# Spec without the line\n")).toBeUndefined();
    expect(traceabilityMode("Traceability: pending\n")).toBeUndefined();
    expect(traceabilityMode("  Traceability: enforced\n")).toBeUndefined();
    expect(traceabilityMode("note: Traceability: enforced\n")).toBeUndefined();
    expect(traceabilityMode("Traceability: enforced ish\n")).toBeUndefined();
    expect(traceabilityMode("Traceability: draft\n")).toBe("draft");
    expect(traceabilityMode("Traceability: enforced (x)\n")).toBe("enforced");
  });

  test("an enforced spec with a parenthetical yields items; a draft one does not", () => {
    expect(acceptanceItems("s.md", enforcedSpec("enforced (since PR 12)"))).toHaveLength(3);
    expect(acceptanceItems("s.md", enforcedSpec("draft (until PR 12)"))).toEqual([]);
  });
});

describe("acceptance ID and tag edges", () => {
  const spec = (body: string) =>
    `Traceability: enforced\n\n## Acceptance\n\n${body}\n## Non-goals\n`;

  test("parses multi-digit and multi-letter IDs", () => {
    expect(acceptanceItems("s.md", spec("- L1: one.\n- L10: ten.\n- XL1: two letters.\n"))).toEqual(
      [
        { spec: "s.md", id: "L1" },
        { spec: "s.md", id: "L10" },
        { spec: "s.md", id: "XL1" },
      ],
    );
  });

  test("an unknown bracket tag is not a tag, so the item still needs a test", () => {
    const items = acceptanceItems("s.md", spec("- X4: [skip] not a real tag.\n"));
    expect(items).toEqual([{ spec: "s.md", id: "X4" }]);
    expect(untracedItems(items, [])).toEqual(items);
  });

  test("Ginkgo When titles count", () => {
    expect(goTestTitles('When("X7: pool is full", func() {})')).toEqual(["X7: pool is full"]);
  });

  test("an ID preceded by a digit is a different ID (positive control: X1: alone traces)", () => {
    const items = acceptanceItems("s.md", spec("- X1: one.\n"));
    expect(untracedItems(items, ["1X1: other"])).toEqual(items);
    expect(untracedItems(items, ["X1: one"])).toEqual([]);
  });

  test("TypeScript case import must name the module exactly", () => {
    expect(
      runsCaseFile(
        "src/a.test.ts",
        'import { x } from "./ledger.cases-extra";\ntest.each(x)("%s", () => {});',
        "src/ledger.cases.ts",
      ),
    ).toBe(false);
  });
});

describe("checkTraceability sources and spec headers", () => {
  const spec = (traceability: string) =>
    `# Spec 001\n\nTraceability: ${traceability}\n\n## Acceptance\n\n- L1: behavior.\n`;

  test("node_modules titles never trace (positive control: the same title in src traces)", async () => {
    const leak = 't.Run("L1: go", nil)';
    const ignored = await checkTraceability(
      fixtureRepo({
        "docs/specs/001-x/spec.md": spec("enforced"),
        "node_modules/pkg/x_test.go": leak,
      }),
    );
    expect(ignored.errors).toEqual(['docs/specs/001-x/spec.md L1: no test name contains "L1:"']);
    const counted = await checkTraceability(
      fixtureRepo({ "docs/specs/001-x/spec.md": spec("enforced"), "services/x/x_test.go": leak }),
    );
    expect(counted.errors).toEqual([]);
  });

  test("Playwright e2e/**/*.spec.ts titles trace", async () => {
    const result = await checkTraceability(
      fixtureRepo({
        "docs/specs/001-x/spec.md": spec("enforced"),
        "e2e/a.spec.ts": 'test("L1: buyer flow", async () => {});',
      }),
    );
    expect(result.errors).toEqual([]);
  });

  test("ignores fixture titles in both gate test files (positive control: other files trace)", async () => {
    const leak = 'test("L1: ts", () => {});';
    for (const gateTest of [
      "scripts/check-spec-traceability.test.ts",
      "scripts/render-test-plan.test.ts",
    ]) {
      const result = await checkTraceability(
        fixtureRepo({ "docs/specs/001-x/spec.md": spec("enforced"), [gateTest]: leak }),
      );
      expect(result.errors).toEqual(['docs/specs/001-x/spec.md L1: no test name contains "L1:"']);
    }
    const other = await checkTraceability(
      fixtureRepo({ "docs/specs/001-x/spec.md": spec("enforced"), "scripts/x.test.ts": leak }),
    );
    expect(other.errors).toEqual([]);
  });

  test("fails on an unknown or missing Traceability value in a non-template spec", async () => {
    const result = await checkTraceability(
      fixtureRepo({
        "docs/specs/001-x/spec.md": spec("not enforced"),
        "docs/specs/002-y/spec.md": "# Spec 002\n",
        "docs/specs/003-z/spec.md": spec("draft (later)"),
        "docs/specs/_template/spec.md": "# template without the line\n",
      }),
    );
    expect(result.errors).toEqual([
      'docs/specs/001-x/spec.md: Traceability must start with "draft" or "enforced"',
      'docs/specs/002-y/spec.md: Traceability must start with "draft" or "enforced"',
    ]);
  });
});

describe("check:traceability CLI", () => {
  const run = (files: Record<string, string>) => {
    const root = fixtureRepo(files);
    mkdirSync(join(root, "scripts"), { recursive: true });
    for (const script of ["check-spec-traceability.ts", "render-test-plan.ts"]) {
      copyFileSync(join(import.meta.dirname, script), join(root, "scripts", script));
    }
    return spawnSync(
      join(import.meta.dirname, "../node_modules/.bin/tsx"),
      [join(root, "scripts/check-spec-traceability.ts")],
      { encoding: "utf8", timeout: 60_000 },
    );
  };
  const spec = "Traceability: enforced\n\n## Acceptance\n\n- L1: behavior.\n";

  test("exits 1 on an untraced item and 0 once a test names it", () => {
    const failing = run({ "docs/specs/001-x/spec.md": spec });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('L1: no test name contains "L1:"');
    expect(
      run({ "docs/specs/001-x/spec.md": spec, "src/a.test.ts": 'test("L1: x", () => {});' }).status,
    ).toBe(0);
  });
});
