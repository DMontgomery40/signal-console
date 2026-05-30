// Cross-language bounds contract (audit fix F-001).
//
// state-space-bounds.json is the single source of truth for the inclusive
// [min,max] of every board state-space config field. This test introspects the
// REAL Zod validator (BoardStateSpaceConfigSchema) and asserts it matches that
// file; test_state_space_bounds_contract.py does the same for the pydantic
// models. Together they make it impossible to change a bound in one language
// without the other (and the JSON) going red — closing the "kept in lockstep by
// hand-discipline only" gap the two schemas previously relied on.
//
// It intentionally reads Zod internals (`_def`). If a Zod major bump changes
// that shape this test fails loudly — which is the correct signal to re-confirm
// the contract, not a false alarm to suppress.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BoardStateSpaceConfigSchema } from "../state-space-config";

interface Bound {
  readonly min: number;
  readonly max: number;
  readonly int?: true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(schema: any): any {
  let s = schema;
  for (let i = 0; i < 20; i++) {
    const tn = s?._def?.typeName;
    if (tn === "ZodDefault" || tn === "ZodOptional" || tn === "ZodNullable") {
      s = s._def.innerType;
      continue;
    }
    if (tn === "ZodEffects") {
      s = s._def.schema;
      continue;
    }
    break;
  }
  return s;
}

function extractBoundsFromZod(): Record<string, Bound> {
  const root = unwrap(BoardStateSpaceConfigSchema);
  const out: Record<string, Bound> = {};
  for (const [groupKey, groupSchema] of Object.entries<unknown>(root.shape)) {
    const groupObj = unwrap(groupSchema);
    for (const [fieldKey, fieldSchema] of Object.entries<unknown>(groupObj.shape)) {
      const num = unwrap(fieldSchema);
      let min: number | undefined;
      let max: number | undefined;
      let isInt = false;
      for (const check of num._def.checks as ReadonlyArray<{ kind: string; value?: number }>) {
        if (check.kind === "min") min = check.value;
        else if (check.kind === "max") max = check.value;
        else if (check.kind === "int") isInt = true;
      }
      if (min === undefined || max === undefined) {
        throw new Error(`Zod field ${groupKey}.${fieldKey} is missing a min or max check`);
      }
      out[`${groupKey}.${fieldKey}`] = isInt ? { min, max, int: true } : { min, max };
    }
  }
  return out;
}

function loadContract(): Record<string, Bound> {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../state-space-bounds.json", import.meta.url), "utf8"),
  );
  if (typeof raw !== "object" || raw === null) throw new Error("bounds json is not an object");
  const out: Record<string, Bound> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "_comment") continue;
    out[key] = value as Bound;
  }
  return out;
}

describe("board state-space bounds contract (F-001)", () => {
  it("the live Zod schema matches state-space-bounds.json field-for-field", () => {
    expect(extractBoundsFromZod()).toEqual(loadContract());
  });
});
