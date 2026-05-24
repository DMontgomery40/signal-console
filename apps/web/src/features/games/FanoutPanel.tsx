// FanoutPanel (US-051): the "why did it fire" panel.
//
// Rendered below the 20-bucket context timeline (US-047) when a fired
// bucket is expanded. Three subsections:
//   1. Narrative one-liner (mono, wrapped in an ExplainerCard pointing at
//      "fanout-window" so the user can hover to learn the ±5 min cap
//      reasoning).
//   2. Horizontal PBP timeline (±5 min) with the fire as a yellow vertical
//      ReferenceLine at t=0; PBP events as small dots colored by recency
//      tier; tooltip shows description + deltaSecondsFromFire.
//   3. Movers table with instrument | ipBefore | ipAfter | ΔIP |
//      contributionPct | seconds-from-fire (the seconds chip is also
//      recency-tier colored to match the PBP dot coding).
//
// Recency tier color rule (matches the explainer entry's formal section):
//   |Δt| < 60s        → accent-yellow  (gold-tier proximity)
//   60 ≤ |Δt| < 180s  → text-hi        (good)
//   180 ≤ |Δt| < 300s → text-md        (acceptable)
//   |Δt| ≥ 300s       → not rendered

import { Fragment, useState, type JSX } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ExplainerCard, colors } from "@signal-console/ui";

import {
  useFanout,
  type FanoutMicroEvent,
  type FanoutMover,
  type FanoutPbpEvent,
} from "../../data/queries";

interface FanoutPanelProps {
  readonly gameId: string;
  readonly bucketStart: string;
}

type Tier = "yellow" | "hi" | "md";

function tierFor(deltaSec: number): Tier | null {
  const abs = Math.abs(deltaSec);
  if (abs < 60) return "yellow";
  if (abs < 180) return "hi";
  if (abs < 300) return "md";
  return null;
}

function tierColor(tier: Tier): string {
  switch (tier) {
    case "yellow":
      return colors.accentYellow;
    case "hi":
      return colors.textHi;
    case "md":
      return colors.textMd;
  }
}

function tierClassName(tier: Tier): string {
  switch (tier) {
    case "yellow":
      return "text-accent-yellow";
    case "hi":
      return "text-text-hi";
    case "md":
      return "text-text-md";
  }
}

// PBP-dot heatmap by action significance. The old coloring (yellow/hi/md
// by recency tier) hid the fact that some plays are inherently more
// informative than others — a rebound or a turnover near the alert is
// gold tier; a substitution at the same instant is bookkeeping noise.
// User feedback explicitly asked for heatmap colors on the PBP line.
type Heat = "hot" | "warm" | "cool";

const HOT_ACTIONS: ReadonlySet<string> = new Set([
  "rebound",
  "3pt",
  "2pt",
  "block",
  "steal",
  "turnover",
  "freethrow",
  "violation",
]);
const WARM_ACTIONS: ReadonlySet<string> = new Set([
  "foul",
  "jumpball",
  "assist",
]);

function heatForAction(actionType: string | null): Heat {
  if (actionType === null) return "warm";
  const lower = actionType.toLowerCase();
  if (HOT_ACTIONS.has(lower)) return "hot";
  if (WARM_ACTIONS.has(lower)) return "warm";
  return "cool";
}

function heatColor(h: Heat): string {
  switch (h) {
    case "hot":
      return colors.accentYellow;
    case "warm":
      return colors.textHi;
    case "cool":
      return colors.textLo;
  }
}

function formatDelta(seconds: number): string {
  const sign = seconds >= 0 ? "+" : "";
  return `${sign}${seconds.toFixed(0)}s`;
}

