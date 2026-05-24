export function normalizeIdToken(value: string | number | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildStableId(parts: ReadonlyArray<string | number | null | undefined>): string {
  return parts.map(normalizeIdToken).filter(Boolean).join("-");
}

export function buildCanonicalMoneylineInstrumentId(args: {
  readonly gameId: string;
  readonly participantKey: string;
  readonly period?: "first-half" | null;
}): string {
  if (args.period === "first-half") {
    return buildStableId([args.gameId, "moneyline", "first-half", args.participantKey]);
  }
  return buildStableId([args.gameId, "moneyline", args.participantKey]);
}
