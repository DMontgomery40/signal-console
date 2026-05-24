import { describe, expect, it } from "vitest";

import type {
  BoardObservation,
  BoardObservationFlags,
  BoardObservationMissing,
} from "@signal-console/domain";

import {
  detectBoardAnomalies,
  measureBoardGameStateVolatility,
  replayBoardAnomalies,
} from "../board-anomaly";

function logit(probability: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, probability));
  return Math.log(clamped / (1 - clamped));
}

function clampProbability(probability: number) {
  return Math.min(0.95, Math.max(0.05, probability));
}

function defaultFlags(
  overrides: Partial<BoardObservationFlags> = {}
): BoardObservationFlags {
  return {
    isUnmapped: false,
    isHeartbeat: false,
    isSuspended: false,
    isStale: false,
    ...overrides,
  };
}

function defaultMissing(
  overrides: Partial<BoardObservationMissing> = {}
): BoardObservationMissing {
  return {
    impliedProbability: false,
    line: true,
    bestBid: true,
    bestAsk: true,
    volume: true,
    depthScore: true,
    tradePrice: true,
    tradeSize: true,
    participantKey: false,
    ...overrides,
  };
}

type ObservationOverrides = Omit<
  Partial<BoardObservation>,
  "flags" | "missing"
> & {
  flags?: Partial<BoardObservationFlags>;
  missing?: Partial<BoardObservationMissing>;
};

function makeObservation(
  observationId: string,
  overrides: ObservationOverrides = {}
): BoardObservation {
  const baseTimestamp = "2026-05-15T20:00:00.000Z";
  return {
    observationId,
    gameId: "game-1",
    source: "polymarket",
    sourceKind: "prediction-market",
    sourceMarketId: `sm-${observationId}`,
    instrumentId: `instr-${observationId}`,
    family: "moneyline",
    selection: "team-a",
    participantKey: null,
    line: null,
    mappingStatus: "auto",
    displayLabel: `Observation ${observationId}`,
    labels: {
      rawFamily: null,
      rawLabel: null,
      normalizedTokens: [],
      participantHints: [],
      statFamilyHints: [],
    },
    eventTimestamp: baseTimestamp,
    capturedAt: baseTimestamp,
    quoteAgeMs: 0,
    impliedProbability: 0.5,
    previousImpliedProbability: 0.5,
    priceMove: 0,
    lineMove: 0,
    logitMove: 0,
    bestBid: null,
    bestAsk: null,
    spread: null,
    depthScore: null,
    volume: null,
    tradePrice: null,
    tradeSize: null,
    notional: null,
    volumeShare: null,
    finalMarketVolume: null,
    ...overrides,
    flags: defaultFlags(overrides.flags ?? {}),
    missing: defaultMissing(overrides.missing ?? {}),
    gameState: overrides.gameState ?? {
      status: "in-play",
      period: 3,
      clock: "07:32",
      homeScore: 65,
      awayScore: 60,
      scoreMargin: 5,
      minutesToTip: null,
    },
  };
}

function attributionFanout(): BoardObservation[] {
  const baseTs = Date.parse("2026-05-15T20:00:00.000Z");
  const ts = (offsetSec: number) =>
    new Date(baseTs + offsetSec * 1000).toISOString();

  const previousProbability = 0.5;
  const newProbability = 0.74;
  const logitMove = logit(newProbability) - logit(previousProbability);

  return [
    makeObservation("attribution-poly-points-over", {
      source: "polymarket",
      sourceKind: "prediction-market",
      family: "player-prop",
      participantKey: "cade-cunningham",
      selection: "over",
      line: 24.5,
      impliedProbability: newProbability,
      previousImpliedProbability: previousProbability,
      logitMove,
      tradePrice: 0.86,
      tradeSize: 1500,
      volumeShare: 0.32,
      finalMarketVolume: 4700,
      displayLabel: "Cade Cunningham Over 24.5 Pts",
      labels: {
        rawFamily: "player-prop",
        rawLabel: "Cade Cunningham Over 24.5 Points",
        normalizedTokens: ["cade", "cunningham", "points"],
        participantHints: ["cade-cunningham"],
        statFamilyHints: ["points"],
      },
      eventTimestamp: ts(10),
      capturedAt: ts(10),
    }),
    makeObservation("attribution-kalshi-pra-over", {
      source: "kalshi",
      sourceKind: "prediction-market",
      family: "player-prop",
      participantKey: "cade-cunningham",
      selection: "over",
      line: 36.5,
      impliedProbability: newProbability,
      previousImpliedProbability: previousProbability,
      logitMove,
      tradePrice: 0.82,
      tradeSize: 800,
      volumeShare: 0.21,
      finalMarketVolume: 3800,
      displayLabel: "Cade Cunningham Over 36.5 PRA",
      labels: {
        rawFamily: "player-prop",
        rawLabel: "Cade Cunningham Over 36.5 PRA",
        normalizedTokens: ["cade", "cunningham", "pra"],
        participantHints: ["cade-cunningham"],
        statFamilyHints: ["pra"],
      },
      eventTimestamp: ts(20),
      capturedAt: ts(20),
    }),
    makeObservation("attribution-bet365-points-line", {
      source: "bet365",
      sourceKind: "sportsbook",
      family: "player-prop",
      participantKey: "cade-cunningham",
      selection: "over",
      line: 24.5,
      impliedProbability: 0.7,
      previousImpliedProbability: 0.5,
      logitMove: logit(0.7) - logit(0.5),
      lineMove: 1.5,
      displayLabel: "Cade Cunningham Over 24.5 Pts (Bet365)",
      labels: {
        rawFamily: "player-prop",
        rawLabel: "Cade Cunningham points over 24.5",
        normalizedTokens: ["cade", "cunningham", "points"],
        participantHints: ["cade-cunningham"],
        statFamilyHints: ["points"],
      },
      eventTimestamp: ts(30),
      capturedAt: ts(30),
      missing: { line: false },
    }),
    makeObservation("attribution-poly-team-total", {
      source: "polymarket",
      sourceKind: "prediction-market",
      family: "team-prop",
      participantKey: null,
      selection: "over",
      line: 112.5,
      impliedProbability: 0.66,
      previousImpliedProbability: 0.52,
      logitMove: logit(0.66) - logit(0.52),
      tradePrice: 0.71,
      tradeSize: 600,
      volumeShare: 0.18,
      finalMarketVolume: 3000,
      displayLabel: "Pistons Team Total Over 112.5",
      labels: {
        rawFamily: "team-prop",
        rawLabel: "Pistons team total over 112.5",
        normalizedTokens: ["pistons", "team", "total"],
        participantHints: [],
        statFamilyHints: ["team-total"],
      },
      eventTimestamp: ts(40),
      capturedAt: ts(40),
    }),
  ];
}

