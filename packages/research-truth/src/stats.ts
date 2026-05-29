import { MAD_SCALE, MILLISECONDS_PER_SECOND, SCALE_FLOOR } from "./constants";
import type { HistoricalPrior } from "./types";

export function parseIsoSeconds(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / MILLISECONDS_PER_SECOND : null;
}

export function isoFromSeconds(value: number): string {
  return new Date(value * MILLISECONDS_PER_SECOND).toISOString();
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const middleValue = ordered[middle];
  if (middleValue === undefined) return 0;
  if (ordered.length % 2 === 1) return middleValue;
  const previous = ordered[middle - 1] ?? middleValue;
  return (previous + middleValue) / 2;
}

export function mad(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rounded(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeGameId(gameId: string): string {
  if (gameId === "") return "";
  if (gameId.startsWith("nba-")) return gameId;
  if (/^\d{10}$/.test(gameId)) return `nba-${gameId}`;
  return gameId;
}

export function robustStats(scores: readonly number[]): HistoricalPrior | null {
  if (scores.length === 0) return null;
  return { median: median(scores), mad: mad(scores), sampleSize: scores.length };
}

export function positiveRobustZ(value: number, stats: HistoricalPrior | null): number {
  if (stats === null) return 0;
  const scale = Math.max(MAD_SCALE * stats.mad, SCALE_FLOOR);
  return Math.max(0, (value - stats.median) / scale);
}
