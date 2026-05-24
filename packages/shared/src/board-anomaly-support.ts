import type { ResearchSourceId } from "@signal-console/domain";

const NUMERIC_LABEL_TOKEN_RE = /^\d+(\.\d+)?$/;

export function parseTimestampMs(
  value: string | null | undefined
): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function sourceKindFor(
  source: ResearchSourceId | string
): "sportsbook" | "prediction-market" {
  if (source === "kalshi" || source === "polymarket") {
    return "prediction-market";
  }
  return "sportsbook";
}

export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizeBoardText(value: string | null | undefined): string {
  if (!value) return "";
  return stripDiacritics(value).replace(/['’]/g, "").toLowerCase();
}

export function tokenizeBoardText(value: string | null | undefined): string[] {
  const normalized = normalizeBoardText(value);
  if (!normalized) return [];
  return normalized
    .replace(/[^\p{L}0-9. ]+/gu, " ")
    .split(/\s+/)
    .filter(
      (token) => token.length >= 3 && !NUMERIC_LABEL_TOKEN_RE.test(token)
    );
}