function gameStateVolatilityFanout(options?: {
  finalJump?: number;
  finalVolume?: number;
  quietJump?: number;
  quietVolume?: number;
}): BoardObservation[] {
  const baseTs = Date.parse("2026-05-15T19:51:05.000Z");
  const ts = (minuteOffset: number) =>
    new Date(baseTs + minuteOffset * 60_000).toISOString();
  const gameState = {
    status: "in-play" as const,
    period: 2,
    clock: "04:18",
    homeScore: 51,
    awayScore: 39,
    scoreMargin: 12,
    minutesToTip: null,
  };
  const quietJump = options?.quietJump ?? 0.004;
  const quietVolume = options?.quietVolume ?? 8;
  const finalJump = options?.finalJump ?? 0.12;
  const finalVolume = options?.finalVolume ?? 550;
  const makeMove = (from: number, to: number) => logit(to) - logit(from);

  const markets = [
    {
      family: "moneyline" as const,
      id: "game-vol-kalshi-moneyline",
      labels: {
        rawFamily: "moneyline",
        rawLabel: "Cavaliers to win",
        normalizedTokens: ["cavaliers", "win"],
        participantHints: [],
        statFamilyHints: [],
      },
      line: null,
      participantKey: null,
      selection: "cavaliers",
      source: "kalshi" as const,
      startProbability: 0.58,
      direction: 1,
      displayLabel: "Cavaliers win",
    },
    {
      family: "spread" as const,
      id: "game-vol-poly-spread",
      labels: {
        rawFamily: "spread",
        rawLabel: "Pistons +7.5",
        normalizedTokens: ["pistons", "spread"],
        participantHints: [],
        statFamilyHints: [],
      },
      line: 7.5,
      participantKey: null,
      selection: "pistons-plus",
      source: "polymarket" as const,
      startProbability: 0.46,
      direction: -1,
      displayLabel: "Pistons +7.5",
    },
    {
      family: "total" as const,
      id: "game-vol-kalshi-total",
      labels: {
        rawFamily: "total",
        rawLabel: "Total over 214.5",
        normalizedTokens: ["total", "over"],
        participantHints: [],
        statFamilyHints: [],
      },
      line: 214.5,
      participantKey: null,
      selection: "over",
      source: "kalshi" as const,
      startProbability: 0.55,
      direction: 1,
      displayLabel: "Total over 214.5",
    },
    {
      family: "team-prop" as const,
      id: "game-vol-poly-team-total",
      labels: {
        rawFamily: "team-prop",
        rawLabel: "Cavaliers team total over 111.5",
        normalizedTokens: ["cavaliers", "team", "total"],
        participantHints: [],
        statFamilyHints: ["team-total"],
      },
      line: 111.5,
      participantKey: null,
      selection: "over",
      source: "polymarket" as const,
      startProbability: 0.53,
      direction: 1,
      displayLabel: "Cavaliers team total over 111.5",
    },
    {
      family: "player-prop" as const,
      id: "game-vol-kalshi-player-prop",
      labels: {
        rawFamily: "player-prop",
        rawLabel: "Donovan Mitchell Over 29.5 Points",
        normalizedTokens: ["donovan", "mitchell", "points"],
        participantHints: ["donovan-mitchell"],
        statFamilyHints: ["points"],
      },
      line: 29.5,
      participantKey: "donovan-mitchell",
      selection: "over",
      source: "kalshi" as const,
      startProbability: 0.54,
      direction: 1,
      displayLabel: "Donovan Mitchell Over 29.5 Points",
    },
  ];

  return markets.flatMap((market, marketIndex) => {
    const rows: BoardObservation[] = [];
    let previousProbability = market.startProbability;
    rows.push(
      makeObservation(`${market.id}-seed`, {
        source: market.source,
        sourceKind: "prediction-market",
        sourceMarketId: `sm-${market.id}`,
        instrumentId: `instr-${market.id}`,
        family: market.family,
        participantKey: market.participantKey,
        selection: market.selection,
        line: market.line,
        impliedProbability: previousProbability,
        previousImpliedProbability: null,
        logitMove: 0,
        volume: quietVolume,
        displayLabel: market.displayLabel,
        labels: market.labels,
        gameState,
        eventTimestamp: ts(0),
        capturedAt: ts(0),
        missing: { line: market.line == null, volume: false },
      })
    );

    for (let minuteIndex = 1; minuteIndex <= 9; minuteIndex += 1) {
      const isFinalBucket = minuteIndex === 9;
      const jumpMagnitude = isFinalBucket ? finalJump : quietJump;
      const nextProbability = clampProbability(
        previousProbability + jumpMagnitude * market.direction
      );
      const volume = isFinalBucket
        ? finalVolume
        : quietVolume + ((minuteIndex + marketIndex) % 3);
      rows.push(
        makeObservation(`${market.id}-${minuteIndex}`, {
          source: market.source,
          sourceKind: "prediction-market",
          sourceMarketId: `sm-${market.id}`,
          instrumentId: `instr-${market.id}`,
          family: market.family,
          participantKey: market.participantKey,
          selection: market.selection,
          line: market.line,
          impliedProbability: nextProbability,
          previousImpliedProbability: previousProbability,
          logitMove: makeMove(previousProbability, nextProbability),
          volume,
          displayLabel: market.displayLabel,
          labels: market.labels,
          gameState,
          eventTimestamp: ts(minuteIndex),
          capturedAt: ts(minuteIndex),
          missing: { line: market.line == null, volume: false },
        })
      );
      previousProbability = nextProbability;
    }

    return rows;
  });
}

