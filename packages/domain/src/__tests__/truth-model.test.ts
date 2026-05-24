import { describe, expect, it } from "vitest";

import {
  classifyGameLifecycle,
  classifyMarketSignal,
  hasBet365PlusPredictionMarket,
  scheduledScoreGraceMs,
} from "../truth-model";

const now = new Date("2026-05-12T14:00:00.000Z");

describe("truth model", () => {
  it("does not call future scheduled games stale just because the schedule row is old", () => {
    expect(
      classifyGameLifecycle(
        {
          gameState: {
            capturedAt: "2026-05-10T14:00:00.000Z",
            isFinal: false,
            status: "scheduled",
          },
          scheduledStart: "2026-05-13T02:30:00.000Z",
        },
        now
      )
    ).toMatchObject({
      kind: "scheduled",
      label: "Scheduled",
      tone: "neutral",
    });
  });

  it("distinguishes missing score updates from missing final confirmation", () => {
    expect(
      classifyGameLifecycle(
        {
          gameState: {
            capturedAt: "2026-05-12T13:00:00.000Z",
            isFinal: false,
            status: "scheduled",
          },
          scheduledStart: "2026-05-12T13:45:00.000Z",
        },
        now
      )
    ).toMatchObject({
      kind: "missing-fresh-score-state",
      label: "Score update missing",
      tone: "critical",
    });

    expect(
      classifyGameLifecycle(
        {
          gameState: {
            capturedAt: "2026-05-12T03:00:00.000Z",
            isFinal: false,
            status: "in-play",
          },
          scheduledStart: "2026-05-12T03:00:00.000Z",
        },
        now
      )
    ).toMatchObject({
      kind: "missing-fresh-score-state",
      label: "Score update missing",
      tone: "critical",
    });

    expect(
      classifyGameLifecycle(
        {
          gameState: {
            capturedAt: "2026-05-12T09:30:00.000Z",
            isFinal: false,
            status: "scheduled",
          },
          scheduledStart: "2026-05-12T09:30:00.000Z",
        },
        now
      )
    ).toMatchObject({
      kind: "missing-final-confirmation",
      label: "Final confirmation missing",
      tone: "warning",
    });
  });

  it("keeps scheduled games neutral until the post-tip grace window expires", () => {
    const cases = [
      {
        expected: { kind: "scheduled", label: "Scheduled", tone: "neutral" },
        scheduledStart: "2026-05-12T14:15:00.000Z",
      },
      {
        expected: { kind: "scheduled", label: "Scheduled", tone: "neutral" },
        scheduledStart: new Date(
          now.getTime() - scheduledScoreGraceMs + 60_000
        ).toISOString(),
      },
      {
        expected: {
          kind: "missing-fresh-score-state",
          label: "Score update missing",
          tone: "critical",
        },
        scheduledStart: new Date(
          now.getTime() - scheduledScoreGraceMs - 60_000
        ).toISOString(),
      },
    ];

    for (const testCase of cases) {
      expect(
        classifyGameLifecycle(
          {
            gameState: {
              capturedAt: "2026-05-12T13:00:00.000Z",
              isFinal: false,
              status: "scheduled",
            },
            scheduledStart: testCase.scheduledStart,
          },
          now
        )
      ).toMatchObject(testCase.expected);
    }
  });

  it("keeps fresh in-play state live even when the scheduled start is old", () => {
    expect(
      classifyGameLifecycle(
        {
          gameState: {
            capturedAt: "2026-05-12T13:59:00.000Z",
            isFinal: false,
            status: "in-play",
          },
          scheduledStart: "2026-05-12T09:30:00.000Z",
        },
        now
      )
    ).toMatchObject({
      kind: "live",
      label: "Live",
      tone: "live",
    });
  });

  it("prevents final games from being classified as live market signals", () => {
    expect(
      classifyMarketSignal(
        {
          gameLifecycle: { kind: "final" },
          latestSources: [
            {
              capturedAt: "2026-05-12T13:59:30.000Z",
              impliedProbability: 0.71,
              source: "bet365",
            },
            {
              capturedAt: "2026-05-12T13:59:35.000Z",
              impliedProbability: 0.49,
              source: "kalshi",
            },
          ],
          requireBet365PlusPredictionMarket: true,
        },
        now
      )
    ).toMatchObject({
      label: "Past comparison",
      state: "historical",
    });
  });

  it("does not compare latest-per-source quotes when their capture times are far apart", () => {
    expect(
      classifyMarketSignal(
        {
          gameLifecycle: { kind: "final" },
          latestSources: [
            {
              capturedAt: "2026-05-10T23:09:15.934Z",
              impliedProbability: 0.714,
              source: "bet365",
            },
            {
              capturedAt: "2026-05-12T07:30:23.373Z",
              impliedProbability: 0.03,
              source: "kalshi",
            },
          ],
          requireBet365PlusPredictionMarket: true,
        },
        now
      )
    ).toMatchObject({
      label: "No comparison yet",
      state: "invalid",
    });
  });

  it("requires Bet365 plus at least one prediction market for player-prop actionability", () => {
    expect(hasBet365PlusPredictionMarket(["bet365"])).toBe(false);
    expect(hasBet365PlusPredictionMarket(["kalshi", "polymarket"])).toBe(false);
    expect(hasBet365PlusPredictionMarket(["bet365", "polymarket"])).toBe(true);

    expect(
      classifyMarketSignal(
        {
          gameLifecycle: { kind: "live" },
          latestSources: [
            {
              capturedAt: "2026-05-12T13:59:30.000Z",
              impliedProbability: 0.71,
              source: "bet365",
            },
          ],
          requireBet365PlusPredictionMarket: true,
        },
        now
      )
    ).toMatchObject({
      label: "Not actionable",
      state: "invalid",
    });
  });
});
