import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listGameStateVolatilityAcrossGames } from "../board-anomaly-live-listings";
import { getPlayByPlayContext } from "../board-anomaly-play-by-play";
import {
  recordMarketMicrostructureEvent,
  recordGameStateObservation,
  recordNbaPlayByPlayActions,
  recordQuoteObservation,
  resetDatabase,
  upsertGame,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "../db";
import {
  getBoardAlertEventContext,
  listForensicFinishedGameIncidents,
  materializeBoardObservations,
} from "../index";

let tempDir = "";

function clampProbability(probability: number) {
  return Math.min(0.95, Math.max(0.05, probability));
}

function recordBoardVwQuoteHistory(input: {
  direction: 1 | -1;
  finalJump?: number;
  finalVolume?: number;
  lineRaw: number | null;
  sourceMarketId: string;
  startProbability: number;
}) {
  const baseMs = Date.parse("2026-05-20T01:25:05.000Z");
  let probability = input.startProbability;
  const quietJump = 0.004;
  const finalJump = input.finalJump ?? 0.12;
  const finalVolume = input.finalVolume ?? 550;

  recordQuoteObservation({
    bestAsk: probability + 0.01,
    bestBid: probability - 0.01,
    capturedAt: new Date(baseMs).toISOString(),
    depthScore: 80,
    heartbeatAfterMs: 60_000,
    impliedProbability: probability,
    lineRaw: input.lineRaw,
    oddsRaw: null,
    priceRaw: probability,
    sourceMarketId: input.sourceMarketId,
    volume: 8,
  });

  for (let minuteIndex = 1; minuteIndex <= 9; minuteIndex += 1) {
    const jump = minuteIndex === 9 ? finalJump : quietJump;
    probability = clampProbability(probability + jump * input.direction);
    recordQuoteObservation({
      bestAsk: Math.min(0.99, probability + 0.01),
      bestBid: Math.max(0.01, probability - 0.01),
      capturedAt: new Date(baseMs + minuteIndex * 60_000).toISOString(),
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: probability,
      lineRaw: input.lineRaw,
      oddsRaw: null,
      priceRaw: probability,
      sourceMarketId: input.sourceMarketId,
      volume: minuteIndex === 9 ? finalVolume : 8 + (minuteIndex % 3),
    });
  }
}

function recordBoardVwQuoteHistoryWithoutVolume(input: {
  direction: 1 | -1;
  lineRaw: number | null;
  sourceMarketId: string;
  startProbability: number;
}) {
  const baseMs = Date.parse("2026-05-20T01:25:05.000Z");
  let probability = input.startProbability;
  const quietJump = 0.004;

  recordQuoteObservation({
    bestAsk: probability + 0.01,
    bestBid: probability - 0.01,
    capturedAt: new Date(baseMs).toISOString(),
    depthScore: 80,
    heartbeatAfterMs: 60_000,
    impliedProbability: probability,
    lineRaw: input.lineRaw,
    oddsRaw: null,
    priceRaw: probability,
    sourceMarketId: input.sourceMarketId,
    volume: null,
  });

  for (let minuteIndex = 1; minuteIndex <= 9; minuteIndex += 1) {
    const jump = minuteIndex === 9 ? 0.12 : quietJump;
    probability = clampProbability(probability + jump * input.direction);
    recordQuoteObservation({
      bestAsk: Math.min(0.99, probability + 0.01),
      bestBid: Math.max(0.01, probability - 0.01),
      capturedAt: new Date(baseMs + minuteIndex * 60_000).toISOString(),
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: probability,
      lineRaw: input.lineRaw,
      oddsRaw: null,
      priceRaw: probability,
      sourceMarketId: input.sourceMarketId,
      volume: null,
    });
  }
}

function seedBoardReplayGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "NYK",
      key: "nyk",
      name: "New York Knicks",
      shortName: "Knicks",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "BOS",
      key: "bos",
      name: "Boston Celtics",
      shortName: "Celtics",
      side: "home",
    },
    id: "nba-board-replay-test",
    league: "NBA",
    scheduledStart: "2026-05-15T23:00:00.000Z",
    sourceGameKeyNba: "0022600999",
    sport: "basketball",
  });

  recordGameStateObservation({
    awayScore: 80,
    capturedAt: "2026-05-15T23:30:00.000Z",
    clock: "06:00",
    finalAt: null,
    gameId: "nba-board-replay-test",
    homeScore: 82,
    isFinal: false,
    period: 3,
    startedAt: "2026-05-15T23:05:00.000Z",
    status: "in-play",
  });

  upsertMarketInstrument({
    displayLabel: "Boston moneyline",
    family: "moneyline",
    gameId: "nba-board-replay-test",
    id: "bos-moneyline-board-replay",
    inPlay: true,
    line: null,
    participantKey: "bos",
    selection: "bos",
  });

  upsertSourceMarket({
    gameId: "nba-board-replay-test",
    id: "sm-board-replay-polymarket",
    instrumentId: "bos-moneyline-board-replay",
    mappingStatus: "auto",
    rawFamily: "moneyline",
    rawLabel: "BOS win",
    rawMetadata: { source: "polymarket" },
    source: "polymarket",
    sourceMarketKey: "poly-board-replay-bos-ml",
    sourceSelectionKey: "bos",
  });
}