function trustedLiveContextRows(
  baseIso: string,
  overrides: Partial<BoardObservation["gameState"]> = {},
  count = 24
): BoardObservation[] {
  const baseMs = Date.parse(baseIso);
  const families = ["moneyline", "spread", "total", "team-prop"] as const;
  const sources = ["kalshi", "polymarket"] as const;
  const gameState: BoardObservation["gameState"] = {
    status: "in-play",
    period: 3,
    clock: "08:45",
    homeScore: 72,
    awayScore: 67,
    scoreMargin: 5,
    minutesToTip: null,
    ...overrides,
  };

  return Array.from({ length: count }, (_, index) => {
    const family = families[index % families.length];
    const selection =
      family === "moneyline"
        ? "team-a"
        : family === "spread"
          ? "team-a-minus"
          : "over";
    const line =
      family === "spread"
        ? -2.5
        : family === "total"
          ? 218.5
          : family === "team-prop"
            ? 110.5
            : null;
    const timestamp = new Date(baseMs + index * 2_000).toISOString();

    return makeObservation(`trusted-fill-${index}`, {
      source: sources[index % sources.length],
      sourceKind: "prediction-market",
      family,
      selection,
      line,
      displayLabel: `Trusted filler ${family} ${index}`,
      labels: {
        rawFamily: family,
        rawLabel: `Trusted filler ${family} ${index}`,
        normalizedTokens: ["trusted", "filler", family],
        participantHints: [],
        statFamilyHints: family === "team-prop" ? ["team-total"] : [],
      },
      gameState,
      eventTimestamp: timestamp,
      capturedAt: timestamp,
    });
  });
}

