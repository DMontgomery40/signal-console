import type {
  BoardVolatilityPhaseKind,
  ResearchGameStatus,
} from "@signal-console/domain";

import { parseTimestampMs } from "../board-anomaly-support";

import type { GameStateRow } from "../board-anomaly-observation-context";

type PhaseInput = {
  clock?: string | null;
  minutesToTip?: number | null;
  nowIso: string;
  period?: number | null;
  scheduledStart?: string | null;
  scoreMargin?: number | null;
  status: ResearchGameStatus | string;
  timeline?: GameStateRow[];
};

function parseClockSeconds(clock?: string | null) {
  if (!clock) return null;
  const isoMatch = clock.match(/^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (isoMatch) {
    const minutes = Number(isoMatch[1] ?? 0);
    const seconds = Number(isoMatch[2] ?? 0);
    return Number.isFinite(minutes + seconds) ? minutes * 60 + seconds : null;
  }

  const simpleMatch = clock.match(/^(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (!simpleMatch) return null;
  const minutes = Number(simpleMatch[1]);
  const seconds = Number(simpleMatch[2]);
  return Number.isFinite(minutes + seconds) ? minutes * 60 + seconds : null;
}

function periodStartWindowSeconds(
  period?: number | null,
  clock?: string | null
) {
  const clockSeconds = parseClockSeconds(clock);
  if (clockSeconds == null || period == null || period <= 0) return false;
  const periodLengthSeconds = period <= 4 ? 12 * 60 : 5 * 60;
  return periodLengthSeconds - clockSeconds <= 45;
}

function secondsSinceLastScoreChange(
  timeline: GameStateRow[] | undefined,
  nowMs: number,
  status: string
) {
  if (!timeline || timeline.length === 0 || status !== "in-play") return null;

  let previousScore: string | null = null;
  let lastChangedMs: number | null = null;
  for (const row of timeline) {
    const rowMs = row.capturedAtMs ?? parseTimestampMs(row.capturedAt);
    if (rowMs == null || rowMs > nowMs) continue;
    const scoreKey =
      row.homeScore != null && row.awayScore != null
        ? `${row.homeScore}:${row.awayScore}:${row.period ?? ""}`
        : null;
    if (scoreKey && scoreKey !== previousScore) {
      lastChangedMs = rowMs;
      previousScore = scoreKey;
    }
  }

  if (lastChangedMs == null) return null;
  return Math.max(0, Math.round((nowMs - lastChangedMs) / 1000));
}

export function deriveBoardVolatilityPhase(input: PhaseInput): {
  kind: BoardVolatilityPhaseKind;
  period: number | null;
  clock: string | null;
  secondsFromTip: number | null;
  secondsSinceLastScoreChange: number | null;
} {
  const nowMs = parseTimestampMs(input.nowIso);
  const scheduledStartMs = parseTimestampMs(input.scheduledStart);
  const scheduledSecondsFromTip =
    nowMs != null && scheduledStartMs != null
      ? Math.round((nowMs - scheduledStartMs) / 1000)
      : null;
  const secondsFromTip =
    scheduledSecondsFromTip ??
    (input.minutesToTip != null
      ? -Math.round(Math.max(0, input.minutesToTip) * 60)
      : null);
  const secondsSinceScore = secondsSinceLastScoreChange(
    input.timeline,
    nowMs ?? Number.NaN,
    input.status
  );
  const status = input.status.toLowerCase();

  if (status === "scheduled") {
    return {
      kind:
        secondsFromTip != null && secondsFromTip >= -5 * 60
          ? "near-tip"
          : "pregame",
      period: input.period ?? null,
      clock: input.clock ?? null,
      secondsFromTip,
      secondsSinceLastScoreChange: secondsSinceScore,
    };
  }

  if (status === "final") {
    return {
      kind: "final",
      period: input.period ?? null,
      clock: input.clock ?? null,
      secondsFromTip,
      secondsSinceLastScoreChange: secondsSinceScore,
    };
  }

  if (status !== "in-play" && status !== "live") {
    return {
      kind: "settled-live",
      period: input.period ?? null,
      clock: input.clock ?? null,
      secondsFromTip,
      secondsSinceLastScoreChange: secondsSinceScore,
    };
  }

  const clockSeconds = parseClockSeconds(input.clock);
  const margin = Math.abs(input.scoreMargin ?? Number.NaN);

  let kind: BoardVolatilityPhaseKind = "settled-live";
  if (
    input.period === 1 &&
    clockSeconds != null &&
    12 * 60 - clockSeconds <= 90
  ) {
    kind = "tip-burst";
  } else if (
    secondsFromTip != null &&
    secondsFromTip >= 0 &&
    secondsFromTip <= 90
  ) {
    kind = "tip-burst";
  } else if (periodStartWindowSeconds(input.period, input.clock)) {
    kind = "restart-burst";
  } else if (
    input.period != null &&
    input.period >= 4 &&
    clockSeconds != null &&
    clockSeconds <= 60
  ) {
    kind = "final-minute";
  } else if (
    input.period != null &&
    input.period >= 4 &&
    clockSeconds != null &&
    clockSeconds <= 120 &&
    Number.isFinite(margin) &&
    margin <= 8
  ) {
    kind = "crunch-time";
  }

  return {
    kind,
    period: input.period ?? null,
    clock: input.clock ?? null,
    secondsFromTip,
    secondsSinceLastScoreChange: secondsSinceScore,
  };
}

export function phaseDecayRegime(kind: BoardVolatilityPhaseKind) {
  return kind;
}
