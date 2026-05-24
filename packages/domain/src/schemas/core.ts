import { z } from "zod";

import {
  confidenceBands,
  freshnessStatuses,
  healthStatuses,
  operatingModes,
  severityBands,
  sourceIds,
} from "../modes";

export const operatingModeSchema = z.enum(operatingModes);
export const sourceIdSchema = z.enum(sourceIds);
export const freshnessStatusSchema = z.enum(freshnessStatuses);
export const healthStatusSchema = z.enum(healthStatuses);
export const severityBandSchema = z.enum(severityBands);
export const confidenceBandSchema = z.enum(confidenceBands);

export const teamSchema = z.object({
  id: z.string(),
  city: z.string(),
  name: z.string(),
  abbreviation: z.string(),
  shortName: z.string(),
});

export const sportEventSchema = z.object({
  id: z.string(),
  league: z.literal("NBA"),
  status: z.enum(["scheduled", "pre-tip", "in-play", "final"]),
  tipoffAt: z.string(),
  homeTeam: teamSchema,
  awayTeam: teamSchema,
  marketType: z.literal("winner"),
  venue: z.string(),
});

export const sourceQuoteSchema = z.object({
  sourceId: sourceIdSchema,
  probability: z.number().min(0).max(1),
  spread: z.number(),
  volume: z.number().nonnegative(),
  depthScore: z.number().min(0).max(100),
  sourceTimestamp: z.string(),
  ingestedAt: z.string(),
  freshnessStatus: freshnessStatusSchema,
  reliabilityWeight: z.number().min(0).max(1),
  note: z.string().optional(),
});

export const sourceHealthSchema = z.object({
  sourceId: sourceIdSchema,
  status: healthStatusSchema,
  lastSuccessAt: z.string(),
  lagMs: z.number().nonnegative(),
  message: z.string(),
});

export const eventContextSchema = z.object({
  modelProbability: z.number().min(0).max(1),
  restEdge: z.number().min(-1).max(1),
  formEdge: z.number().min(-1).max(1),
  paceEdge: z.number().min(-1).max(1),
  exposureScore: z.number().min(0).max(100),
  volatilityScore: z.number().min(0).max(100),
  liquidityRisk: z.number().min(0).max(100),
  noteTags: z.array(z.string()),
});

export const auditEntrySchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  label: z.string(),
  message: z.string(),
  tone: z.enum(["info", "positive", "caution"]),
});

export const suggestedActionSchema = z.object({
  label: z.string(),
  detail: z.string(),
  priority: z.enum(["monitor", "queue", "act-now"]),
});

export const eventFrameSchema = z.object({
  event: sportEventSchema,
  quotes: z.object({
    bet365: sourceQuoteSchema,
    kalshi: sourceQuoteSchema,
    polymarket: sourceQuoteSchema,
    model: sourceQuoteSchema,
  }),
  context: eventContextSchema,
  narrativeHints: z.array(z.string()),
  audit: z.array(auditEntrySchema),
  suggestedActions: z.array(suggestedActionSchema),
});