describe("detectBoardAnomalies", () => {
  it("scores attribution-shaped residual fanout high", () => {
    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [
        ...trustedLiveContextRows("2026-05-15T20:00:05.000Z"),
        ...attributionFanout(),
      ],
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(alerts.length).toBeGreaterThan(0);
    const attributionAlert = alerts.find(
      (alert) => alert.shockKind === "attribution-shaped"
    );
    expect(attributionAlert).toBeDefined();
    expect(attributionAlert?.score).toBeGreaterThanOrEqual(60);
    expect(attributionAlert?.primaryEntityKey).toBe("cade-cunningham");
    expect(attributionAlert?.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("promotes broad prediction-market movement to whole-game implied volatility", () => {
    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: gameStateVolatilityFanout(),
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(alerts.length).toBeGreaterThan(0);
    const top = alerts[0];
    expect(top.shockKind).toBe("game-state-volatility");
    expect(top.primaryEntityKey).toBeNull();
    expect(top.primaryFamily).toBeNull();
    expect(top.reason).toContain("board-vw 60s bucket fired");
    expect(top.inspect.relationFamilies).toContain("game-state-volatility");
    expect(top.evidence[0]?.reason).toContain("board-vw");
    expect(top.evidence.some((row) => row.family === "player-prop")).toBe(true);
  });

  it("applies the Iter02 state gate to untrusted live windows", () => {
    const entityAlerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: attributionFanout(),
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(entityAlerts).toHaveLength(0);

    const boardAlerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: gameStateVolatilityFanout(),
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(boardAlerts[0]?.shockKind).toBe("game-state-volatility");
  });

  it("ignores 0.500 anchor rows when building board-vw warmup history", () => {
    const observations = gameStateVolatilityFanout().map((observation) => {
      if (observation.observationId.endsWith("-seed")) {
        return {
          ...observation,
          impliedProbability: 0.5,
        };
      }
      if (observation.observationId.endsWith("-1")) {
        return {
          ...observation,
          previousImpliedProbability: 0.5,
          logitMove:
            observation.impliedProbability != null
              ? logit(observation.impliedProbability) - logit(0.5)
              : 0,
        };
      }
      return observation;
    });

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      band: "insufficient-data",
      score: 0,
      state: "insufficient-data",
    });
  });

  it("measures whole-game volatility as a live score before UI thresholding", () => {
    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: gameStateVolatilityFanout(),
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      alertId: expect.any(String),
      band: "alert",
      gameLabel: "Cavaliers @ Pistons",
      thresholds: {
        alertMinScore: 55,
        elevatedMinScore: 40,
        normalMaxScore: 39,
      },
    });
    expect(measurement?.score).toBeGreaterThanOrEqual(55);
    expect(measurement?.sample.ready).toBe(true);
    expect(measurement?.sample.coreFamilies).toEqual(
      expect.arrayContaining(["moneyline", "spread", "total"])
    );
    expect(measurement?.score).toBeGreaterThanOrEqual(
      measurement?.thresholds.alertMinScore ?? 55
    );
    expect(measurement?.baseline.sampleSize).toBeGreaterThanOrEqual(8);
    expect(measurement?.signals.corePriceShock).toBeGreaterThan(
      measurement?.baseline.expectedRange.p90 ?? 0
    );
  });

  it("uses stored-volume weighting when quote volume is sourced from persisted market metadata", () => {
    const observations = gameStateVolatilityFanout().map((observation) => ({
      ...observation,
      volume: 2400,
      volumeSource: "source-market-metadata" as const,
      missing: {
        ...observation.missing,
        volume: false,
      },
    }));

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      band: "alert",
      sample: {
        ready: true,
      },
    });
    expect(measurement?.evidence[0]?.reason).toContain(
      "log1p(stored vol 2400)"
    );
  });

  it("falls back to equal-weight buckets when both quote and stored volume are missing", () => {
    const observations = gameStateVolatilityFanout().map((observation) => ({
      ...observation,
      volume: null,
      volumeSource: null,
      missing: {
        ...observation.missing,
        volume: true,
      },
    }));

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      band: "alert",
      sample: {
        ready: true,
      },
    });
    expect(measurement?.evidence[0]?.reason).toContain(
      "weight 1 (missing volume)"
    );
  });

  it("marks final-game board volatility as final phase instead of live", () => {
    const finalRows = gameStateVolatilityFanout().map((observation) => ({
      ...observation,
      gameState: {
        ...observation.gameState,
        clock: null,
        status: "final" as const,
      },
    }));

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: finalRows,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement?.phase.kind).toBe("final");
  });

  it("treats calm live prediction-market coverage as a normal sample instead of no sample", () => {
    const stableRows = gameStateVolatilityFanout({
      finalJump: 0.002,
      finalVolume: 4,
      quietJump: 0.004,
      quietVolume: 8,
    });

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: stableRows,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      band: "normal",
      gameLabel: "Cavaliers @ Pistons",
      sample: {
        ready: true,
      },
    });
    expect(measurement?.sample.coreFamilies).toEqual(
      expect.arrayContaining(["moneyline", "spread", "total"])
    );
    expect(measurement?.score).toBeLessThanOrEqual(
      measurement?.thresholds.normalMaxScore ?? 39
    );

    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: stableRows,
      now: "2026-05-15T20:01:00.000Z",
    });
    expect(alerts).toHaveLength(0);
  });

  it("zeros the headline score when the board sample is insufficient", () => {
    const sparseRows = gameStateVolatilityFanout().filter((observation) => {
      const eventMs = Date.parse(observation.eventTimestamp);
      return eventMs < Date.parse("2026-05-15T19:58:00.000Z");
    });

    const measurement = measureBoardGameStateVolatility({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: sparseRows,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(measurement).toMatchObject({
      band: "insufficient-data",
      score: 0,
      state: "insufficient-data",
    });
  });

  it("suppresses same-window prop clusters when whole-game volatility already fired", () => {
    const propFanout = attributionFanout().map((observation, index) => ({
      ...observation,
      observationId: `late-prop-${index}`,
      sourceMarketId: `late-prop-sm-${index}`,
      impliedProbability: 0.91,
      previousImpliedProbability: 0.5,
      logitMove: logit(0.91) - logit(0.5),
      tradePrice: 0.95,
      eventTimestamp: "2026-05-15T20:01:10.000Z",
      capturedAt: "2026-05-15T20:01:10.000Z",
    }));

    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [...gameStateVolatilityFanout(), ...propFanout],
      now: "2026-05-15T20:01:20.000Z",
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].shockKind).toBe("game-state-volatility");
  });

  it("keeps later player follow-up once the board tripwire ages out", () => {
    const propFanout = attributionFanout().map((observation, index) => ({
      ...observation,
      observationId: `separated-prop-${index}`,
      sourceMarketId: `separated-prop-sm-${index}`,
      impliedProbability: 0.91,
      previousImpliedProbability: 0.5,
      logitMove: logit(0.91) - logit(0.5),
      tradePrice: 0.95,
      eventTimestamp: "2026-05-15T20:02:20.000Z",
      capturedAt: "2026-05-15T20:02:20.000Z",
    }));

    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [
        ...trustedLiveContextRows("2026-05-15T20:02:05.000Z"),
        ...gameStateVolatilityFanout(),
        ...propFanout,
      ],
      now: "2026-05-15T20:03:00.000Z",
    });

    expect(
      alerts.some((alert) => alert.shockKind === "attribution-shaped")
    ).toBe(true);
    expect(
      alerts.some((alert) => alert.shockKind === "game-state-volatility")
    ).toBe(false);
  });

  it("drops the board tripwire once the fired bucket ages beyond the shock window", () => {
    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: gameStateVolatilityFanout(),
      now: "2026-05-15T20:03:00.000Z",
    });

    expect(
      alerts.some((alert) => alert.shockKind === "game-state-volatility")
    ).toBe(false);
  });

  it("ignores large final jumps when the previous quote is older than the fresh-cap", () => {
    const observations = gameStateVolatilityFanout({
      finalJump: 0.002,
      finalVolume: 4,
      quietJump: 0.004,
      quietVolume: 8,
    })
      .filter(
        (observation) =>
          ![
            "game-vol-kalshi-moneyline-4",
            "game-vol-kalshi-moneyline-5",
            "game-vol-kalshi-moneyline-6",
            "game-vol-kalshi-moneyline-7",
            "game-vol-kalshi-moneyline-8",
          ].includes(observation.observationId)
      )
      .map((observation) =>
        observation.observationId === "game-vol-kalshi-moneyline-9"
          ? {
              ...observation,
              impliedProbability: 0.9,
              previousImpliedProbability: 0.55,
              logitMove: logit(0.9) - logit(0.55),
              volume: 10_000,
            }
          : observation
      );

    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(
      alerts.some((alert) => alert.shockKind === "game-state-volatility")
    ).toBe(false);
  });

  it("does not require X/Twitter source posts as inputs", () => {
    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [
        ...trustedLiveContextRows("2026-05-15T20:00:05.000Z"),
        ...attributionFanout(),
      ],
      now: "2026-05-15T20:01:00.000Z",
    });
    const allObservationIds = new Set(
      alerts.flatMap((alert) =>
        alert.evidence.map((evidence) => evidence.observationId)
      )
    );
    for (const id of allObservationIds) {
      expect(id.startsWith("attribution-")).toBe(true);
    }
  });

  it("does not require F360 mapping evidence to detect", () => {
    const observations = attributionFanout().map((observation) => ({
      ...observation,
      missing: {
        ...observation.missing,
        impliedProbability: false,
      },
    }));
    for (const observation of observations) {
      (observation as { f360?: unknown }).f360 = undefined;
    }
    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [
        ...trustedLiveContextRows("2026-05-15T20:00:05.000Z"),
        ...observations,
      ],
      now: "2026-05-15T20:01:00.000Z",
    });
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("suppresses ordinary close-game global repricing after H0 adjustment", () => {
    const baseTs = Date.parse("2026-05-15T22:00:00.000Z");
    const ts = (offsetSec: number) =>
      new Date(baseTs + offsetSec * 1000).toISOString();

    const observations = ["a", "b", "c", "d"].map((suffix, index) =>
      makeObservation(`close-game-${suffix}`, {
        family: "moneyline",
        impliedProbability: 0.52,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.52) - logit(0.5),
        gameState: {
          status: "in-play",
          period: 4,
          clock: "00:42",
          homeScore: 110,
          awayScore: 108,
          scoreMargin: 2,
          minutesToTip: null,
        },
        eventTimestamp: ts(index * 5),
        capturedAt: ts(index * 5),
      })
    );

    const alerts = detectBoardAnomalies({
      gameId: "game-close",
      gameLabel: "Close Game",
      observations,
      now: "2026-05-15T22:01:00.000Z",
    });
    expect(alerts).toHaveLength(0);
  });

  it("does not fire on thin bid/ask noise alone", () => {
    const baseTs = Date.parse("2026-05-15T19:00:00.000Z");
    const ts = (offset: number) =>
      new Date(baseTs + offset * 1000).toISOString();

    const observations = ["a", "b"].map((suffix, index) =>
      makeObservation(`thin-noise-${suffix}`, {
        source: "kalshi",
        sourceKind: "prediction-market",
        impliedProbability: 0.5,
        previousImpliedProbability: 0.5,
        logitMove: 0,
        spread: 0.06,
        depthScore: 0.05,
        eventTimestamp: ts(index * 10),
        capturedAt: ts(index * 10),
      })
    );

    const alerts = detectBoardAnomalies({
      gameId: "game-thin",
      gameLabel: "Thin Market",
      observations,
      now: "2026-05-15T19:01:00.000Z",
    });
    expect(alerts).toHaveLength(0);
  });

  it("does not fire from stale quotes alone", () => {
    const staleTs = "2026-05-15T18:00:00.000Z";
    const observations = ["a", "b", "c"].map((suffix) =>
      makeObservation(`stale-${suffix}`, {
        impliedProbability: 0.7,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.7) - logit(0.5),
        quoteAgeMs: 30 * 60 * 1000,
        flags: { isStale: true },
        eventTimestamp: staleTs,
        capturedAt: staleTs,
      })
    );

    const alerts = detectBoardAnomalies({
      gameId: "game-stale",
      gameLabel: "Stale",
      observations,
      now: "2026-05-15T18:31:00.000Z",
    });
    expect(alerts).toHaveLength(0);
  });

  it("classifies pregame availability shock when coherent board repricing exists pre-tip", () => {
    const baseTs = Date.parse("2026-05-15T22:00:00.000Z");
    const ts = (offset: number) =>
      new Date(baseTs + offset * 1000).toISOString();

    const pregameState = {
      status: "scheduled" as const,
      period: null,
      clock: null,
      homeScore: null,
      awayScore: null,
      scoreMargin: null,
      minutesToTip: 25,
    };

    const observations = [
      makeObservation("pregame-ml-sportsbook", {
        source: "bet365",
        sourceKind: "sportsbook",
        family: "moneyline",
        impliedProbability: 0.68,
        previousImpliedProbability: 0.55,
        logitMove: logit(0.68) - logit(0.55),
        lineMove: 1.5,
        gameState: pregameState,
        eventTimestamp: ts(5),
        capturedAt: ts(5),
        missing: { line: false },
      }),
      makeObservation("pregame-spread-sportsbook", {
        source: "bet365",
        sourceKind: "sportsbook",
        family: "spread",
        impliedProbability: 0.6,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.6) - logit(0.5),
        lineMove: 2.0,
        gameState: pregameState,
        eventTimestamp: ts(10),
        capturedAt: ts(10),
        missing: { line: false },
      }),
      makeObservation("pregame-player-prop-kalshi", {
        source: "kalshi",
        sourceKind: "prediction-market",
        family: "player-prop",
        participantKey: "star-player",
        impliedProbability: 0.45,
        previousImpliedProbability: 0.62,
        logitMove: logit(0.45) - logit(0.62),
        tradePrice: 0.42,
        tradeSize: 1200,
        volumeShare: 0.28,
        finalMarketVolume: 4300,
        labels: {
          rawFamily: "player-prop",
          rawLabel: "Star Player Over 24.5 Points",
          normalizedTokens: ["star", "player", "points"],
          participantHints: ["star-player"],
          statFamilyHints: ["points"],
        },
        gameState: pregameState,
        eventTimestamp: ts(15),
        capturedAt: ts(15),
      }),
      makeObservation("pregame-team-total-sportsbook", {
        source: "bet365",
        sourceKind: "sportsbook",
        family: "team-prop",
        impliedProbability: 0.55,
        previousImpliedProbability: 0.45,
        logitMove: logit(0.55) - logit(0.45),
        lineMove: 1.0,
        gameState: pregameState,
        eventTimestamp: ts(20),
        capturedAt: ts(20),
        missing: { line: false },
      }),
    ];

    const alerts = detectBoardAnomalies({
      gameId: "game-pregame",
      gameLabel: "Nuggets @ Lakers",
      observations,
      now: "2026-05-15T22:01:00.000Z",
    });

    const pregameAlert = alerts.find(
      (alert) =>
        alert.shockKind === "near-tip-availability" ||
        alert.shockKind === "pregame-availability"
    );
    expect(pregameAlert).toBeDefined();
    expect(pregameAlert!.score).toBeGreaterThanOrEqual(60);
  });

  it("does not call a mixed live-game cluster near-tip availability", () => {
    const observations = attributionFanout();
    observations[0] = {
      ...observations[0],
      gameState: {
        awayScore: null,
        clock: null,
        homeScore: null,
        minutesToTip: 8,
        period: null,
        scoreMargin: null,
        status: "scheduled",
      },
    };

    const alerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });

    expect(
      alerts.some(
        (alert) =>
          alert.shockKind === "near-tip-availability" ||
          alert.shockKind === "pregame-availability"
      )
    ).toBe(false);
  });

  it("classifies coverage gap when peers move but one expected source is stale", () => {
    const baseTs = Date.parse("2026-05-15T21:00:00.000Z");
    const ts = (offset: number) =>
      new Date(baseTs + offset * 1000).toISOString();
    const observations: BoardObservation[] = [
      makeObservation("cov-poly", {
        source: "polymarket",
        sourceKind: "prediction-market",
        family: "player-prop",
        participantKey: "player-x",
        impliedProbability: 0.72,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.72) - logit(0.5),
        tradePrice: 0.74,
        tradeSize: 500,
        volumeShare: 0.18,
        finalMarketVolume: 2700,
        labels: {
          rawFamily: "player-prop",
          rawLabel: "Player X over 12.5 rebounds",
          normalizedTokens: ["player", "rebounds"],
          participantHints: ["player-x"],
          statFamilyHints: ["rebounds"],
        },
        eventTimestamp: ts(5),
        capturedAt: ts(5),
      }),
      makeObservation("cov-kalshi-stale", {
        source: "kalshi",
        sourceKind: "prediction-market",
        family: "player-prop",
        participantKey: "player-x",
        impliedProbability: 0.5,
        previousImpliedProbability: 0.5,
        logitMove: 0,
        quoteAgeMs: 25 * 60 * 1000,
        flags: { isStale: true },
        labels: {
          rawFamily: "player-prop",
          rawLabel: "Player X over 12.5 rebounds",
          normalizedTokens: ["player", "rebounds"],
          participantHints: ["player-x"],
          statFamilyHints: ["rebounds"],
        },
        eventTimestamp: ts(0),
        capturedAt: ts(0),
        missing: { impliedProbability: true },
      }),
      makeObservation("cov-bet365", {
        source: "bet365",
        sourceKind: "sportsbook",
        family: "player-prop",
        participantKey: "player-x",
        impliedProbability: 0.68,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.68) - logit(0.5),
        lineMove: 1.0,
        labels: {
          rawFamily: "player-prop",
          rawLabel: "Player X over 12.5 rebounds",
          normalizedTokens: ["player", "rebounds"],
          participantHints: ["player-x"],
          statFamilyHints: ["rebounds"],
        },
        eventTimestamp: ts(10),
        capturedAt: ts(10),
        missing: { line: false },
      }),
    ];

    const alerts = detectBoardAnomalies({
      gameId: "game-cov",
      gameLabel: "Coverage Game",
      observations: [
        ...trustedLiveContextRows("2026-05-15T21:00:05.000Z", {
          clock: "09:10",
          homeScore: 61,
          awayScore: 56,
          period: 3,
          scoreMargin: 5,
        }),
        ...observations,
      ],
      now: "2026-05-15T21:01:00.000Z",
    });
    const hasCoverageNote = alerts.some(
      (alert) =>
        alert.missingDataNotes.length > 0 || alert.shockKind === "coverage-gap"
    );
    expect(hasCoverageNote).toBe(true);
  });

  it("a single isolated row movement does not automatically become a top trader incident", () => {
    const observations = [
      makeObservation("isolated-1", {
        impliedProbability: 0.9,
        previousImpliedProbability: 0.5,
        logitMove: logit(0.9) - logit(0.5),
      }),
    ];
    const alerts = detectBoardAnomalies({
      gameId: "game-isolated",
      gameLabel: "Isolated",
      observations,
      now: "2026-05-15T20:01:00.000Z",
    });
    expect(alerts).toHaveLength(0);
  });
});

