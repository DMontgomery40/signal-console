import { describe, expect, it } from "vitest";

import { parseStrictIsoTimestamp } from "../src/services/timestamps";

describe("parseStrictIsoTimestamp", () => {
  it("accepts real ISO timestamps and canonical date-only values", () => {
    expect(parseStrictIsoTimestamp("2026-02-28T23:59:59Z")).toBe(
      Date.parse("2026-02-28T23:59:59Z"),
    );
    expect(parseStrictIsoTimestamp("2024-02-29T00:00:00-06:00")).toBe(
      Date.parse("2024-02-29T00:00:00-06:00"),
    );
    expect(parseStrictIsoTimestamp("2026-05-23")).toBe(Date.parse("2026-05-23"));
  });

  it("rejects Date.parse rollover and timezone inference", () => {
    const invalid = [
      "2026-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-00-15T00:00:00Z",
      "2026-13-15T00:00:00Z",
      "2026-05-23T24:00:00Z",
      "2026-05-23T12:60:00Z",
      "2026-05-23T12:00:60Z",
      "2026-05-23T12:00:00",
      "not-a-date",
    ];

    for (const value of invalid) {
      expect(parseStrictIsoTimestamp(value)).toBeNull();
    }
  });

  it("can require explicit timezone-bearing instants", () => {
    expect(parseStrictIsoTimestamp("2026-05-23", { requireExplicitTimezone: true })).toBeNull();
    expect(parseStrictIsoTimestamp("2026-05-23T00:00:00Z", { requireExplicitTimezone: true })).toBe(
      Date.parse("2026-05-23T00:00:00Z"),
    );
  });
});
