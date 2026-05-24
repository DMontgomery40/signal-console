import type {
  BoardObservation,
  BoardObservationFlags,
  BoardObservationMissing,
  MarketFamily,
  ResearchSourceId,
} from "@signal-console/domain";

import {
  buildObservationLabels,
  gameStateAt,
  type GameStateRow,
} from "./board-anomaly-observation-context";
import { parseTimestampMs, sourceKindFor } from "./board-anomaly-support";

export type QuoteRow = {
  observationKind: "quote";
  observationId: number;
  sourceMarketId: string;
  source: ResearchSourceId;
  instrumentId: string | null;
  rawFamily: string | null;
  rawLabel: string | null;
  mappingStatus: string;
  family: MarketFamily | null;
  selection: string | null;
  participantKey: string | null;
  line: number | null;
  displayLabel: string | null;
  capturedAt: string;
  impliedProbability: number | null;
  lineRaw: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  volume: number | null;
  volumeSource: "quote-tick" | "source-market-metadata" | null;
  depthScore: number | null;
  isHeartbeat: number;
};

export type MicrostructureRow = {
  observationKind: "microstructure";
  observationId: number;
  sourceMarketId: string;
  source: ResearchSourceId;
  instrumentId: string | null;
  rawFamily: string | null;
  rawLabel: string | null;
  mappingStatus: string;
  family: MarketFamily | null;
  selection: string | null;
  participantKey: string | null;
  line: number | null;
  displayLabel: string | null;
  eventType: string;
  apiSurface: string;
  eventTimestamp: string;
  capturedAt: string;
  price: number | null;
  previousPrice: number | null;
  tradePrice: number | null;
  size: number | null;
  notional: number | null;
  volume: number | null;
  finalMarketVolume: number | null;
  volumeShare: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  depthScore: number | null;
};

export function quoteRowToObservation(
  row: QuoteRow,
  gameStates: GameStateRow[],
  scheduledStartMs: number,
  previousProbabilityByMarket: Map<string, number | null>
): BoardObservation | null {
  const capturedMs = parseTimestampMs(row.capturedAt);
  if (capturedMs == null) return null;
  const previousProbability =
    previousProbabilityByMarket.get(row.sourceMarketId) ?? null;
  const impliedProbability = row.impliedProbability ?? null;
  const logitMove =
    previousProbability != null && impliedProbability != null
      ? Math.log(
          Math.min(0.999, Math.max(0.001, impliedProbability)) /
            (1 - Math.min(0.999, Math.max(0.001, impliedProbability)))
        ) -
        Math.log(
          Math.min(0.999, Math.max(0.001, previousProbability)) /
            (1 - Math.min(0.999, Math.max(0.001, previousProbability)))
        )
      : 0;
  previousProbabilityByMarket.set(row.sourceMarketId, impliedProbability);

  const flags: BoardObservationFlags = {
    isUnmapped: row.mappingStatus === "unmapped",
    isHeartbeat: row.isHeartbeat === 1,
    isSuspended: false,
    isStale: false,
  };
  const missing: BoardObservationMissing = {
    impliedProbability: impliedProbability == null,
    line: row.lineRaw == null,
    bestBid: row.bestBid == null,
    bestAsk: row.bestAsk == null,
    volume: row.volume == null,
    depthScore: row.depthScore == null,
    tradePrice: true,
    tradeSize: true,
    participantKey: row.participantKey == null,
  };

  return {
    observationId: `quote:${row.observationId}`,
    gameId: "",
    source: row.source,
    sourceKind: sourceKindFor(row.source),
    sourceMarketId: row.sourceMarketId,
    instrumentId: row.instrumentId,
    family: row.family,
    selection: row.selection,
    participantKey: row.participantKey,
    line: row.line,
    mappingStatus: row.mappingStatus as BoardObservation["mappingStatus"],
    displayLabel: row.displayLabel ?? row.rawLabel ?? row.sourceMarketId,
    labels: buildObservationLabels(
      row.rawFamily,
      row.rawLabel,
      row.participantKey,
      row.displayLabel
    ),
    eventTimestamp: row.capturedAt,
    capturedAt: row.capturedAt,
    quoteAgeMs: 0,
    impliedProbability,
    previousImpliedProbability: previousProbability,
    priceMove: 0,
    lineMove: 0,
    logitMove,
    bestBid: row.bestBid,
    bestAsk: row.bestAsk,
    spread:
      row.bestBid != null && row.bestAsk != null
        ? Math.max(0, row.bestAsk - row.bestBid)
        : null,
    depthScore: row.depthScore,
    volume: row.volume,
    volumeSource: row.volumeSource,
    tradePrice: null,
    tradeSize: null,
    notional: null,
    volumeShare: null,
    finalMarketVolume: null,
    flags,
    missing,
    gameState: gameStateAt(gameStates, capturedMs, scheduledStartMs),
  };
}