describe("H0 cap scales with base probability", () => {
  it("longshot p=0.05 → much larger logit cap than coin-flip p=0.5", async () => {
    const { computeH0Adjustment } = await import("../board-anomaly/h0");
    const { resolveBoardAnomalyConfig } =
      await import("../board-anomaly/config");
    const config = resolveBoardAnomalyConfig();
    const coin = makeObservation("h0-coin", {
      impliedProbability: 0.5,
      previousImpliedProbability: 0.5,
      gameState: {
        status: "in-play",
        period: 4,
        clock: "00:42",
        homeScore: 110,
        awayScore: 108,
        scoreMargin: 2,
        minutesToTip: null,
      },
    });
    const longshot = makeObservation("h0-longshot", {
      impliedProbability: 0.05,
      previousImpliedProbability: 0.05,
      gameState: coin.gameState,
    });
    const coinH0 = computeH0Adjustment(coin, config);
    const longshotH0 = computeH0Adjustment(longshot, config);
    expect(longshotH0.expectedAbsLogitMove).toBeGreaterThan(
      coinH0.expectedAbsLogitMove * 1.5
    );
  });

  it("favorite p=0.95 → same logit cap as longshot p=0.05 (symmetric)", async () => {
    const { computeH0Adjustment } = await import("../board-anomaly/h0");
    const { resolveBoardAnomalyConfig } =
      await import("../board-anomaly/config");
    const config = resolveBoardAnomalyConfig();
    const longshot = makeObservation("h0-l", {
      impliedProbability: 0.05,
      previousImpliedProbability: 0.05,
      gameState: {
        status: "in-play",
        period: 4,
        clock: "01:00",
        homeScore: 100,
        awayScore: 95,
        scoreMargin: 5,
        minutesToTip: null,
      },
    });
    const favorite = makeObservation("h0-f", {
      impliedProbability: 0.95,
      previousImpliedProbability: 0.95,
      gameState: longshot.gameState,
    });
    const longshotH0 = computeH0Adjustment(longshot, config);
    const favoriteH0 = computeH0Adjustment(favorite, config);
    expect(
      Math.abs(
        longshotH0.expectedAbsLogitMove - favoriteH0.expectedAbsLogitMove
      )
    ).toBeLessThan(0.001);
  });
});