describe("board anomaly repository", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-board-db-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes replay quotes from real price_raw moves while excluding heartbeats", () => {
    seedBoardReplayGame();

    recordQuoteObservation({
      bestAsk: 0.46,
      bestBid: 0.44,
      capturedAt: "2026-05-15T23:30:00.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: null,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.45,
      sourceMarketId: "sm-board-replay-polymarket",
      volume: 10,
    });

    recordQuoteObservation({
      bestAsk: 0.46,
      bestBid: 0.44,
      capturedAt: "2026-05-15T23:32:00.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: null,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.45,
      sourceMarketId: "sm-board-replay-polymarket",
      volume: 10,
    });

    recordQuoteObservation({
      bestAsk: 0.71,
      bestBid: 0.69,
      capturedAt: "2026-05-15T23:34:00.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: null,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.7,
      sourceMarketId: "sm-board-replay-polymarket",
      volume: 25,
    });

    const materialized = materializeBoardObservations({
      gameId: "nba-board-replay-test",
      windowStart: "2026-05-15T23:25:00.000Z",
      windowEnd: "2026-05-15T23:40:00.000Z",
    });

    expect(materialized?.observations).toHaveLength(2);
    expect(materialized?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flags: expect.objectContaining({ isHeartbeat: false }),
          impliedProbability: 0.45,
          previousImpliedProbability: null,
          source: "polymarket",
        }),
        expect.objectContaining({
          flags: expect.objectContaining({ isHeartbeat: false }),
          impliedProbability: 0.7,
          previousImpliedProbability: 0.45,
          source: "polymarket",
        }),
      ]),
    );
  });

  it("keeps calm live prediction-market quotes available for volatility measurement", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "NYK",
        key: "nyk",
        name: "New York Knicks",
        shortName: "Knicks",
        side: "home",
      },
      id: "nba-board-live-sample-test",
      league: "NBA",
      scheduledStart: "2026-05-20T00:00:00.000Z",
      sourceGameKeyNba: "0042500301",
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 50,
      capturedAt: "2026-05-20T01:25:00.000Z",
      clock: "PT10M27.00S",
      finalAt: null,
      gameId: "nba-board-live-sample-test",
      homeScore: 49,
      isFinal: false,
      period: 3,
      startedAt: "2026-05-20T00:00:00.000Z",
      status: "in-play",
    });

    const stableInstruments = [
      {
        displayLabel: "Cleveland moneyline",
        family: "moneyline" as const,
        id: "live-sample-moneyline",
        line: null,
        selection: "cle",
      },
      {
        displayLabel: "Cleveland -2.5",
        family: "spread" as const,
        id: "live-sample-spread",
        line: -2.5,
        selection: "cle",
      },
      {
        displayLabel: "Over 218.5",
        family: "total" as const,
        id: "live-sample-total",
        line: 218.5,
        selection: "over",
      },
    ];

    for (const instrument of stableInstruments) {
      upsertMarketInstrument({
        displayLabel: instrument.displayLabel,
        family: instrument.family,
        gameId: "nba-board-live-sample-test",
        id: instrument.id,
        inPlay: true,
        line: instrument.line,
        participantKey: null,
        selection: instrument.selection,
      });
      upsertSourceMarket({
        gameId: "nba-board-live-sample-test",
        id: `sm-${instrument.id}`,
        instrumentId: instrument.id,
        mappingStatus: "auto",
        rawFamily: instrument.family,
        rawLabel: instrument.displayLabel,
        rawMetadata: { source: "kalshi" },
        source: "kalshi",
        sourceMarketKey: `kalshi-${instrument.id}`,
        sourceSelectionKey: instrument.selection,
      });
      recordBoardVwQuoteHistory({
        direction: instrument.family === "spread" ? -1 : 1,
        finalJump: 0.002,
        finalVolume: 4,
        lineRaw: instrument.line,
        sourceMarketId: `sm-${instrument.id}`,
        startProbability:
          instrument.family === "moneyline" ? 0.58 : instrument.family === "spread" ? 0.46 : 0.55,
      });
    }

    const materialized = materializeBoardObservations({
      gameId: "nba-board-live-sample-test",
      windowStart: "2026-05-20T00:35:00.000Z",
      windowEnd: "2026-05-20T01:35:38.000Z",
    });

    expect(materialized?.observations).toHaveLength(30);
    expect(materialized?.observations.every((row) => row.sourceKind === "prediction-market")).toBe(
      true,
    );

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-live-sample-test"],
      limit: 5,
      now: "2026-05-20T01:35:38.000Z",
    });

    expect(measurements).toEqual([
      expect.objectContaining({
        band: "normal",
        gameId: "nba-board-live-sample-test",
        sample: expect.objectContaining({
          predictionMarketRows: 3,
          ready: true,
        }),
      }),
    ]);
  });

  it("prewarms board-volatility from scheduled pregame quote buckets without firing", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "SAS",
        key: "sas",
        name: "San Antonio Spurs",
        shortName: "Spurs",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "DAL",
        key: "dal",
        name: "Dallas Mavericks",
        shortName: "Mavericks",
        side: "home",
      },
      id: "nba-board-pregame-prewarm-test",
      league: "NBA",
      scheduledStart: "2026-05-20T01:45:00.000Z",
      sourceGameKeyNba: "0042500330",
      sport: "basketball",
    });
    upsertMarketInstrument({
      displayLabel: "San Antonio moneyline",
      family: "moneyline",
      gameId: "nba-board-pregame-prewarm-test",
      id: "pregame-prewarm-moneyline",
      inPlay: true,
      line: null,
      participantKey: "sas",
      selection: "sas",
    });
    upsertSourceMarket({
      gameId: "nba-board-pregame-prewarm-test",
      id: "sm-pregame-prewarm-moneyline",
      instrumentId: "pregame-prewarm-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Spurs win",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-pregame-prewarm-moneyline",
      sourceSelectionKey: "sas",
    });
    recordBoardVwQuoteHistory({
      direction: 1,
      finalJump: 0.002,
      finalVolume: 4,
      lineRaw: null,
      sourceMarketId: "sm-pregame-prewarm-moneyline",
      startProbability: 0.51,
    });
    recordQuoteObservation({
      bestAsk: 0.56,
      bestBid: 0.54,
      capturedAt: "2026-05-20T01:35:05.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.55,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.55,
      sourceMarketId: "sm-pregame-prewarm-moneyline",
      volume: 4,
    });

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-pregame-prewarm-test"],
      limit: 1,
      now: "2026-05-20T01:35:38.000Z",
    });

    expect(measurements[0]).toMatchObject({
      alertId: null,
      diagnostics: {
        detectorStatus: "prewarmed",
        materializedObservationRows: 11,
        rawQuoteRows: 11,
      },
      sample: {
        ready: true,
      },
    });
  });

  it("fires immediately near tip when pregame buckets already built the baseline", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "SAS",
        key: "sas",
        name: "San Antonio Spurs",
        shortName: "Spurs",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "DAL",
        key: "dal",
        name: "Dallas Mavericks",
        shortName: "Mavericks",
        side: "home",
      },
      id: "nba-board-near-tip-fire-test",
      league: "NBA",
      scheduledStart: "2026-05-20T01:35:00.000Z",
      sourceGameKeyNba: "0042500331",
      sport: "basketball",
    });
    upsertMarketInstrument({
      displayLabel: "San Antonio moneyline",
      family: "moneyline",
      gameId: "nba-board-near-tip-fire-test",
      id: "near-tip-fire-moneyline",
      inPlay: true,
      line: null,
      participantKey: "sas",
      selection: "sas",
    });
    upsertSourceMarket({
      gameId: "nba-board-near-tip-fire-test",
      id: "sm-near-tip-fire-moneyline",
      instrumentId: "near-tip-fire-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Spurs win",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-near-tip-fire-moneyline",
      sourceSelectionKey: "sas",
    });
    recordBoardVwQuoteHistory({
      direction: 1,
      finalJump: 0.22,
      finalVolume: 800,
      lineRaw: null,
      sourceMarketId: "sm-near-tip-fire-moneyline",
      startProbability: 0.51,
    });
    recordQuoteObservation({
      bestAsk: 0.96,
      bestBid: 0.94,
      capturedAt: "2026-05-20T01:35:05.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.95,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.95,
      sourceMarketId: "sm-near-tip-fire-moneyline",
      volume: 900,
    });

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-near-tip-fire-test"],
      limit: 1,
      now: "2026-05-20T01:35:38.000Z",
    });

    expect(measurements[0]).toMatchObject({
      diagnostics: {
        detectorStatus: "firing",
      },
      sample: {
        ready: true,
      },
    });
    expect(measurements[0]?.alertId).toMatch(/^board-alert:/);
  });

  it("diagnoses raw quotes that materialize into zero board observations", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "SAS",
        key: "sas",
        name: "San Antonio Spurs",
        shortName: "Spurs",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "DAL",
        key: "dal",
        name: "Dallas Mavericks",
        shortName: "Mavericks",
        side: "home",
      },
      id: "nba-board-materialized-zero-test",
      league: "NBA",
      scheduledStart: "2026-05-20T01:35:00.000Z",
      sourceGameKeyNba: "0042500332",
      sport: "basketball",
    });
    upsertMarketInstrument({
      displayLabel: "San Antonio moneyline",
      family: "moneyline",
      gameId: "nba-board-materialized-zero-test",
      id: "materialized-zero-moneyline",
      inPlay: true,
      line: null,
      participantKey: "sas",
      selection: "sas",
    });
    upsertSourceMarket({
      gameId: "nba-board-materialized-zero-test",
      id: "sm-materialized-zero-moneyline",
      instrumentId: "materialized-zero-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Spurs win",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "bet365-materialized-zero-moneyline",
      sourceSelectionKey: "sas",
    });
    recordQuoteObservation({
      bestAsk: 0.52,
      bestBid: 0.5,
      capturedAt: "2026-05-20T01:34:30.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.51,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.51,
      sourceMarketId: "sm-materialized-zero-moneyline",
      volume: 20,
    });

    const materialized = materializeBoardObservations({
      gameId: "nba-board-materialized-zero-test",
      windowStart: "2026-05-20T00:35:00.000Z",
      windowEnd: "2026-05-20T01:35:38.000Z",
    });
    expect(materialized?.diagnostics).toMatchObject({
      filteredReasonCounts: {
        "unchanged-sportsbook-quote": 1,
      },
      materializedObservationRows: 0,
      rawQuoteRows: 1,
    });

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-materialized-zero-test"],
      limit: 1,
      now: "2026-05-20T01:35:38.000Z",
    });
    expect(measurements[0]).toMatchObject({
      diagnostics: {
        detectorStatus: "degraded",
        materializedObservationRows: 0,
        rawQuoteRows: 1,
      },
      state: "insufficient-data",
    });
  });

  it("uses stored Kalshi volume metadata when the quote tick volume is missing", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "NYK",
        key: "nyk",
        name: "New York Knicks",
        shortName: "Knicks",
        side: "home",
      },
      id: "nba-board-stored-volume-test",
      league: "NBA",
      scheduledStart: "2026-05-20T00:00:00.000Z",
      sourceGameKeyNba: "0042500301",
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 50,
      capturedAt: "2026-05-20T01:25:00.000Z",
      clock: "PT10M27.00S",
      finalAt: null,
      gameId: "nba-board-stored-volume-test",
      homeScore: 49,
      isFinal: false,
      period: 3,
      startedAt: "2026-05-20T00:00:00.000Z",
      status: "in-play",
    });

    for (const instrument of [
      {
        displayLabel: "Cleveland moneyline",
        family: "moneyline" as const,
        id: "stored-vol-moneyline",
        line: null,
        selection: "cle",
      },
      {
        displayLabel: "Cleveland -2.5",
        family: "spread" as const,
        id: "stored-vol-spread",
        line: -2.5,
        selection: "cle",
      },
      {
        displayLabel: "Over 218.5",
        family: "total" as const,
        id: "stored-vol-total",
        line: 218.5,
        selection: "over",
      },
    ]) {
      upsertMarketInstrument({
        displayLabel: instrument.displayLabel,
        family: instrument.family,
        gameId: "nba-board-stored-volume-test",
        id: instrument.id,
        inPlay: true,
        line: instrument.line,
        participantKey: null,
        selection: instrument.selection,
      });
      upsertSourceMarket({
        gameId: "nba-board-stored-volume-test",
        id: `sm-${instrument.id}`,
        instrumentId: instrument.id,
        mappingStatus: "auto",
        rawFamily: instrument.family,
        rawLabel: instrument.displayLabel,
        rawMetadata: {
          quoteVolumeSource: "volume_fp",
          volumeFp: "2400.00",
          source: "kalshi",
        },
        source: "kalshi",
        sourceMarketKey: `kalshi-${instrument.id}`,
        sourceSelectionKey: instrument.selection,
      });
      recordBoardVwQuoteHistoryWithoutVolume({
        direction: instrument.family === "spread" ? -1 : 1,
        lineRaw: instrument.line,
        sourceMarketId: `sm-${instrument.id}`,
        startProbability:
          instrument.family === "moneyline" ? 0.58 : instrument.family === "spread" ? 0.46 : 0.55,
      });
    }

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-stored-volume-test"],
      limit: 5,
      now: "2026-05-20T01:35:38.000Z",
    });

    expect(measurements).toEqual([
      expect.objectContaining({
        band: "alert",
        gameId: "nba-board-stored-volume-test",
        sample: expect.objectContaining({
          predictionMarketRows: 3,
          ready: true,
        }),
        evidence: expect.arrayContaining([
          expect.objectContaining({
            reason: expect.stringContaining("log1p(stored vol 2400)"),
          }),
        ]),
      }),
    ]);
  });

  it("ranks ready board-volatility rows ahead of insufficient-data pregame rows", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "NYK",
        key: "nyk",
        name: "New York Knicks",
        shortName: "Knicks",
        side: "home",
      },
      id: "nba-board-live-priority-test",
      league: "NBA",
      scheduledStart: "2026-05-20T00:00:00.000Z",
      sourceGameKeyNba: "0042500301",
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 50,
      capturedAt: "2026-05-20T01:25:00.000Z",
      clock: "PT10M27.00S",
      finalAt: null,
      gameId: "nba-board-live-priority-test",
      homeScore: 49,
      isFinal: false,
      period: 3,
      startedAt: "2026-05-20T00:00:00.000Z",
      status: "in-play",
    });

    for (const instrument of [
      {
        displayLabel: "Cleveland moneyline",
        family: "moneyline" as const,
        id: "priority-moneyline",
        line: null,
        selection: "cle",
      },
      {
        displayLabel: "Cleveland -2.5",
        family: "spread" as const,
        id: "priority-spread",
        line: -2.5,
        selection: "cle",
      },
      {
        displayLabel: "Over 218.5",
        family: "total" as const,
        id: "priority-total",
        line: 218.5,
        selection: "over",
      },
    ]) {
      upsertMarketInstrument({
        displayLabel: instrument.displayLabel,
        family: instrument.family,
        gameId: "nba-board-live-priority-test",
        id: instrument.id,
        inPlay: true,
        line: instrument.line,
        participantKey: null,
        selection: instrument.selection,
      });
      upsertSourceMarket({
        gameId: "nba-board-live-priority-test",
        id: `sm-${instrument.id}`,
        instrumentId: instrument.id,
        mappingStatus: "auto",
        rawFamily: instrument.family,
        rawLabel: instrument.displayLabel,
        rawMetadata: { source: "kalshi" },
        source: "kalshi",
        sourceMarketKey: `kalshi-${instrument.id}`,
        sourceSelectionKey: instrument.selection,
      });
      recordBoardVwQuoteHistory({
        direction: instrument.family === "spread" ? -1 : 1,
        finalJump: 0.002,
        finalVolume: 4,
        lineRaw: instrument.line,
        sourceMarketId: `sm-${instrument.id}`,
        startProbability:
          instrument.family === "moneyline" ? 0.58 : instrument.family === "spread" ? 0.46 : 0.55,
      });
    }

    upsertGame({
      awayParticipant: {
        abbreviation: "OKC",
        key: "okc",
        name: "Oklahoma City Thunder",
        shortName: "Thunder",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "SAS",
        key: "sas",
        name: "San Antonio Spurs",
        shortName: "Spurs",
        side: "home",
      },
      id: "nba-board-pregame-insufficient-test",
      league: "NBA",
      scheduledStart: "2026-05-23T00:30:00.000Z",
      sourceGameKeyNba: "0042500313",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: 0,
      capturedAt: "2026-05-20T01:35:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-board-pregame-insufficient-test",
      homeScore: 0,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });
    upsertMarketInstrument({
      displayLabel: "Spurs moneyline",
      family: "moneyline",
      gameId: "nba-board-pregame-insufficient-test",
      id: "pregame-moneyline",
      inPlay: false,
      line: null,
      participantKey: "sas",
      selection: "sas",
    });
    upsertSourceMarket({
      gameId: "nba-board-pregame-insufficient-test",
      id: "sm-pregame-moneyline",
      instrumentId: "pregame-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Spurs win",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-pregame-moneyline",
      sourceSelectionKey: "sas",
    });
    recordQuoteObservation({
      bestAsk: 0.99,
      bestBid: 0.01,
      capturedAt: "2026-05-20T01:34:30.000Z",
      depthScore: 5,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.99,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.99,
      sourceMarketId: "sm-pregame-moneyline",
      volume: 25,
    });

    const measurements = listGameStateVolatilityAcrossGames({
      contextWindowMinutes: 60,
      gameIds: ["nba-board-pregame-insufficient-test", "nba-board-live-priority-test"],
      limit: 5,
      now: "2026-05-20T01:35:38.000Z",
    });

    expect(measurements[0]).toMatchObject({
      gameId: "nba-board-live-priority-test",
      sample: { ready: true },
    });
    expect(measurements[1]).toMatchObject({
      gameId: "nba-board-pregame-insufficient-test",
      score: 0,
      state: "insufficient-data",
    });
  });

  it("returns play-by-play context nearest to the anchor first", () => {
    seedBoardReplayGame();
    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-15T23:40:00.000Z",
      gameId: "nba-board-replay-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "rebound",
          clock: "PT09M00.00S",
          description: "old rebound",
          period: 3,
          teamTricode: "BOS",
          timeActual: "2026-05-15T23:30:00.000Z",
        },
        {
          actionNumber: 2,
          actionType: "rebound",
          clock: "PT05M00.00S",
          description: "nearest before",
          period: 3,
          teamTricode: "BOS",
          timeActual: "2026-05-15T23:35:50.000Z",
        },
        {
          actionNumber: 3,
          actionType: "made",
          clock: "PT04M58.00S",
          description: "nearest after",
          period: 3,
          teamTricode: "NYK",
          timeActual: "2026-05-15T23:36:10.000Z",
        },
      ],
    });

    const context = getBoardAlertEventContext({
      anchorAt: "2026-05-15T23:36:00.000Z",
      gameId: "nba-board-replay-test",
      limit: 3,
      windowSecondsAfter: 600,
      windowSecondsBefore: 600,
    });

    expect(context.playByPlay.map((row) => row.description)).toEqual([
      "nearest before",
      "nearest after",
      "old rebound",
    ]);
  });

  it("reports canonical prediction-market context by source, not only the trade slice", () => {
    seedBoardReplayGame();

    upsertSourceMarket({
      gameId: "nba-board-replay-test",
      id: "sm-board-replay-kalshi",
      instrumentId: "bos-moneyline-board-replay",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston moneyline",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kalshi-board-replay-bos-ml",
      sourceSelectionKey: "bos",
    });

    recordQuoteObservation({
      bestAsk: 0.63,
      bestBid: 0.61,
      capturedAt: "2026-05-15T23:35:40.000Z",
      depthScore: 75,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.62,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.62,
      sourceMarketId: "sm-board-replay-kalshi",
      volume: 40,
    });
    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-15T23:35:50.000Z",
      eventType: "trade",
      finalMarketVolume: 200,
      gameId: "nba-board-replay-test",
      instrumentId: "bos-moneyline-board-replay",
      notional: 90,
      previousPrice: 0.44,
      price: 0.62,
      rawMetadata: { transactionHash: "0xboardreplay" },
      size: 145,
      source: "polymarket",
      sourceMarketId: "sm-board-replay-polymarket",
      tradePrice: 0.62,
      volumeShare: 0.45,
    });

    const context = getBoardAlertEventContext({
      anchorAt: "2026-05-15T23:36:00.000Z",
      gameId: "nba-board-replay-test",
      limit: 5,
      windowSecondsAfter: 600,
      windowSecondsBefore: 600,
    });

    expect(context.predictionMarketContext.bySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "kalshi",
          quoteCount: 1,
          tradeCount: 0,
        }),
        expect.objectContaining({
          source: "polymarket",
          tradeCount: 1,
        }),
      ]),
    );
    expect(context.predictionMarketContext.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "quote",
          source: "kalshi",
        }),
        expect.objectContaining({
          kind: "trade",
          source: "polymarket",
        }),
      ]),
    );
  });

  it("resolves an exact historical participant incident from real event-context observations", () => {
    seedBoardReplayGame();

    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-15T23:36:20.000Z",
      gameId: "nba-board-replay-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "rebound",
          clock: "PT09M38.00S",
          description: "D. Wade rebound",
          period: 3,
          teamTricode: "BOS",
          timeActual: "2026-05-15T23:35:44.000Z",
        },
        {
          actionNumber: 2,
          actionType: "made",
          clock: "PT09M26.00S",
          description: "D. Wade putback",
          period: 3,
          teamTricode: "BOS",
          timeActual: "2026-05-15T23:35:56.000Z",
        },
      ],
    });

    upsertMarketInstrument({
      displayLabel: "Dean Wade rebounds over 1.5",
      family: "player-prop",
      gameId: "nba-board-replay-test",
      id: "dean-wade-rebounds-over-board-replay",
      inPlay: true,
      line: 1.5,
      participantKey: "dean-wade",
      selection: "over",
    });
    upsertMarketInstrument({
      displayLabel: "Dean Wade assists over 0.5",
      family: "player-prop",
      gameId: "nba-board-replay-test",
      id: "dean-wade-assists-over-board-replay",
      inPlay: true,
      line: 0.5,
      participantKey: "dean-wade",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-board-replay-test",
      id: "sm-board-replay-dean-wade-rebounds",
      instrumentId: "dean-wade-rebounds-over-board-replay",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Dean Wade rebounds over 1.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-board-replay-dean-wade-rebounds-over",
      sourceSelectionKey: "over",
    });
    upsertSourceMarket({
      gameId: "nba-board-replay-test",
      id: "sm-board-replay-dean-wade-assists",
      instrumentId: "dean-wade-assists-over-board-replay",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Dean Wade assists over 0.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-board-replay-dean-wade-assists-over",
      sourceSelectionKey: "over",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-15T23:35:50.000Z",
      eventType: "trade",
      finalMarketVolume: 175,
      gameId: "nba-board-replay-test",
      instrumentId: "dean-wade-rebounds-over-board-replay",
      notional: 118.79,
      previousPrice: 0.31,
      price: 0.99,
      rawMetadata: { transactionHash: "0xdeanrebound" },
      size: 119.99,
      source: "polymarket",
      sourceMarketId: "sm-board-replay-dean-wade-rebounds",
      tradePrice: 0.99,
      volumeShare: 0.68,
    });
    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-15T23:36:08.000Z",
      eventType: "trade",
      finalMarketVolume: 400,
      gameId: "nba-board-replay-test",
      instrumentId: "dean-wade-assists-over-board-replay",
      notional: 52.53,
      previousPrice: 0.43,
      price: 0.99,
      rawMetadata: { transactionHash: "0xdeanassist" },
      size: 53.06,
      source: "polymarket",
      sourceMarketId: "sm-board-replay-dean-wade-assists",
      tradePrice: 0.99,
      volumeShare: 0.13,
    });

    const context = getBoardAlertEventContext({
      alertId: "historic-participant:nba-board-replay-test:dean-wade:2026-05-15T23:35:50.000Z",
      anchorAt: "2026-05-15T23:35:50.000Z",
      gameId: "nba-board-replay-test",
      limit: 10,
      windowSecondsAfter: 600,
      windowSecondsBefore: 600,
    });

    expect(context.resolvedIncident).toEqual(
      expect.objectContaining({
        id: "historic-participant:nba-board-replay-test:dean-wade:2026-05-15T23:35:50.000Z",
        primaryEntityKey: "dean-wade",
        shockKind: "attribution-shaped",
      }),
    );
    expect(context.resolvedIncident?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Dean Wade rebounds over 1.5",
        }),
        expect.objectContaining({
          displayLabel: "Dean Wade assists over 0.5",
        }),
      ]),
    );
  });

  it("suppresses nearest play-by-play anchors when the closest NBA row is hours away", () => {
    seedBoardReplayGame();
    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-15T23:40:00.000Z",
      gameId: "nba-board-replay-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "period",
          clock: "PT12M00.00S",
          description: "period start",
          period: 1,
          teamTricode: null,
          timeActual: "2026-05-15T23:12:09.500Z",
        },
      ],
    });

    const context = getPlayByPlayContext("nba-board-replay-test", "2026-05-15T17:18:26.000Z");

    expect(context.available).toBe(true);
    expect(context.firstActionAt).toBe("2026-05-15T23:12:09.500Z");
    expect(context.nearestBefore).toBeNull();
    expect(context.nearestAfter).toBeNull();
  });

  it("builds a historic attribution-shaped incident from lower-share multi-family player-prop anomalies", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "DET",
        key: "det",
        name: "Detroit Pistons",
        shortName: "Pistons",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "home",
      },
      id: "nba-forensic-fanout-test",
      league: "NBA",
      scheduledStart: "2026-05-16T23:00:00.000Z",
      sport: "basketball",
    });

    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-16T23:08:00.000Z",
      gameId: "nba-forensic-fanout-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "period",
          clock: "PT12M00.00S",
          description: "Period Start",
          period: 1,
          teamTricode: null,
          timeActual: "2026-05-16T23:00:00.000Z",
        },
        {
          actionNumber: 2,
          actionType: "assist",
          clock: "PT10M12.00S",
          description: "Cade Cunningham assist",
          period: 1,
          teamTricode: "DET",
          timeActual: "2026-05-16T23:01:52.000Z",
        },
        {
          actionNumber: 3,
          actionType: "rebound",
          clock: "PT05M24.00S",
          description: "Cade Cunningham rebound",
          period: 1,
          teamTricode: "DET",
          timeActual: "2026-05-16T23:06:42.000Z",
        },
      ],
    });

    upsertMarketInstrument({
      displayLabel: "Cade Cunningham over 8.5 assists",
      family: "player-prop",
      gameId: "nba-forensic-fanout-test",
      id: "cade-assists-over",
      inPlay: true,
      line: 8.5,
      participantKey: "cade-cunningham",
      selection: "over",
    });
    upsertMarketInstrument({
      displayLabel: "Cade Cunningham over 5.5 rebounds",
      family: "player-prop",
      gameId: "nba-forensic-fanout-test",
      id: "cade-rebounds-over",
      inPlay: true,
      line: 5.5,
      participantKey: "cade-cunningham",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-forensic-fanout-test",
      id: "sm-cade-assists-over",
      instrumentId: "cade-assists-over",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Cade Cunningham over 8.5 assists",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-cade-assists-over",
      sourceSelectionKey: "over",
    });
    upsertSourceMarket({
      gameId: "nba-forensic-fanout-test",
      id: "sm-cade-rebounds-over",
      instrumentId: "cade-rebounds-over",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Cade Cunningham over 5.5 rebounds",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-cade-rebounds-over",
      sourceSelectionKey: "over",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-16T23:01:48.000Z",
      eventType: "trade",
      finalMarketVolume: 115.0,
      gameId: "nba-forensic-fanout-test",
      instrumentId: "cade-assists-over",
      notional: 30.0,
      previousPrice: 0.51,
      price: 0.51,
      rawMetadata: { transactionHash: "0xassists" },
      size: 30.0,
      source: "polymarket",
      sourceMarketId: "sm-cade-assists-over",
      tradePrice: 0.99,
      volumeShare: 30 / 115,
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-16T23:06:40.000Z",
      eventType: "trade",
      finalMarketVolume: 140.0,
      gameId: "nba-forensic-fanout-test",
      instrumentId: "cade-rebounds-over",
      notional: 24.5,
      previousPrice: 0.5,
      price: 0.5,
      rawMetadata: { transactionHash: "0xrebounds" },
      size: 25.0,
      source: "polymarket",
      sourceMarketId: "sm-cade-rebounds-over",
      tradePrice: 0.98,
      volumeShare: 25 / 140,
    });

    const incidents = listForensicFinishedGameIncidents({
      date: "2026-05-16",
      limit: 20,
      minGap: 0.15,
    });

    expect(incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gameId: "nba-forensic-fanout-test",
          primaryEntityKey: "cade cunningham",
          shockKind: "attribution-shaped",
        }),
      ]),
    );
  });

  it("builds a historical player-focused incident from multi-family quote shocks, not only trades", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "NYK",
        key: "nyk",
        name: "New York Knicks",
        shortName: "Knicks",
        side: "home",
      },
      id: "nba-forensic-quote-fanout-test",
      league: "NBA",
      scheduledStart: "2026-05-20T00:00:00.000Z",
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 18,
      capturedAt: "2026-05-20T00:17:00.000Z",
      clock: "PT05M12.00S",
      finalAt: null,
      gameId: "nba-forensic-quote-fanout-test",
      homeScore: 16,
      isFinal: false,
      period: 1,
      startedAt: "2026-05-20T00:00:00.000Z",
      status: "in-play",
    });

    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-20T00:18:00.000Z",
      gameId: "nba-forensic-quote-fanout-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "made",
          clock: "PT05M20.00S",
          description: "Dean Wade layup",
          period: 1,
          teamTricode: "CLE",
          timeActual: "2026-05-20T00:17:12.000Z",
        },
        {
          actionNumber: 2,
          actionType: "rebound",
          clock: "PT05M02.00S",
          description: "Dean Wade rebound",
          period: 1,
          teamTricode: "CLE",
          timeActual: "2026-05-20T00:17:30.000Z",
        },
      ],
    });

    upsertMarketInstrument({
      displayLabel: "Dean Wade assists over 0.5",
      family: "player-prop",
      gameId: "nba-forensic-quote-fanout-test",
      id: "dean-wade-assists-over",
      inPlay: true,
      line: 0.5,
      participantKey: "dean-wade",
      selection: "over",
    });
    upsertMarketInstrument({
      displayLabel: "Dean Wade rebounds over 1.5",
      family: "player-prop",
      gameId: "nba-forensic-quote-fanout-test",
      id: "dean-wade-rebounds-over",
      inPlay: true,
      line: 1.5,
      participantKey: "dean-wade",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-forensic-quote-fanout-test",
      id: "sm-dean-wade-assists-kalshi",
      instrumentId: "dean-wade-assists-over",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Dean Wade assists over 0.5",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kalshi-dean-wade-assists-over",
      sourceSelectionKey: "over",
    });
    upsertSourceMarket({
      gameId: "nba-forensic-quote-fanout-test",
      id: "sm-dean-wade-rebounds-poly",
      instrumentId: "dean-wade-rebounds-over",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Dean Wade rebounds over 1.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-dean-wade-rebounds-over",
      sourceSelectionKey: "over",
    });

    recordQuoteObservation({
      bestAsk: 0.46,
      bestBid: 0.44,
      capturedAt: "2026-05-20T00:16:48.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.45,
      lineRaw: 0.5,
      oddsRaw: null,
      priceRaw: 0.45,
      sourceMarketId: "sm-dean-wade-assists-kalshi",
      volume: 12,
    });
    recordQuoteObservation({
      bestAsk: 0.79,
      bestBid: 0.77,
      capturedAt: "2026-05-20T00:17:12.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.78,
      lineRaw: 0.5,
      oddsRaw: null,
      priceRaw: 0.78,
      sourceMarketId: "sm-dean-wade-assists-kalshi",
      volume: 30,
    });

    recordQuoteObservation({
      bestAsk: 0.43,
      bestBid: 0.41,
      capturedAt: "2026-05-20T00:16:54.000Z",
      depthScore: 75,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.42,
      lineRaw: 1.5,
      oddsRaw: null,
      priceRaw: 0.42,
      sourceMarketId: "sm-dean-wade-rebounds-poly",
      volume: 9,
    });
    recordQuoteObservation({
      bestAsk: 0.75,
      bestBid: 0.73,
      capturedAt: "2026-05-20T00:17:28.000Z",
      depthScore: 75,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.74,
      lineRaw: 1.5,
      oddsRaw: null,
      priceRaw: 0.74,
      sourceMarketId: "sm-dean-wade-rebounds-poly",
      volume: 18,
    });

    const incidents = listForensicFinishedGameIncidents({
      date: "2026-05-20",
      limit: 20,
      minGap: 0.15,
    });

    expect(incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gameId: "nba-forensic-quote-fanout-test",
          primaryEntityKey: "dean-wade",
          shockKind: "attribution-shaped",
        }),
      ]),
    );
  });

  it("does not build a historical player-focused incident when the trade burst is far from any NBA row", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "DET",
        key: "det",
        name: "Detroit Pistons",
        shortName: "Pistons",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "CLE",
        key: "cle",
        name: "Cleveland Cavaliers",
        shortName: "Cavaliers",
        side: "home",
      },
      id: "nba-forensic-fanout-pregame-test",
      league: "NBA",
      scheduledStart: "2026-05-16T23:00:00.000Z",
      sport: "basketball",
    });

    recordNbaPlayByPlayActions({
      capturedAt: "2026-05-16T23:20:00.000Z",
      gameId: "nba-forensic-fanout-pregame-test",
      actions: [
        {
          actionNumber: 1,
          actionType: "period",
          clock: "PT12M00.00S",
          description: "Period Start",
          period: 1,
          teamTricode: null,
          timeActual: "2026-05-16T23:12:09.500Z",
        },
      ],
    });

    upsertMarketInstrument({
      displayLabel: "Cade Cunningham over 8.5 assists",
      family: "player-prop",
      gameId: "nba-forensic-fanout-pregame-test",
      id: "pregame-cade-assists-over",
      inPlay: true,
      line: 8.5,
      participantKey: "cade-cunningham",
      selection: "over",
    });
    upsertMarketInstrument({
      displayLabel: "Cade Cunningham over 5.5 rebounds",
      family: "player-prop",
      gameId: "nba-forensic-fanout-pregame-test",
      id: "pregame-cade-rebounds-over",
      inPlay: true,
      line: 5.5,
      participantKey: "cade-cunningham",
      selection: "over",
    });
    upsertSourceMarket({
      gameId: "nba-forensic-fanout-pregame-test",
      id: "sm-pregame-cade-assists-over",
      instrumentId: "pregame-cade-assists-over",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Cade Cunningham over 8.5 assists",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-pregame-cade-assists-over",
      sourceSelectionKey: "over",
    });
    upsertSourceMarket({
      gameId: "nba-forensic-fanout-pregame-test",
      id: "sm-pregame-cade-rebounds-over",
      instrumentId: "pregame-cade-rebounds-over",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Cade Cunningham over 5.5 rebounds",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-pregame-cade-rebounds-over",
      sourceSelectionKey: "over",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-16T02:01:48.000Z",
      eventType: "trade",
      finalMarketVolume: 115.0,
      gameId: "nba-forensic-fanout-pregame-test",
      instrumentId: "pregame-cade-assists-over",
      notional: 30.0,
      previousPrice: 0.51,
      price: 0.51,
      rawMetadata: { transactionHash: "0xpregame-assists" },
      size: 30.0,
      source: "polymarket",
      sourceMarketId: "sm-pregame-cade-assists-over",
      tradePrice: 0.99,
      volumeShare: 30 / 115,
    });
    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-05-16T02:06:40.000Z",
      eventType: "trade",
      finalMarketVolume: 140.0,
      gameId: "nba-forensic-fanout-pregame-test",
      instrumentId: "pregame-cade-rebounds-over",
      notional: 24.5,
      previousPrice: 0.5,
      price: 0.5,
      rawMetadata: { transactionHash: "0xpregame-rebounds" },
      size: 25.0,
      source: "polymarket",
      sourceMarketId: "sm-pregame-cade-rebounds-over",
      tradePrice: 0.98,
      volumeShare: 25 / 140,
    });

    const incidents = listForensicFinishedGameIncidents({
      date: "2026-05-16",
      limit: 20,
      minGap: 0.15,
    });

    expect(
      incidents.find(
        (incident) =>
          incident.primaryEntityKey === "cade cunningham" &&
          incident.shockKind === "attribution-shaped",
      ),
    ).toBeUndefined();
  });
});
