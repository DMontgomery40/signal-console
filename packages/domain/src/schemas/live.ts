import { z } from "zod";

import {
  adapterCaptureModes,
  adapterRunStatuses,
  adminActionStatuses,
  comparableStates,
  mappingStatuses,
  marketResearchSourceIds,
  marketMicrostructureEventTypes,
  marketFamilies,
  researchGameStatuses,
  researchSourceIds,
} from "../live-types";

export const researchSourceIdSchema = z.enum(researchSourceIds);
export const marketResearchSourceIdSchema = z.enum(marketResearchSourceIds);
export const marketFamilySchema = z.enum(marketFamilies);
export const researchGameStatusSchema = z.enum(researchGameStatuses);
export const mappingStatusSchema = z.enum(mappingStatuses);
export const comparableStateSchema = z.enum(comparableStates);
export const adapterRunStatusSchema = z.enum(adapterRunStatuses);
export const adapterCaptureModeSchema = z.enum(adapterCaptureModes);
export const adminActionStatusSchema = z.enum(adminActionStatuses);
export const marketMicrostructureEventTypeSchema = z.enum(
  marketMicrostructureEventTypes
);

export const gameParticipantSchema = z.object({
  key: z.string(),
  name: z.string(),
  shortName: z.string(),
  abbreviation: z.string().nullable().optional(),
  side: z.enum(["home", "away"]).nullable().optional(),
});

export const canonicalGameSchema = z.object({
  id: z.string(),
  sport: z.string().min(1),
  league: z.string().min(1),
  sourceGameKeyNba: z.string().nullable().optional(),
  homeParticipant: gameParticipantSchema,
  awayParticipant: gameParticipantSchema,
  scheduledStart: z.string(),
});

export const canonicalGameStateSchema = z.object({
  id: z.number().int().nonnegative(),
  gameId: z.string(),
  capturedAt: z.string(),
  status: researchGameStatusSchema,
  period: z.number().int().nullable().optional(),
  clock: z.string().nullable().optional(),
  homeScore: z.number().int().nullable().optional(),
  awayScore: z.number().int().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finalAt: z.string().nullable().optional(),
  isFinal: z.boolean(),
});

export const gameOutcomeSchema = z.object({
  gameId: z.string(),
  finalHomeScore: z.number().int(),
  finalAwayScore: z.number().int(),
  winnerKey: z.string().nullable().optional(),
  capturedAt: z.string(),
});

export const marketInstrumentSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  family: marketFamilySchema,
  selection: z.string(),
  line: z.number().nullable().optional(),
  participantKey: z.string().nullable().optional(),
  inPlay: z.boolean(),
  displayLabel: z.string(),
});

export const sourceMarketSchema = z.object({
  id: z.string(),
  source: researchSourceIdSchema,
  sourceMarketKey: z.string(),
  sourceSelectionKey: z.string().nullable().optional(),
  gameId: z.string(),
  instrumentId: z.string().nullable().optional(),
  rawFamily: z.string().nullable().optional(),
  rawLabel: z.string().nullable().optional(),
  mappingStatus: mappingStatusSchema,
  rawMetadata: z.record(z.unknown()).nullable().optional(),
});

export const quoteTickSchema = z.object({
  id: z.number().int().nonnegative(),
  sourceMarketId: z.string(),
  capturedAt: z.string(),
  priceRaw: z.number().nullable().optional(),
  oddsRaw: z.string().nullable().optional(),
  lineRaw: z.number().nullable().optional(),
  impliedProbability: z.number().min(0).max(1).nullable().optional(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
  depthScore: z.number().nullable().optional(),
  isHeartbeat: z.boolean(),
});

export const marketMicrostructureEventSchema = z.object({
  id: z.number().int().nonnegative(),
  source: marketResearchSourceIdSchema,
  sourceMarketId: z.string(),
  gameId: z.string(),
  instrumentId: z.string().nullable().optional(),
  eventType: marketMicrostructureEventTypeSchema,
  apiSurface: z.string(),
  eventTimestamp: z.string(),
  capturedAt: z.string(),
  price: z.number().nullable().optional(),
  previousPrice: z.number().nullable().optional(),
  tradePrice: z.number().nullable().optional(),
  size: z.number().nullable().optional(),
  notional: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
  finalMarketVolume: z.number().nullable().optional(),
  volumeShare: z.number().nullable().optional(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  spread: z.number().nullable().optional(),
  depthScore: z.number().nullable().optional(),
  rawPayloadId: z.number().int().nullable().optional(),
  rawMetadata: z.record(z.unknown()).nullable().optional(),
});

export const rawPayloadAttachmentSchema = z.object({
  id: z.number().int().nonnegative(),
  source: researchSourceIdSchema,
  capturedAt: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  payloadJson: z.record(z.unknown()),
  contentHash: z.string(),
});

export const adapterRunSchema = z.object({
  id: z.number().int().nonnegative(),
  source: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable().optional(),
  status: adapterRunStatusSchema,
  captureMode: adapterCaptureModeSchema.optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  recordsSeen: z.number().int().nonnegative(),
  recordsWritten: z.number().int().nonnegative(),
});

export const mappingResolutionSchema = z.object({
  id: z.number().int().nonnegative(),
  sourceMarketId: z.string(),
  instrumentId: z.string(),
  resolvedBy: z.string(),
  resolvedAt: z.string(),
  reason: z.string(),
});

export const adminActionSchema = z.object({
  id: z.number().int().nonnegative(),
  actionType: z.string(),
  scope: z.string(),
  requestedAt: z.string(),
  requestedBy: z.string(),
  status: adminActionStatusSchema,
  payloadJson: z.record(z.unknown()),
});