describe("coverage is a confidence penalty, not a positive score boost", () => {
  it("cluster with high stale/missing share has lower confidence than clean cluster", () => {
    const trustedRows = trustedLiveContextRows("2026-05-15T20:00:05.000Z");
    const clean = [...trustedRows, ...attributionFanout()];
    const dirty = [...trustedRows, ...attributionFanout()].map(
      (observation) => ({
        ...(observation.observationId === "attribution-poly-points-over"
          ? {
              ...observation,
              mappingStatus: "unmapped" as const,
              flags: {
                ...observation.flags,
                isStale: true,
                isUnmapped: true,
              },
              missing: { ...observation.missing, impliedProbability: true },
            }
          : observation.observationId.startsWith("attribution-")
            ? {
                ...observation,
                mappingStatus: "unmapped" as const,
                flags: {
                  ...observation.flags,
                  isUnmapped: true,
                },
                missing: { ...observation.missing },
              }
            : observation),
      })
    );
    const cleanAlerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: clean,
      now: "2026-05-15T20:01:00.000Z",
    });
    const dirtyAlerts = detectBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: dirty,
      now: "2026-05-15T20:01:00.000Z",
    });
    const cleanAttribution = cleanAlerts.find(
      (alert) => alert.shockKind === "attribution-shaped"
    );
    const dirtyEntityAlert = dirtyAlerts.find(
      (alert) => alert.primaryEntityKey === "cade-cunningham"
    );
    expect(cleanAttribution).toBeDefined();
    expect(dirtyEntityAlert?.confidence ?? 0).toBeLessThan(
      cleanAttribution!.confidence
    );
    expect(dirtyEntityAlert?.score ?? 0).toBeLessThanOrEqual(
      cleanAttribution!.score
    );
  });
});

