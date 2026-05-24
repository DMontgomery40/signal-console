import type {
  CanonicalGame,
  LatestSourceView,
  MarketInstrument,
} from "@signal-console/domain";

import { normalizeBoardText } from "./board-anomaly-support";

export function toBoolean(value: number | boolean | null | undefined) {
  return value === true || value === 1;
}

export function nullableNumber(value: unknown) {
  if (value == null) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function timestampValue(value: Date | string | null | undefined) {
  if (!value) {
    return -1;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : -1;
}

export function lineValuesMatch(
  left: number | null | undefined,
  right: number | null | undefined
) {
  if (left == null || right == null) {
    return true;
  }

  return Math.abs(left - right) < 0.000001;
}

function normalizeSelectionToken(value: string | null | undefined) {
  return normalizeBoardText(value)
    .replace(/[^\p{L}0-9]+/gu, " ")
    .trim();
}

function selectionTokenParts(value: string | null | undefined) {
  return normalizeSelectionToken(value).split(/\s+/).filter(Boolean);
}

function tokenPartsContainAll(tokens: string[], expected: string[]) {
  return expected.every((token) => tokens.includes(token));
}

function participantAliases(
  participant: CanonicalGame["homeParticipant"],
  opponent?: CanonicalGame["awayParticipant"]
) {
  const aliases = new Set<string>();
  const directAliases = [
    participant.key,
    participant.abbreviation,
    participant.shortName,
    participant.name,
  ];

  for (const value of directAliases) {
    const normalized = normalizeSelectionToken(value);
    if (normalized) aliases.add(normalized);
  }

  const opponentTokens = new Set(
    [opponent?.key, opponent?.abbreviation, opponent?.shortName, opponent?.name]
      .flatMap((value) => selectionTokenParts(value))
      .filter(Boolean)
  );
  for (const token of selectionTokenParts(participant.name)) {
    if (token.length >= 3 && !opponentTokens.has(token)) {
      aliases.add(token);
    }
  }

  return aliases;
}

function resolveGameParticipantAliases(
  game: CanonicalGame | undefined,
  participantKey: string | null | undefined
) {
  if (!game || !participantKey) {
    return null;
  }

  const normalizedParticipant = normalizeSelectionToken(participantKey);
  const homeAliases = participantAliases(
    game.homeParticipant,
    game.awayParticipant
  );
  const awayAliases = participantAliases(
    game.awayParticipant,
    game.homeParticipant
  );

  if (homeAliases.has(normalizedParticipant)) {
    return {
      canonical: homeAliases,
      opposing: awayAliases,
    };
  }

  if (awayAliases.has(normalizedParticipant)) {
    return {
      canonical: awayAliases,
      opposing: homeAliases,
    };
  }

  return null;
}

function textMatchesAlias(sourceMarket: string, alias: string) {
  if (!alias) {
    return false;
  }
  if (sourceMarket === alias) {
    return true;
  }

  const sourceTokens = sourceMarket.split(/\s+/).filter(Boolean);
  const aliasParts = alias.split(/\s+/).filter(Boolean);
  return (
    aliasParts.length > 0 && tokenPartsContainAll(sourceTokens, aliasParts)
  );
}

function sourceTextMatchesAliases(sourceMarket: string, aliases: Set<string>) {
  return [...aliases].some((alias) => textMatchesAlias(sourceMarket, alias));
}

export function sourceSelectionMatchesInstrument(
  instrument: MarketInstrument,
  source: LatestSourceView,
  game?: CanonicalGame
) {
  const sourceMarket = normalizeSelectionToken(
    `${source.raw.selectionKey ?? ""} ${source.raw.label ?? ""}`
  );
  if (!sourceMarket) {
    return true;
  }

  const expected = normalizeSelectionToken(
    instrument.participantKey ?? instrument.selection
  );
  const selection = normalizeSelectionToken(instrument.selection);
  const tokens = sourceMarket.split(/\s+/).filter(Boolean);
  const expectedParts = selectionTokenParts(
    instrument.participantKey ?? instrument.selection
  );
  const hasExpectedParts =
    expectedParts.length === 0 || tokenPartsContainAll(tokens, expectedParts);

  const participantAliases = resolveGameParticipantAliases(
    game,
    instrument.participantKey ?? instrument.selection
  );
  if (participantAliases) {
    const matchesCanonical = sourceTextMatchesAliases(
      sourceMarket,
      participantAliases.canonical
    );
    const matchesOpposing = sourceTextMatchesAliases(
      sourceMarket,
      participantAliases.opposing
    );
    if (matchesCanonical) {
      return true;
    }
    if (matchesOpposing) {
      return false;
    }
  }

  if (expected && sourceMarket === expected) {
    return true;
  }

  if (selection && sourceMarket === selection) {
    return true;
  }

  if (
    (instrument.family === "player-prop" ||
      instrument.family === "team-prop") &&
    (selection === "over" || selection === "under")
  ) {
    return hasExpectedParts && tokens.includes(selection);
  }

  if (
    instrument.family === "total" &&
    (selection === "over" || selection === "under")
  ) {
    return tokens.includes(selection);
  }

  return expected ? hasExpectedParts : false;
}

export function gapToSeverity(gap: number, lineMismatch: boolean) {
  if (gap >= 0.18) {
    return "critical" as const;
  }
  if (gap >= 0.1 || (lineMismatch && gap >= 0.04)) {
    return "high" as const;
  }
  if (gap >= 0.05 || lineMismatch) {
    return "medium" as const;
  }
  return "low" as const;
}

export function clampAlertLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 25;
  }

  return Math.min(100, Math.max(1, Math.floor(value)));
}

export function normalizeAlertNumber(
  value: number | undefined,
  fallback: number,
  min: number
) {
  if (value == null || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, value);
}
