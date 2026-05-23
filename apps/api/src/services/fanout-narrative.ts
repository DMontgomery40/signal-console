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
  readonly pbp: readonly FanoutPbpEvent[];
  readonly movers: readonly FanoutMover[];
}

export function renderFanoutNarrative(args: RenderFanoutNarrativeArgs): string {
  const timeLabel = formatTimeLabel(args.bucketStart);
  const anchor = pickAnchorEvent(args.pbp);
  const topMover = args.movers[0];
  const moverFragment =
    topMover !== undefined
      ? `top mover ${topMover.instrument} (ΔIP ${formatSignedDelta(topMover.ipDelta)}, ${topMover.contributionPct.toFixed(1)}%)`
      : "no qualifying market movers in bucket";
  const significantOthers = countSignificantOthers(args.movers);
  const tailFragment = formatTail(significantOthers);
  if (anchor === null) {
    return `Fire at ${timeLabel} — no PBP within ±5 min — ${moverFragment}.${tailFragment}`;
  }
  const deltaLabel = formatDeltaLabel(anchor.deltaSecondsFromFire);
  const anchorLabel = describeAnchor(anchor);
  return `Fire at ${timeLabel} — ${anchorLabel} at ${deltaLabel} — ${moverFragment}.${tailFragment}`;
}

function pickAnchorEvent(events: readonly FanoutPbpEvent[]): FanoutPbpEvent | null {
  let best: FanoutPbpEvent | null = null;
  let bestAbs = Infinity;
  for (const e of events) {
    if (e.actionType !== null && BORING_ACTION_TYPES.has(e.actionType)) continue;
    const abs = Math.abs(e.deltaSecondsFromFire);
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

function formatDeltaLabel(deltaSec: number): string {
  const sign = deltaSec >= 0 ? "+" : "";
  return `${sign}${deltaSec.toFixed(0)}s`;
}

function formatSignedDelta(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}
