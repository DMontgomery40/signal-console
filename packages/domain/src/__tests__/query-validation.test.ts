import { describe, expect, it } from "vitest";

import {
  boardAlertEventContextQuerySchema,
  boardAlertReplayQuerySchema,
  isStrictIsoTimestamp,
  isStrictYmdDate,
  researchDivergenceQuerySchema,
} from "../index";

describe("query validation contracts", () => {
  it("rejects impossible calendar dates", () => {
    expect(isStrictYmdDate("2026-04-21")).toBe(true);
    expect(isStrictYmdDate("2026-02-31")).toBe(false);
    expect(
      researchDivergenceQuerySchema.safeParse({ date: "2026-02-31" }).success
    ).toBe(false);
  });

  it("requires explicit timezone information for board-alert timestamps", () => {
    expect(isStrictIsoTimestamp("2026-04-21T23:56:00.000Z")).toBe(true);
    expect(isStrictIsoTimestamp("2026-04-21T23:56:00")).toBe(false);
    expect(
      boardAlertEventContextQuerySchema.safeParse({
        at: "2026-04-21T23:56:00",
        gameId: "nba-bos-nyk-2026-04-21",
      }).success
    ).toBe(false);
  });

  it("rejects replay windows that do not move forward in time", () => {
    expect(
      boardAlertReplayQuerySchema.safeParse({
        gameId: "nba-bos-nyk-2026-04-21",
        windowEnd: "2026-04-21T23:50:00.000Z",
        windowStart: "2026-04-21T23:56:00.000Z",
      }).success
    ).toBe(false);
  });
});
