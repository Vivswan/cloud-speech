import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../../../../scripts/check-sync.mts";

const ROOT = resolve(__dirname, "../../../..");

describe("constants sync check", () => {
  // The count pins the assertion list: one silently dropped is a lost pin.
  it("runs every restatement assertion and finds this repository clean", () => {
    expect(scanRepo(ROOT)).toEqual({ inspected: 17, findings: [] });
  });
});
