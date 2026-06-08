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
/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BoardStateSpaceConfigSchema } from "../state-space-config";

interface Bound {
  readonly min: number;
  readonly max: number;
  readonly int?: true;
}

const BoundSchema = z
  .object({
    min: z.number(),
    max: z.number(),
    int: z.literal(true).optional(),
  })
  .strict();

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault());
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return unwrap(schema.unwrap());
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType());
  return schema;
}

function expectZodObject(schema: z.ZodTypeAny, label: string): z.AnyZodObject {
  const unwrapped = unwrap(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    throw new Error(`Zod schema ${label} is not an object`);
  }
  return unwrapped;
}

function expectZodNumber(schema: z.ZodTypeAny, label: string): z.ZodNumber {
  const unwrapped = unwrap(schema);
  if (!(unwrapped instanceof z.ZodNumber)) {
    throw new Error(`Zod field ${label} is not a number`);
  }
  return unwrapped;
}

function objectShape(schema: z.AnyZodObject): Readonly<Record<string, z.ZodTypeAny>> {
  return schema.shape as Record<string, z.ZodTypeAny>;
}

function extractNumberBounds(schema: z.ZodNumber, label: string): Bound {
  const min = schema._def.checks.find((check) => check.kind === "min")?.value;
  const max = schema._def.checks.find((check) => check.kind === "max")?.value;
  const isInt = schema._def.checks.some((check) => check.kind === "int");

  if (typeof min !== "number" || typeof max !== "number") {
    throw new Error(`Zod field ${label} is missing a min or max check`);
  }

  return isInt ? { min, max, int: true } : { min, max };
}

function extractBoundsFromZod(): Record<string, Bound> {
  const root = expectZodObject(BoardStateSpaceConfigSchema, "root");
  const entries: ReadonlyArray<readonly [string, Bound]> = Object.entries(
    objectShape(root),
  ).flatMap(([groupKey, groupSchema]): ReadonlyArray<readonly [string, Bound]> => {
    const groupObj = expectZodObject(groupSchema, groupKey);
    return Object.entries(objectShape(groupObj)).map(([fieldKey, fieldSchema]) => {
      const label = `${groupKey}.${fieldKey}`;
      return [label, extractNumberBounds(expectZodNumber(fieldSchema, label), label)];
    });
  });
  return Object.fromEntries(entries);
}

function parseBound(value: unknown): Bound {
  const parsed = BoundSchema.parse(value);
  return parsed.int === true
    ? { min: parsed.min, max: parsed.max, int: true }
    : { min: parsed.min, max: parsed.max };
}

function loadContract(): Record<string, Bound> {
  const raw = z
    .record(z.unknown())
    .parse(
      JSON.parse(readFileSync(new URL("../state-space-bounds.json", import.meta.url), "utf8")),
    );
  const entries: ReadonlyArray<readonly [string, Bound]> = Object.entries(raw).flatMap(
    ([key, value]): ReadonlyArray<readonly [string, Bound]> =>
      key === "_comment" ? [] : [[key, parseBound(value)]],
  );
  return Object.fromEntries(entries);
}

describe("board state-space bounds contract (F-001)", () => {
  it("the live Zod schema matches state-space-bounds.json field-for-field", () => {
    expect(extractBoundsFromZod()).toEqual(loadContract());
  });
});
