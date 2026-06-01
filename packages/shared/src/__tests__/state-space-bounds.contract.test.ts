// Cross-language bounds contract (audit fix F-001).
//
// state-space-bounds.json (in the detectors package) is the single source of
// truth for the inclusive [min,max] of every board state-space config field.
// This test introspects the REAL Zod validator (BoardStateSpaceConfigSchema) and
// asserts it matches that file; apps/nba-sidecar/.../test_state_space_bounds_contract.py
// does the same for the pydantic models. Together they make it impossible to
// change a bound in one language without the other (and the JSON) going red —
// closing the "kept in lockstep by hand-discipline only" gap.
//
// Lives in `packages/shared/src/__tests__` rather than the detectors package
// because introspecting Zod internals (`_def`) is inherently `any`-typed, which
// the detectors package's strict type-aware lint gate forbids; the shared test
// override (eslint.config.js) is the project's established home for such tests
// (see detector-source-contract.test.ts, odds-api-key-resolver.test.ts). It
// reads the JSON by repo-root path, mirroring the Python contract test.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BoardStateSpaceConfigSchema } from "@signal-console/detectors/board-mad/state-space-config";

interface Bound {
  readonly min: number;
  readonly max: number;
  readonly int?: true;
}

// `any` is permitted in shared __tests__ (eslint relaxed override); Zod internals
// (`_def`) are inherently untyped, which is why this contract test lives here and
// not in the strict detectors package.
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
  const jsonUrl = new URL(
    "../../../detectors/src/board-mad/state-space-bounds.json",
    import.meta.url,
  );
  const raw: unknown = JSON.parse(readFileSync(jsonUrl, "utf8"));
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
