import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendHistoricalTick,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
  upsertGameOutcome,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "../db";
import {
  getInstrumentDeltaSeries,
  getLeadLagSeries,
  getSignalQualityReport,
  getSourceLeadLagReport,
  listClosedGameSummaries,
  summarizeDeltaSeries,
} from "../signal-quality";

let tempDir = "";

function seedClosedGameWithCrossSource() {
  upsertGame({
    awayParticipant: {
      abbreviation: "HOU",
      key: "hou",
      name: "Houston Rockets",
      shortName: "Rockets",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "LAL",
      key: "lal",
      name: "Los Angeles Lakers",
      shortName: "Lakers",
      side: "home",
    },
    id: "nba-g1",
    league: "NBA",
    scheduledStart: "2026-04-22T02:00:00.000Z",
    sourceGameKeyNba: "g1",
    sport: "basketball",
  });
  recordGameStateObservation({
    awayScore: 94,
    capturedAt: "2026-04-22T05:00:00.000Z",
    clock: null,
    finalAt: "2026-04-22T04:30:00.000Z",
    gameId: "nba-g1",
    homeScore: 101,
    isFinal: true,
    period: 4,
    startedAt: "2026-04-22T02:10:00.000Z",
    status: "final",
  });
  upsertGameOutcome({
    capturedAt: "2026-04-22T05:00:00.000Z",
    finalAwayScore: 94,
    finalHomeScore: 101,
    gameId: "nba-g1",
    winnerKey: "lal",
  });

  const instrumentLal = "nba-g1-moneyline-lal";
  const instrumentHou = "nba-g1-moneyline-hou";
  upsertMarketInstrument({
    displayLabel: "Lakers moneyline",
    family: "moneyline",
    gameId: "nba-g1",
    id: instrumentLal,
    inPlay: false,
    line: null,
    participantKey: "lal",
    selection: "lal",
  });
  upsertMarketInstrument({
    displayLabel: "Rockets moneyline",
    family: "moneyline",
    gameId: "nba-g1",
    id: instrumentHou,
    inPlay: false,
    line: null,
    participantKey: "hou",
    selection: "hou",
  });

  const sources = [
    { source: "kalshi", suffix: "kalshi" },
    { source: "polymarket", suffix: "polymarket" },
  ] as const;

  for (const { source, suffix } of sources) {
    for (const [instrumentId, participantKey, baseP, drift] of [
      [instrumentLal, "lal", 0.35, 0.65],
      [instrumentHou, "hou", 0.65, -0.65],
    ] as const) {
      const sourceMarketId = `${suffix}-${participantKey}-${instrumentId}`;
      upsertSourceMarket({
        gameId: "nba-g1",
        id: sourceMarketId,
        instrumentId,
        mappingStatus: "auto",
        rawFamily: "moneyline",
        rawLabel: participantKey,
        source,
        sourceMarketKey: `${suffix}-${participantKey}`,
        sourceSelectionKey: participantKey,
      });

      for (let minute = 0; minute < 30; minute += 1) {
        const ts = new Date(
          Date.parse("2026-04-22T01:00:00.000Z") + minute * 60_000
        ).toISOString();
        const p = baseP + (drift * minute) / 29;
        appendHistoricalTick({
          bestAsk: null,
          bestBid: null,
          capturedAt: ts,
          depthScore: null,
          impliedProbability: Math.min(0.999, Math.max(0.001, p)),
          lineRaw: null,
          oddsRaw: null,
          priceRaw: Math.min(0.999, Math.max(0.001, p)),
          sourceMarketId,
          volume: null,
        });
      }

      appendHistoricalTick({
        bestAsk: null,
        bestBid: null,
        capturedAt: "2026-04-22T05:30:00.000Z",
        depthScore: null,
        impliedProbability: participantKey === "lal" ? 1 : 0,
        lineRaw: null,
        oddsRaw: null,
        priceRaw: participantKey === "lal" ? 1 : 0,
        sourceMarketId,
        volume: null,
      });
    }
  }
}

