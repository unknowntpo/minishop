import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertValidBuyIntentCommandContract,
  parseBuyIntentCommandContract,
} from "@/src/contracts/buy-intent-command-contract";

const fixturesRoot = join(process.cwd(), "contracts", "fixtures", "buy-intent-command");

describe("BuyIntentCommand contract fixtures", () => {
  it("accepts every valid fixture", () => {
    for (const fixture of readFixtureGroup("valid")) {
      expect(() => assertValidBuyIntentCommandContract(fixture.payload)).not.toThrow();
    }
  });

  it("rejects every invalid fixture", () => {
    for (const fixture of readFixtureGroup("invalid")) {
      expect(() => assertValidBuyIntentCommandContract(fixture.payload)).toThrow(
        /Invalid BuyIntentCommand contract/,
      );
    }
  });

  it("parses a valid fixture into the app contract shape", () => {
    const [fixture] = readFixtureGroup("valid");

    expect(parseBuyIntentCommandContract(fixture.payload)).toMatchObject({
      command_id: fixture.payload.command_id,
      correlation_id: fixture.payload.correlation_id,
      buyer_id: fixture.payload.buyer_id,
    });
  });
});

function readFixtureGroup(group: "valid" | "invalid") {
  const directory = join(fixturesRoot, group);

  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      payload: JSON.parse(readFileSync(join(directory, fileName), "utf8")) as unknown,
    }));
}
