// Fanout narrative generator (US-051 / PRD §FR-21).
//
// Template-based one-liner that ties a fired bucket to its closest PBP
// anchor event and its top market mover. No LLM, no model dependency:
// the only inputs are the structured fanout payload (PBP events with
// deltaSecondsFromFire and movers with ipDelta + contributionPct) and a
// small set of formatting rules.
//
// Anchor selection rule: closest event by |Δt| EXCLUDING substitutions
// and timeouts (those are bookkeeping, not information arrival). Fall
// back to absolute-closest if the window is sub/timeout-only so the
// analyst still sees something rather than the empty-window form.
//
// Honest empty form is required when no PBP within ±5 min: the owner
// explicitly wants ">5 min worthless / <3 useful / <1 gold" to be
// reflected in the UI's framing — when nothing landed in the window,
// say so plainly rather than guess at causality.

import type { FanoutMover, FanoutPbpEvent } from "./fanout";

const BORING_ACTION_TYPES: ReadonlySet<string> = new Set(["substitution", "timeout"]);
const SIGNIFICANT_OTHER_THRESHOLD = 0.15;

export interface RenderFanoutNarrativeArgs {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly pbp: readonly FanoutPbpEvent[];
  readonly movers: readonly FanoutMover[];
}

export function renderFanoutNarrative(args: RenderFanoutNarrativeArgs): string {
  // The alert is the bucket_END — that's the moment a causal watcher can
  // confirm the threshold crossed and surface a desk-actionable signal.
  // Calling it "Fire at bucket_start" was misleading; the previous wording
  // suggested the desk saw the alert 1 second after the play when the
  // actual confirmation point is 60s after bucket_start.
  const alertLabel = formatTimeLabel(args.bucketEnd);
  const anchor = pickAnchorEvent(args.pbp);
  const topMover = args.movers[0];
  const moverFragment =
    topMover !== undefined
      ? `top mover ${topMover.instrument} (ΔIP ${formatSignedDelta(topMover.ipDelta)}, ${topMover.contributionPct.toFixed(1)}%)`
      : "no qualifying market movers in bucket";
  const significantOthers = countSignificantOthers(args.movers);
  const tailFragment = formatTail(significantOthers);
  if (anchor === null) {
    return `Alert at ${alertLabel}Z — no PBP within ±5 min — ${moverFragment}.${tailFragment}`;
  }
  // deltaSecondsFromAlert is signed against bucket_end. Negative = play
  // happened BEFORE the alert confirmed (desk reacted N seconds after the
  // play). Positive = play happened AFTER the alert (desk got a heads-up).
  const deltaLabel = formatAlertDeltaPhrase(anchor.deltaSecondsFromAlert);
  const anchorLabel = describeAnchor(anchor);
  const gameClock = formatGameClock(anchor.period, anchor.clock);
  const gameClockFragment = gameClock !== null ? ` (${gameClock})` : "";
  return `Alert at ${alertLabel}Z — ${anchorLabel}${gameClockFragment} ${deltaLabel} — ${moverFragment}.${tailFragment}`;
}

// Parse NBA play-by-play game clock ("PT08M19.00S") + period number into the
// trader-readable "Q3 8:19" form. Period 5+ = OT.
export function formatGameClock(period: number | null, clock: string | null): string | null {
  if (period === null || clock === null) return null;
  const match = /^PT(?:(\d+)M)?(\d+(?:\.\d+)?)S$/.exec(clock);
  if (match === null) return null;
  const minutes = match[1] !== undefined ? Number(match[1]) : 0;
  const seconds = Math.floor(Number(match[2]));
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  const periodLabel = period >= 5 ? `OT${String(period - 4)}` : `Q${String(period)}`;
  return `${periodLabel} ${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

function pickAnchorEvent(events: readonly FanoutPbpEvent[]): FanoutPbpEvent | null {
  // Pick the non-boring PBP event whose time is closest to the alert
  // confirmation (bucket_end). Earlier code used distance from bucket_start,
  // which biased toward bucket-edge events (e.g. a TEAM rebound 1s before
  // the bucket) over events inside the bucket (e.g. Hartenstein at -23s
  // vs alert). The disputed play we're trying to explain is more likely
  // the in-bucket event than the pre-bucket adjacent one.
  let best: FanoutPbpEvent | null = null;
  let bestAbs = Infinity;
  for (const e of events) {
    if (e.actionType !== null && BORING_ACTION_TYPES.has(e.actionType)) continue;
    const abs = Math.abs(e.deltaSecondsFromAlert);
    if (abs < bestAbs) {
      bestAbs = abs;
      best = e;
    }
  }
  if (best === null && events.length > 0) {
    return events[0] ?? null;
  }
  return best;
}

function describeAnchor(event: FanoutPbpEvent): string {
  const desc = event.description;
  if (desc !== null && desc.length > 0) return desc;
  const actionType = event.actionType;
  if (actionType !== null) return actionType;
  return "PBP event";
}

function countSignificantOthers(movers: readonly FanoutMover[]): number {
  let n = 0;
  for (let i = 1; i < movers.length; i += 1) {
    const m = movers[i]!;
    if (m.ipDelta !== null && Math.abs(m.ipDelta) > SIGNIFICANT_OTHER_THRESHOLD) {
      n += 1;
    }
  }
  return n;
}

function formatTail(n: number): string {
  if (n <= 0) return "";
  const noun = n === 1 ? "market" : "markets";
  return ` ${String(n)} other ${noun} moved >0.15 IP.`;
}

function formatTimeLabel(bucketStart: string): string {
  return bucketStart.slice(11, 19);
}

// Phrase a signed seconds-from-alert delta in plain English so the trader
// doesn't have to interpret "+/-Ns" twice. Negative = play before alert
// (system reacted N seconds after the play). Positive = play after alert
// (system flagged the bucket N seconds before this play landed in PBP).
function formatAlertDeltaPhrase(deltaSecFromAlert: number): string {
  const abs = Math.abs(deltaSecFromAlert);
  const rounded = abs.toFixed(0);
  if (deltaSecFromAlert < 0) return `${rounded}s before alert`;
  if (deltaSecFromAlert > 0) return `${rounded}s after alert`;
  return "at alert";
}

function formatSignedDelta(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}