describe("signal quality analytics", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-sq-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  });

  it("returns pregame closing prices that exclude post-settlement ticks", () => {
    seedClosedGameWithCrossSource();

    const summaries = listClosedGameSummaries({ closingCutoff: "pregame" });
    expect(summaries).toHaveLength(1);
    const game = summaries[0];
    const lal = game.moneylineByParticipant.find(
      (i) => i.participantKey === "lal"
    );
    expect(lal?.outcome.winnerProbability).toBe(1);
    for (const source of lal?.sources ?? []) {
      expect(source.impliedProbability).not.toBe(1);
      expect((source.capturedAt ?? "") <= "2026-04-22T02:00:00.000Z").toBe(
        true
      );
    }
  });

  it("live-final cutoff includes ticks up to the captured final_at", () => {
    seedClosedGameWithCrossSource();
    const summaries = listClosedGameSummaries({ closingCutoff: "live-final" });
    const lal = summaries[0].moneylineByParticipant.find(
      (i) => i.participantKey === "lal"
    );
    expect(lal).toBeDefined();
    expect(lal?.sources.every((s) => s.capturedAt != null)).toBe(true);
  });

  it("computes a signal quality report with brier and log loss", () => {
    seedClosedGameWithCrossSource();
    const report = getSignalQualityReport({ closingCutoff: "pregame" });
    expect(report.sampleCount).toBeGreaterThan(0);
    for (const source of report.perSource) {
      expect(source.sampleCount).toBe(2);
      expect(source.brier).toBeGreaterThanOrEqual(0);
      expect(source.brier).toBeLessThan(1);
      expect(source.logLoss).toBeGreaterThan(0);
      // Slope requires >= 10 samples; this fixture has only 2 per source.
      expect(source.calibrationSlope).toBeNull();
      expect(source.calibrationIntercept).toBeNull();
    }
  });

  it("builds a minute-bucket delta series with per-source values", () => {
    seedClosedGameWithCrossSource();
    const series = getInstrumentDeltaSeries({
      bucketSeconds: 60,
      instrumentId: "nba-g1-moneyline-lal",
    });
    expect(series.length).toBeGreaterThan(10);
    const overlapping = series.filter(
      (point) =>
        point.perSource.kalshi != null && point.perSource.polymarket != null
    );
    expect(overlapping.length).toBeGreaterThan(5);
  });

  it("does not carry above-threshold duration across an overnight comparison gap", () => {
    const summary = summarizeDeltaSeries([
      {
        absoluteDelta: 0.68,
        bet365Probability: 0.71,
        bucketAt: "2026-05-10T23:09:00.000Z",
        externalAverage: 0.03,
        perSource: { bet365: 0.71, kalshi: 0.03 },
        signedDelta: -0.68,
      },
      {
        absoluteDelta: 0.67,
        bet365Probability: 0.72,
        bucketAt: "2026-05-12T07:30:00.000Z",
        externalAverage: 0.05,
        perSource: { bet365: 0.72, kalshi: 0.05 },
        signedDelta: -0.67,
      },
    ]);

    expect(summary?.maxGap).toBe(0.68);
    expect(summary?.aboveThresholdDurationMs).toBe(60_000);
  });

  it("reports lead-lag correlation between sources", () => {
    seedClosedGameWithCrossSource();
    const report = getSourceLeadLagReport({
      bucketSeconds: 60,
      instrumentId: "nba-g1-moneyline-lal",
      maxLagBuckets: 5,
    });
    expect(report.insufficientData).toBe(false);
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0].pair.sort()).toEqual(["kalshi", "polymarket"]);
    expect(report.pairs[0].bestCorrelation).toBeGreaterThan(0.9);
  });

  it("produces a rolling lead/lag series with histogram buckets", () => {
    seedClosedGameWithCrossSource();
    const series = getLeadLagSeries({
      bucketSeconds: 60,
      instrumentId: "nba-g1-moneyline-lal",
      maxLagBuckets: 3,
      windowBuckets: 14,
    });
    expect(series.insufficientData).toBe(false);
    expect(series.primaryPair).not.toBeNull();
    expect(series.overall).not.toBeNull();
    expect(series.overall?.bestCorrelation).toBeGreaterThan(0.9);
    expect(series.offsetSeries.length).toBeGreaterThan(0);
    const valid = series.offsetSeries.filter((pt) => pt.lagBuckets != null);
    expect(valid.length).toBeGreaterThan(0);
    // Histogram bucket counts must sum to the number of valid rolling windows.
    const histSum = series.offsetHistogram.reduce(
      (sum, bin) => sum + bin.count,
      0
    );
    expect(histSum).toBe(valid.length);
    // Each histogram entry must point back to a lag observed in the series.
    for (const bin of series.offsetHistogram) {
      expect(valid.some((pt) => pt.lagBuckets === bin.lagBuckets)).toBe(true);
    }
  });
});
