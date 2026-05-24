import type { FreshnessStatus, HealthStatus, SourceId } from "./modes";

export type Team = {
  id: string;
  city: string;
  name: string;
  abbreviation: string;
  shortName: string;
};

export type SportEvent = {
  id: string;
  league: "NBA";
  status: "scheduled" | "pre-tip" | "in-play" | "final";
  tipoffAt: string;
  homeTeam: Team;
  awayTeam: Team;
  marketType: "winner";
  venue: string;
};

export type SourceQuote = {
  sourceId: SourceId;
  probability: number;
  spread: number;
  volume: number;
  depthScore: number;
  sourceTimestamp: string;
  ingestedAt: string;
  freshnessStatus: FreshnessStatus;
  reliabilityWeight: number;
  note?: string;
};

export type SourceHealth = {
  sourceId: SourceId;
  status: HealthStatus;
  lastSuccessAt: string;
  lagMs: number;
  message: string;
};

export type EventContext = {
  modelProbability: number;
  restEdge: number;
  formEdge: number;
  paceEdge: number;
  exposureScore: number;
  volatilityScore: number;
  liquidityRisk: number;
  noteTags: string[];
};

export type AuditEntry = {
  id: string;
  capturedAt: string;
  label: string;
  message: string;
  tone: "info" | "positive" | "caution";
};

export type SuggestedAction = {
  label: string;
  detail: string;
  priority: "monitor" | "queue" | "act-now";
};

export type EventFrame = {
  event: SportEvent;
  quotes: Record<SourceId, SourceQuote>;
  context: EventContext;
  narrativeHints: string[];
  audit: AuditEntry[];
  suggestedActions: SuggestedAction[];
};

export type WatchlistRecord = {
  eventId: string;
  priority: number | null;
  status: "queued" | "monitoring";
  note: string | null;
  updatedAt: string;
};