describe("replayBoardAnomalies", () => {
  it("returns timestamp-ordered alerts with no future leakage", () => {
    const observations = gameStateVolatilityFanout();
    const replay = replayBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations,
      windowStart: "2026-05-15T19:51:00.000Z",
      windowEnd: "2026-05-15T20:02:00.000Z",
      stepSeconds: 15,
    });

    expect(replay.alertDeck.length).toBeGreaterThan(0);
    for (let i = 1; i < replay.alertDeck.length; i += 1) {
      expect(Date.parse(replay.alertDeck[i].firstPopAt)).toBeGreaterThanOrEqual(
        Date.parse(replay.alertDeck[i - 1].firstPopAt)
      );
    }
    for (const alert of replay.alertDeck) {
      expect(Date.parse(alert.detectedAt)).toBeGreaterThanOrEqual(
        Date.parse(alert.firstPopAt)
      );
    }
  });

  it("suppresses repeated noisy updates and only emits a new card on material change", () => {
    const baseTs = Date.parse("2026-05-15T20:00:00.000Z");
    const ts = (offset: number) =>
      new Date(baseTs + offset * 1000).toISOString();
    const fanout = attributionFanout();
    const noisyObservations: BoardObservation[] = [];
    for (let i = 0; i < 12; i += 1) {
      for (const observation of fanout) {
        noisyObservations.push({
          ...observation,
          observationId: `${observation.observationId}-${i}`,
          sourceMarketId: observation.sourceMarketId,
          eventTimestamp: ts(20 + i * 10),
          capturedAt: ts(20 + i * 10),
        });
      }
    }

    const replay = replayBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: noisyObservations,
      windowStart: "2026-05-15T19:55:00.000Z",
      windowEnd: "2026-05-15T20:10:00.000Z",
      stepSeconds: 10,
    });

    expect(replay.alertDeck.length).toBeLessThanOrEqual(3);
  });

  it("emits a new alert when the shock changes shape", () => {
    const baseTs = Date.parse("2026-05-15T20:00:00.000Z");
    const ts = (offset: number) =>
      new Date(baseTs + offset * 1000).toISOString();

    const fanout = attributionFanout();
    const second = attributionFanout().map((observation, index) => ({
      ...observation,
      observationId: `second-${index}`,
      sourceMarketId: `second-sm-${index}`,
      participantKey: "ausar-thompson",
      impliedProbability: 0.78,
      previousImpliedProbability: 0.5,
      logitMove: logit(0.78) - logit(0.5),
      labels: {
        ...observation.labels,
        participantHints: ["ausar-thompson"],
        normalizedTokens: ["ausar", "thompson", "rebounds"],
      },
      eventTimestamp: ts(300 + index * 5),
      capturedAt: ts(300 + index * 5),
    }));

    const replay = replayBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [
        ...trustedLiveContextRows("2026-05-15T19:59:15.000Z"),
        ...trustedLiveContextRows("2026-05-15T20:04:15.000Z"),
        ...fanout,
        ...second,
      ],
      windowStart: "2026-05-15T19:55:00.000Z",
      windowEnd: "2026-05-15T20:15:00.000Z",
      stepSeconds: 30,
    });

    const entities = new Set(
      replay.alertDeck.map((alert) => alert.primaryEntityKey)
    );
    expect(entities.size).toBeGreaterThanOrEqual(2);
  });

  it("does not lead with post-game current divergence (only operational window evidence)", () => {
    const baseTs = Date.parse("2026-05-15T22:00:00.000Z");
    const operationalObservations = attributionFanout().map(
      (observation, index) => ({
        ...observation,
        observationId: `op-${index}`,
        sourceMarketId: `op-sm-${index}`,
        eventTimestamp: new Date(
          baseTs + 10 * 60 * 1000 + index * 5000
        ).toISOString(),
        capturedAt: new Date(
          baseTs + 10 * 60 * 1000 + index * 5000
        ).toISOString(),
      })
    );
    const postGameObservations = attributionFanout().map(
      (observation, index) => ({
        ...observation,
        observationId: `post-${index}`,
        sourceMarketId: `post-sm-${index}`,
        eventTimestamp: new Date(
          baseTs + 200 * 60 * 1000 + index * 5000
        ).toISOString(),
        capturedAt: new Date(
          baseTs + 200 * 60 * 1000 + index * 5000
        ).toISOString(),
      })
    );

    const replay = replayBoardAnomalies({
      gameId: "game-1",
      gameLabel: "Cavaliers @ Pistons",
      observations: [...operationalObservations, ...postGameObservations],
      windowStart: "2026-05-15T22:00:00.000Z",
      windowEnd: "2026-05-15T22:30:00.000Z",
      stepSeconds: 30,
      ingestionLatencyBufferSeconds: 60,
    });

    for (const alert of replay.alertDeck) {
      const ts = Date.parse(alert.firstPopAt);
      expect(ts).toBeLessThanOrEqual(
        Date.parse("2026-05-15T22:30:00.000Z") + 60_000
      );
    }
  });
});