function formatIp(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function formatSignedIp(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

interface PbpPoint {
  readonly delta: number;
  readonly y: number;
  readonly description: string;
  readonly tier: Tier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPbpPoint(value: unknown): value is PbpPoint {
  if (!isRecord(value)) return false;
  return (
    typeof value["delta"] === "number" &&
    typeof value["y"] === "number" &&
    typeof value["description"] === "string" &&
    typeof value["tier"] === "string"
  );
}

function extractPbpPayload(item: unknown): PbpPoint | null {
  if (!isRecord(item)) return null;
  const payload = item["payload"];
  return isPbpPoint(payload) ? payload : null;
}

// Parse NBA ISO-8601 game clock ("PT08M19.00S") + period number into a
// trader-readable "Q3 8:19" string. Period 5+ → "OT1", "OT2", etc.
function formatGameClock(period: number | null | undefined, clock: string | null | undefined): string | null {
  if (period === null || period === undefined || clock === null || clock === undefined) return null;
  const match = /^PT(?:(\d+)M)?(\d+(?:\.\d+)?)S$/.exec(clock);
  if (match === null) return null;
  const minutes = match[1] !== undefined ? Number(match[1]) : 0;
  const seconds = Math.floor(Number(match[2]));
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  const periodLabel = period >= 5 ? `OT${String(period - 4)}` : `Q${String(period)}`;
  return `${periodLabel} ${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

function PbpTimelineChart({ events }: { readonly events: readonly FanoutPbpEvent[] }): JSX.Element {
  // Carry game-clock + description through the chart payload so the tooltip
  // can render "Q3 8:19 · I. Hartenstein REBOUND · 23s before alert".
  type PointPayload = {
    readonly delta: number;
    readonly y: number;
    readonly description: string;
    readonly heat: Heat;
    readonly gameClock: string | null;
    readonly fromAlert: number | null;
  };
  const points: PointPayload[] = events.flatMap((e) => {
    // Still drop events outside ±5min (the report's hard cap). Coloring
    // within-window dots is action-type-based, not recency-tier-based.
    if (Math.abs(e.deltaSecondsFromFire) >= 300) return [];
    return [
      {
        delta: e.deltaSecondsFromFire,
        y: 0.5,
        description: e.description ?? e.actionType ?? "PBP event",
        heat: heatForAction(e.actionType),
        gameClock: formatGameClock(e.period, e.clock),
        fromAlert: typeof e.deltaSecondsFromAlert === "number" ? e.deltaSecondsFromAlert : null,
      },
    ];
  });
  return (
    <div className="h-28 w-full" data-testid="fanout-pbp-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 16, bottom: 32, left: 16 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.15} strokeDasharray="2 4" />
          <XAxis
            type="number"
            dataKey="delta"
            domain={[-300, 300]}
            ticks={[-300, -180, -60, 0, 60, 180, 300]}
            tickFormatter={(v: number) =>
              v === 0 ? "bucket start" : `${v > 0 ? "+" : ""}${v.toFixed(0)}s`
            }
            tick={{ fill: colors.textLo, fontSize: 13, fontFamily: "JetBrains Mono" }}
            label={{
              value: "seconds from bucket start  (alert confirms at +60s)",
              position: "insideBottom",
              offset: -10,
              fill: colors.textLo,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
            }}
          />
          <YAxis type="number" dataKey="y" domain={[0, 1]} hide />
          <Tooltip
            cursor={false}
            contentStyle={{
              background: colors.surface1,
              border: `1px solid ${colors.surface2}`,
              borderRadius: 0,
              fontFamily: "JetBrains Mono",
              fontSize: 12,
              color: colors.textHi,
            }}
            formatter={(_value, _name, item) => {
              if (!isRecord(item)) return ["", ""];
              const payload = item["payload"];
              if (!isRecord(payload)) return ["", ""];
              const desc = typeof payload["description"] === "string" ? payload["description"] : "";
              const delta = typeof payload["delta"] === "number" ? payload["delta"] : 0;
              const gc = typeof payload["gameClock"] === "string" ? payload["gameClock"] : null;
              const fromAlert =
                typeof payload["fromAlert"] === "number" ? payload["fromAlert"] : null;
              const parts: string[] = [];
              if (gc !== null) parts.push(gc);
              parts.push(desc);
              parts.push(formatDelta(delta) + " from bucket start");
              if (fromAlert !== null) {
                const abs = Math.abs(fromAlert);
                const phrase =
                  fromAlert < 0
                    ? `${abs.toFixed(0)}s before alert`
                    : fromAlert > 0
                      ? `${abs.toFixed(0)}s after alert`
                      : "at alert";
                parts.push(phrase);
              }
              return [parts.join("  ·  "), ""];
            }}
            labelFormatter={() => ""}
          />
          <ReferenceLine
            x={0}
            stroke={colors.textLo}
            strokeWidth={1}
            strokeOpacity={0.5}
            strokeDasharray="2 3"
          />
          <ReferenceLine
            x={60}
            stroke={colors.accentYellow}
            strokeWidth={1.5}
            strokeOpacity={0.85}
            label={{
              value: "alert",
              position: "top",
              fill: colors.accentYellow,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
            }}
          />
          {(["hot", "warm", "cool"] as const).map((heat) => {
            const heatPoints = points.filter((p) => p.heat === heat);
            if (heatPoints.length === 0) return null;
            return (
              <Scatter
                key={heat}
                data={[...heatPoints]}
                fill={heatColor(heat)}
                isAnimationActive={false}
                shape="circle"
              />
            );
          })}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// Polymarket trade prints in the ±5min drilldown — the off-price tape, side
// by side with the board movers above. Each row shows the trader-relevant
// surface: market label, trade price, off-price distance (|trade_price −
// surrounding sampled IP|), volume share, dollar notional, and timing
// against the alert.
//
// Routine prints are collapsed on either side of the gold-highlighted
// (concentrated off-price) rows so the strip doesn't drown the eye in
// noise — typical buckets have 1-2 gold rows and ~50 routine ones, and
// the gold rows are the ones the report's Stage-1 off-price-print
// detector treats as the actual signal. User explicitly asked for this
// after seeing the un-collapsed version.

function isConcentratedOffPrice(e: FanoutMicroEvent): boolean {
  // Report's canonical trigger shape: volumeShare ≥ 0.10 AND
  // offPriceDistance ≥ 0.40 — same thresholds as the off-price-print
  // detector defaults.
  return (
    e.volumeShare !== null &&
    e.offPriceDistance !== null &&
    e.volumeShare >= 0.1 &&
    e.offPriceDistance >= 0.4
  );
}

function formatVsAlert(deltaSec: number): string {
  if (deltaSec < 0) return `${Math.abs(deltaSec).toFixed(0)}s before`;
  if (deltaSec > 0) return `${deltaSec.toFixed(0)}s after`;
  return "at alert";
}

function MicroRow({ e, gold }: { readonly e: FanoutMicroEvent; readonly gold: boolean }): JSX.Element {
  return (
    <tr
      className={`border-t border-surface-1 ${gold ? "bg-accent-yellow/5" : ""}`}
      data-testid={gold ? "fanout-microstructure-row-gold" : "fanout-microstructure-row"}
    >
      <td className="py-2 pr-4 font-mono text-text-md">{e.instrument}</td>
      <td className="tabular py-2 pr-4 font-mono text-text-hi">
        {e.tradePrice === null ? "—" : e.tradePrice.toFixed(3)}
      </td>
      <td
        className={`tabular py-2 pr-4 font-mono ${
          gold ? "text-accent-yellow" : "text-text-md"
        }`}
      >
        {e.offPriceDistance === null ? "—" : e.offPriceDistance.toFixed(3)}
      </td>
      <td
        className={`tabular py-2 pr-4 font-mono ${
          gold ? "text-accent-yellow" : "text-text-md"
        }`}
      >
        {e.volumeShare === null ? "—" : `${(e.volumeShare * 100).toFixed(1)}%`}
      </td>
      <td className="tabular py-2 pr-4 font-mono text-text-md">
        {e.notional === null ? "—" : `$${e.notional.toFixed(2)}`}
      </td>
      <td className="tabular py-2 pr-2 font-mono text-text-md">
        {formatVsAlert(e.deltaSecondsFromAlert)}
      </td>
    </tr>
  );
}

interface MicroSegment {
  readonly kind: "gold" | "routine";
  readonly events: readonly FanoutMicroEvent[];
}

// Walk the event list and group consecutive same-kind events into segments
// so the table layout alternates: routine (collapsible) | gold (always
// visible) | routine | gold | routine ...
function partitionByGold(events: readonly FanoutMicroEvent[]): readonly MicroSegment[] {
  const out: MicroSegment[] = [];
  let bufferKind: "gold" | "routine" | null = null;
  let buffer: FanoutMicroEvent[] = [];
  for (const e of events) {
    const kind = isConcentratedOffPrice(e) ? "gold" : "routine";
    if (bufferKind === null || kind === bufferKind) {
      bufferKind = kind;
      buffer.push(e);
      continue;
    }
    out.push({ kind: bufferKind, events: buffer });
    bufferKind = kind;
    buffer = [e];
  }
  if (bufferKind !== null && buffer.length > 0) {
    out.push({ kind: bufferKind, events: buffer });
  }
  return out;
}

// Threshold under which we inline the routine rows instead of collapsing
// them. Below this, collapsing would hide so little that the toggle is
// more noise than the rows themselves.
const ROUTINE_INLINE_THRESHOLD = 2;

function MicrostructureStrip({
  events,
}: {
  readonly events: readonly FanoutMicroEvent[];
}): JSX.Element {
  // Hooks at top, before any early return — keeps React happy across
  // empty/non-empty renders.
  const [expandedSegments, setExpandedSegments] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

  if (events.length === 0) {
    return (
      <p
        className="font-mono text-xs text-text-lo"
        data-testid="fanout-microstructure-empty"
      >
        No Polymarket trade prints in this ±5 min window.
      </p>
    );
  }

  const segments = partitionByGold(events);

  function toggleSegment(idx: number): void {
    setExpandedSegments((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm" data-testid="fanout-microstructure-table">
        <thead>
          <tr className="text-xs uppercase tracking-[0.08em] text-text-lo">
            <th className="py-2 font-normal">Market</th>
            <th className="py-2 font-normal">Trade price</th>
            <th className="py-2 font-normal">Off-price dist</th>
            <th className="py-2 font-normal">Vol share</th>
            <th className="py-2 font-normal">$ notional</th>
            <th className="py-2 font-normal">vs Alert</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, idx) => {
            if (seg.kind === "gold") {
              return (
                <Fragment key={`gold-${String(idx)}`}>
                  {seg.events.map((e) => (
                    <MicroRow key={`${e.eventTimestamp}-${e.sourceMarketId}`} e={e} gold />
                  ))}
                </Fragment>
              );
            }
            // Routine segment. Inline if small; otherwise collapse behind a
            // toggle row showing N hidden + "▸ show" / "▾ hide".
            if (seg.events.length <= ROUTINE_INLINE_THRESHOLD) {
              return (
                <Fragment key={`routine-${String(idx)}`}>
                  {seg.events.map((e) => (
                    <MicroRow
                      key={`${e.eventTimestamp}-${e.sourceMarketId}`}
                      e={e}
                      gold={false}
                    />
                  ))}
                </Fragment>
              );
            }
            const isOpen = expandedSegments.has(idx);
            return (
              <Fragment key={`routine-${String(idx)}`}>
                <tr
                  className="border-t border-surface-1"
                  data-testid="fanout-microstructure-toggle"
                >
                  <td colSpan={6} className="py-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        toggleSegment(idx);
                      }}
                      className="font-mono text-[11px] text-text-lo hover:text-text-hi focus-visible:text-text-hi focus-visible:outline-1 focus-visible:outline-text-md"
                      data-testid="fanout-microstructure-toggle-btn"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? "▾ hide" : "▸ show"} {String(seg.events.length)} routine
                      print{seg.events.length === 1 ? "" : "s"}
                    </button>
                  </td>
                </tr>
                {isOpen
                  ? seg.events.map((e) => (
                      <MicroRow
                        key={`${e.eventTimestamp}-${e.sourceMarketId}`}
                        e={e}
                        gold={false}
                      />
                    ))
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatBucketVolume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

// Volume thresholds for highlighting "where the money was". Tuned to the
// 60s bucket scale — $5k+ is meaningful on a single-game player-prop,
// $25k+ is a heavy bucket. Adjust with operator feedback over time.
function volumeHeatClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return "text-text-md";
  if (v >= 25_000) return "text-accent-yellow font-semibold";
  if (v >= 5_000) return "text-accent-yellow";
  return "text-text-hi";
}

function MoversTable({ movers }: { readonly movers: readonly FanoutMover[] }): JSX.Element {
  if (movers.length === 0) {
    return (
      <p className="font-mono text-xs text-text-lo" data-testid="fanout-movers-empty">
        No qualifying movers in this bucket.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <table className="w-full text-left text-sm" data-testid="fanout-movers-table">
        <thead>
          <tr className="text-xs uppercase tracking-[0.08em] text-text-lo">
            <th className="py-2 font-normal">Instrument</th>
            <th className="py-2 font-normal">ipBefore</th>
            <th className="py-2 font-normal">ipAfter</th>
            <th className="py-2 font-normal">ΔIP</th>
            <th
              className="py-2 font-normal cursor-help"
              title="Cumulative market volume traded during the 60s bucket window. Gold = $5k+, gold-bold = $25k+. The 'show me the money' column — flags where dollars moved, separate from the intensity-weighted contribution %."
            >
              $ bucket vol
            </th>
            <th className="py-2 font-normal">Contribution</th>
            <th
              className="py-2 font-normal cursor-help"
              title="Offset within the 60s alert window (0–60s from bucket start). The alert itself confirms at the END of the window (+60s). This is NOT lead time over the trading desk."
            >
              In bucket
            </th>
          </tr>
        </thead>
        <tbody>
          {movers.map((m) => {
            const tier = tierFor(m.deltaSecondsFromFire) ?? "md";
            return (
              <tr
                key={m.sourceMarketId}
                className="border-t border-surface-1"
                data-testid="fanout-mover-row"
              >
                <td className="py-2 pr-4 font-mono text-text-md">{m.instrument}</td>
                <td className="tabular py-2 pr-4 font-mono text-text-md">{formatIp(m.ipBefore)}</td>
                <td className="tabular py-2 pr-4 font-mono text-text-md">{formatIp(m.ipAfter)}</td>
                <td className="tabular py-2 pr-4 font-mono text-text-hi">
                  {formatSignedIp(m.ipDelta)}
                </td>
                <td
                  className={`tabular py-2 pr-4 font-mono ${volumeHeatClass(m.bucketVolume)}`}
                  data-testid="fanout-mover-bucket-volume"
                >
                  {formatBucketVolume(m.bucketVolume)}
                </td>
                <td className="tabular py-2 pr-4 font-mono text-text-hi">
                  {m.contributionPct.toFixed(1)}%
                </td>
                <td
                  className={`tabular py-2 pr-2 font-mono ${tierClassName(tier)}`}
                  data-testid="fanout-mover-delta"
                >
                  {formatDelta(m.deltaSecondsFromFire)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FanoutPanel({ gameId, bucketStart }: FanoutPanelProps): JSX.Element {
  const fanout = useFanout(gameId, bucketStart);

  if (fanout.isLoading) {
    return (
      <div className="mt-6" data-testid="fanout-panel-loading">
        <p className="font-mono text-xs text-text-lo">Loading fanout…</p>
      </div>
    );
  }
  if (fanout.isError || fanout.data === undefined) {
    return (
      <div className="mt-6" data-testid="fanout-panel-error">
        <p className="font-mono text-xs text-negative">Failed to load fanout for this bucket.</p>
      </div>
    );
  }

  const { narrative, pbp, movers, microstructureEvents } = fanout.data;

  return (
    <div className="mt-6 space-y-6" data-testid="fanout-panel">
      <div data-testid="fanout-narrative">
        <ExplainerCard id="fanout-window">
          <span className="block w-full font-mono text-sm text-text-hi">{narrative}</span>
        </ExplainerCard>
      </div>

      <div>
        <p
          className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo cursor-help"
          title="Play-by-play events within ±5 min of the alert bucket. Dot color is the play's significance: hot (yellow) = scoring/rebound/block/steal/turnover, warm (white) = foul/assist/jumpball, cool (dim) = substitutions/timeouts/period markers. Hover a dot for game-clock + description + vs-alert offset."
        >
          Play-by-play ±5 min
        </p>
        {pbp.length === 0 ? (
          <p className="font-mono text-xs text-text-lo" data-testid="fanout-pbp-empty">
            No play-by-play within ±5 min of this fire
          </p>
        ) : (
          <PbpTimelineChart events={pbp} />
        )}
      </div>

      <div>
        <p
          className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo cursor-help"
          title="Board lane — markets that repriced inside the 60s alert bucket, ranked by intensity contribution (Σ log(1+v)·|Δp| per the board-mad detector)."
        >
          Top market movers
        </p>
        <MoversTable movers={movers} />
      </div>

      <div>
        <p
          className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo cursor-help"
          title="Off-price lane — Polymarket trade prints in the ±5 min window. Gold-highlighted rows are concentrated off-price prints (vol_share ≥ 10% AND off-price-distance ≥ 0.40) — the report's canonical Stage-1 trigger shape. Routine prints are collapsed by default; click the show/hide toggles to expand them."
        >
          Polymarket trade prints ±5 min
        </p>
        <MicrostructureStrip events={microstructureEvents} />
      </div>
    </div>
  );
}
