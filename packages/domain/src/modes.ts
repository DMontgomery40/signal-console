export const operatingModes = ["live"] as const;

export type OperatingMode = (typeof operatingModes)[number];

export const sourceIds = ["bet365", "kalshi", "polymarket", "model"] as const;

export type SourceId = (typeof sourceIds)[number];

export const freshnessStatuses = [
  "fresh",
  "aging",
  "stale",
  "offline",
] as const;

export type FreshnessStatus = (typeof freshnessStatuses)[number];

export const healthStatuses = ["healthy", "degraded", "offline"] as const;

export type HealthStatus = (typeof healthStatuses)[number];

export const severityBands = ["low", "medium", "high", "critical"] as const;

export type SeverityBand = (typeof severityBands)[number];

export const confidenceBands = ["low", "moderate", "high"] as const;

export type ConfidenceBand = (typeof confidenceBands)[number];
