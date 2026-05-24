import type {
  ComparableState,
  LatestSourceView,
  ResearchSourceId,
} from "./live-types";

export const marketSourceIds = ["bet365", "kalshi", "polymarket"] as const;
export const predictionMarketSourceIds = ["kalshi", "polymarket"] as const;

export const actionableQuoteFreshnessMs = 15 * 60_000;
export const sameTimeQuoteWindowMs = 10 * 60_000;
export const scheduledScoreGraceMs = 5 * 60_000;

type GameLifecycleInput = {
  gameState?: {
    capturedAt?: string | null;
    isFinal?: boolean | null;
    status: string;
  } | null;
  outcome?: { capturedAt?: string | null } | null;
  scheduledStart: string;
};

export type GameLifecycleKind =
  | "final"
  | "live"
  | "missing-final-confirmation"
  | "missing-fresh-score-state"
  | "scheduled";

export type GameLifecycle = {
  detail: string;
  kind: GameLifecycleKind;
  label: string;
  stateAgeMs?: number | null;
  tone: "critical" | "live" | "neutral" | "warning";
};

function parseTime(value?: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function quotedMarketSourcesFromLatest(
  latestSources: Array<{
    impliedProbability?: number | null;
    source: ResearchSourceId | string;
  }>
) {
  const quoted = new Set(
    latestSources
      .filter((source) => typeof source.impliedProbability === "number")
      .map((source) => source.source)
  );

  return marketSourceIds.filter((source) => quoted.has(source));
}

export function hasBet365PlusPredictionMarket(
  sources: Iterable<ResearchSourceId | string>
) {
  const sourceSet = new Set(sources);
  return (
    sourceSet.has("bet365") &&
    predictionMarketSourceIds.some((source) => sourceSet.has(source))
  );
}

function pricedSourceTimes(
  sources: Array<
    Pick<LatestSourceView, "capturedAt" | "impliedProbability"> & {
      source: ResearchSourceId | string;
    }
  >
) {
  return sources
    .filter((source) => typeof source.impliedProbability === "number")
    .map((source) => ({
      capturedAt: parseTime(source.capturedAt),
      source: source.source,
    }))
    .filter(
      (source): source is { capturedAt: number; source: string } =>
        source.capturedAt != null
    );
}

function hasSameTimeQuoteWindow(
  sources: Array<
    Pick<LatestSourceView, "capturedAt" | "impliedProbability"> & {
      source: ResearchSourceId | string;
    }
  >,
  requireBet365PlusPredictionMarket: boolean,
  maxQuoteTimeGapMs: number
) {
  const priced = pricedSourceTimes(sources);
  if (requireBet365PlusPredictionMarket) {
    const bet365 = priced.filter((source) => source.source === "bet365");
    const externals = priced.filter((source) =>
      predictionMarketSourceIds.includes(
        source.source as (typeof predictionMarketSourceIds)[number]
      )
    );
    return bet365.some((book) =>
      externals.some(
        (external) =>
          Math.abs(book.capturedAt - external.capturedAt) <= maxQuoteTimeGapMs
      )
    );
  }

  return priced.some((left, leftIndex) =>
    priced.some(
      (right, rightIndex) =>
        rightIndex > leftIndex &&
        left.source !== right.source &&
        Math.abs(left.capturedAt - right.capturedAt) <= maxQuoteTimeGapMs
    )
  );
}

export function classifyGameLifecycle(
  input: GameLifecycleInput,
  now = new Date()
): GameLifecycle {
  const nowMs = now.getTime();
  const scheduledAt = parseTime(input.scheduledStart);
  const capturedAt = parseTime(input.gameState?.capturedAt);
  const stateAgeMs = capturedAt == null ? null : nowMs - capturedAt;
  const startsInMs = scheduledAt == null ? null : scheduledAt - nowMs;
  const startedAgoMs = scheduledAt == null ? null : nowMs - scheduledAt;
  const status = input.gameState?.status.toLowerCase() ?? "missing";
  const isFinal =
    Boolean(input.outcome) ||
    input.gameState?.isFinal === true ||
    status === "final";

  if (isFinal) {
    return {
      detail:
        stateAgeMs == null
          ? "Final score is persisted."
          : `Final score persisted; last NBA update ${formatDuration(
              stateAgeMs
            )} ago.`,
      kind: "final",
      label: "Final",
      stateAgeMs,
      tone: "neutral",
    };
  }

  const expectedLiveWindow =
    startedAgoMs != null &&
    startedAgoMs >= scheduledScoreGraceMs &&
    startedAgoMs <= 4 * 60 * 60_000;
  const finalLikelyDue = startedAgoMs != null && startedAgoMs > 4 * 60 * 60_000;
  const stateIsFresh =
    stateAgeMs != null && stateAgeMs >= 0 && stateAgeMs <= 5 * 60_000;

  if (status === "in-play" || status === "live") {
    if (stateIsFresh) {
      return {
        detail: `NBA score updated ${formatDuration(stateAgeMs)} ago.`,
        kind: "live",
        label: "Live",
        stateAgeMs,
        tone: "live",
      };
    }

    return {
      detail:
        stateAgeMs == null
          ? "NBA says the game is in progress, but no update time is attached."
          : `NBA says the game is in progress; last score update ${formatDuration(
              stateAgeMs
            )} ago.`,
      kind: "missing-fresh-score-state",
      label: "Score update missing",
      stateAgeMs,
      tone: "critical",
    };
  }

  if (finalLikelyDue) {
    return {
      detail:
        stateAgeMs == null
          ? "The expected game window has elapsed, but no final score is persisted."
          : `The expected game window has elapsed; last NBA update ${formatDuration(
              stateAgeMs
            )} ago.`,
      kind: "missing-final-confirmation",
      label: "Final confirmation missing",
      stateAgeMs,
      tone: "warning",
    };
  }

  if (expectedLiveWindow && status === "scheduled") {
    return {
      detail:
        stateAgeMs == null
          ? "Tip window is open, but no score update is attached yet."
          : `Tip window is open; NBA still has this as scheduled from ${formatDuration(
              stateAgeMs
            )} ago.`,
      kind: "missing-fresh-score-state",
      label: "Score update missing",
      stateAgeMs,
      tone: "critical",
    };
  }

  return {
    detail:
      startsInMs != null && startsInMs > 0
        ? `Tipoff in ${formatDuration(startsInMs)}.`
        : "No live NBA score is expected right now.",
    kind: "scheduled",
    label: "Scheduled",
    stateAgeMs,
    tone: "neutral",
  };
}

type MarketSignalInput = {
  comparableState?: ComparableState | string;
  gameLifecycle: Pick<GameLifecycle, "kind">;
  latestSources: Array<
    Pick<
      LatestSourceView,
      "capturedAt" | "freshnessMs" | "impliedProbability"
    > & {
      source: ResearchSourceId | string;
    }
  >;
  maxQuoteTimeGapMs?: number;
  requireBet365PlusPredictionMarket?: boolean;
  sourceCount?: number;
};

export type MarketSignalState =
  | "actionable-now"
  | "historical"
  | "invalid"
  | "stale";

export function classifyMarketSignal(
  input: MarketSignalInput,
  now = new Date()
) {
  const quotedSources = quotedMarketSourcesFromLatest(input.latestSources);
  const pricedCount = input.sourceCount ?? quotedSources.length;
  const maxQuoteTimeGapMs = input.maxQuoteTimeGapMs ?? sameTimeQuoteWindowMs;
  const freshSources = input.latestSources.filter((source) => {
    const sourceAgeMs =
      typeof source.freshnessMs === "number" ? source.freshnessMs : null;
    const capturedAt = parseTime(source.capturedAt);
    const ageMs =
      sourceAgeMs != null
        ? sourceAgeMs
        : capturedAt == null
          ? null
          : now.getTime() - capturedAt;

    return (
      typeof source.impliedProbability === "number" &&
      ageMs != null &&
      ageMs >= 0 &&
      ageMs <= actionableQuoteFreshnessMs
    );
  });
  const freshQuotedSources = quotedMarketSourcesFromLatest(freshSources);
  const hasRequiredSourceSet = input.requireBet365PlusPredictionMarket
    ? hasBet365PlusPredictionMarket(quotedSources)
    : pricedCount >= 2;

  if (input.comparableState && input.comparableState !== "comparable") {
    if (input.comparableState === "line-mismatch") {
      return {
        label: "Line mismatch",
        reason:
          "Source lines do not match the canonical instrument line, so this is mapping evidence rather than a probability signal.",
        state: "invalid" as const,
      };
    }
    if (input.comparableState === "selection-mismatch") {
      return {
        label: "Selection mismatch",
        reason:
          "Mapped sources do not point at the same outcome, so the displayed prices are not a like-for-like comparison.",
        state: "invalid" as const,
      };
    }
    return {
      label: "Not actionable",
      reason: "This market is not mapped to a like-for-like comparison.",
      state: "invalid" as const,
    };
  }

  if (!hasRequiredSourceSet) {
    return {
      label: "Not actionable",
      reason: input.requireBet365PlusPredictionMarket
        ? "Needs Bet365 plus Kalshi or Polymarket on this exact market."
        : "Needs at least two priced market sources on this exact market.",
      state: "invalid" as const,
    };
  }

  const hasSameTimeQuotes = hasSameTimeQuoteWindow(
    input.latestSources,
    input.requireBet365PlusPredictionMarket === true,
    maxQuoteTimeGapMs
  );
  if (!hasSameTimeQuotes) {
    return {
      label: "No comparison yet",
      reason:
        "Bet365 and exchange quotes are not available in the same time window.",
      state: "invalid" as const,
    };
  }

  if (input.gameLifecycle.kind === "final") {
    return {
      label: "Past comparison",
      reason:
        "Game is final, so this is review evidence, not a live trading signal.",
      state: "historical" as const,
    };
  }

  const freshEnough = input.requireBet365PlusPredictionMarket
    ? hasBet365PlusPredictionMarket(freshQuotedSources)
    : freshQuotedSources.length >= 2;
  const freshSameTimeEnough = hasSameTimeQuoteWindow(
    freshSources,
    input.requireBet365PlusPredictionMarket === true,
    maxQuoteTimeGapMs
  );

  if (!freshEnough || !freshSameTimeEnough) {
    return {
      label: "Quote window expired",
      reason:
        "The comparison exists, but the latest required quotes are outside the action window.",
      state: "stale" as const,
    };
  }

  return {
    label: "Actionable now",
    reason: "Bet365 and exchange quotes are current on this exact market.",
    state: "actionable-now" as const,
  };
}