export function microstructureRowToObservation(
  row: MicrostructureRow,
  gameStates: GameStateRow[],
  scheduledStartMs: number
): BoardObservation | null {
  const eventMs =
    parseTimestampMs(row.eventTimestamp) ?? parseTimestampMs(row.capturedAt);
  if (eventMs == null) return null;
  const impliedProbability = row.price ?? row.tradePrice ?? null;
  const previousImpliedProbability = row.previousPrice ?? null;
  const logitMove =
    impliedProbability != null && previousImpliedProbability != null
      ? Math.log(
          Math.min(0.999, Math.max(0.001, impliedProbability)) /
            (1 - Math.min(0.999, Math.max(0.001, impliedProbability)))
        ) -
        Math.log(
          Math.min(0.999, Math.max(0.001, previousImpliedProbability)) /
            (1 - Math.min(0.999, Math.max(0.001, previousImpliedProbability)))
        )
      : 0;
  const flags: BoardObservationFlags = {
    isUnmapped: row.mappingStatus === "unmapped",
    isHeartbeat: false,
    isSuspended: false,
    isStale: false,
  };
  const missing: BoardObservationMissing = {
    impliedProbability: impliedProbability == null,
    line: true,
    bestBid: row.bestBid == null,
    bestAsk: row.bestAsk == null,
    volume: row.volume == null,
    depthScore: row.depthScore == null,
    tradePrice: row.tradePrice == null,
    tradeSize: row.size == null,
    participantKey: row.participantKey == null,
  };
  return {
    observationId: `microstructure:${row.observationId}`,
    gameId: "",
    source: row.source,
    sourceKind: sourceKindFor(row.source),
    sourceMarketId: row.sourceMarketId,
    instrumentId: row.instrumentId,
    family: row.family,
    selection: row.selection,
    participantKey: row.participantKey,
    line: row.line,
    mappingStatus: row.mappingStatus as BoardObservation["mappingStatus"],
    displayLabel: row.displayLabel ?? row.rawLabel ?? row.sourceMarketId,
    labels: buildObservationLabels(
      row.rawFamily,
      row.rawLabel,
      row.participantKey,
      row.displayLabel
    ),
    eventTimestamp: row.eventTimestamp,
    capturedAt: row.capturedAt,
    quoteAgeMs: Math.max(
      0,
      (parseTimestampMs(row.capturedAt) ?? eventMs) - eventMs
    ),
    impliedProbability,
    previousImpliedProbability,
    priceMove: 0,
    lineMove: 0,
    logitMove,
    bestBid: row.bestBid,
    bestAsk: row.bestAsk,
    spread: row.spread,
    depthScore: row.depthScore,
    volume: row.volume,
    tradePrice: row.tradePrice,
    tradeSize: row.size,
    notional: row.notional,
    volumeShare: row.volumeShare,
    finalMarketVolume: row.finalMarketVolume,
    flags,
    missing,
    gameState: gameStateAt(gameStates, eventMs, scheduledStartMs),
  };
}
