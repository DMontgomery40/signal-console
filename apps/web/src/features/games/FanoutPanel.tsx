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

import type { JSX } from "react";
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
function MicrostructureStrip({
  events,
}: {
  readonly events: readonly FanoutMicroEvent[];
}): JSX.Element {
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
  return (
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
        {events.map((e) => {
          // Highlight "concentrated off-price prints" — the report's
          // canonical trigger shape: volumeShare ≥ 0.10 AND offPriceDistance
          // ≥ 0.40. Same thresholds as off-price-print detector defaults.
          const isOffPrice =
            e.volumeShare !== null &&
            e.offPriceDistance !== null &&
            e.volumeShare >= 0.1 &&
            e.offPriceDistance >= 0.4;
          const alertFrame = e.deltaSecondsFromAlert;
          const phrase =
            alertFrame < 0
              ? `${Math.abs(alertFrame).toFixed(0)}s before`
              : alertFrame > 0
                ? `${alertFrame.toFixed(0)}s after`
                : "at alert";
          return (
            <tr
              key={`${e.eventTimestamp}-${e.sourceMarketId}`}
              className={`border-t border-surface-1 ${
                isOffPrice ? "bg-accent-yellow/5" : ""
              }`}
              data-testid="fanout-microstructure-row"
            >
              <td className="py-2 pr-4 font-mono text-text-md">{e.instrument}</td>
              <td className="tabular py-2 pr-4 font-mono text-text-hi">
                {e.tradePrice === null ? "—" : e.tradePrice.toFixed(3)}
              </td>
              <td
                className={`tabular py-2 pr-4 font-mono ${
                  isOffPrice ? "text-accent-yellow" : "text-text-md"
                }`}
              >
                {e.offPriceDistance === null ? "—" : e.offPriceDistance.toFixed(3)}
              </td>
              <td
                className={`tabular py-2 pr-4 font-mono ${
                  isOffPrice ? "text-accent-yellow" : "text-text-md"
                }`}
              >
                {e.volumeShare === null ? "—" : `${(e.volumeShare * 100).toFixed(1)}%`}
              </td>
              <td className="tabular py-2 pr-4 font-mono text-text-md">
                {e.notional === null ? "—" : `$${e.notional.toFixed(2)}`}
              </td>
              <td className="tabular py-2 pr-2 font-mono text-text-md">{phrase}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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
            <th className="py-2 font-normal">Contribution</th>
            <th className="py-2 font-normal">In bucket</th>
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
      <p className="font-mono text-[11px] text-text-lo" data-testid="fanout-movers-caveat">
        <span className="font-semibold text-text-md">In bucket</span> is when the market moved within
        the 60s alert window (0–60s from bucket start). The alert itself confirms at the end of the
        window. This is NOT lead time over the trading desk.
      </p>
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
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
          Play-by-play ±5 min  ·  hot = scoring/rebound/turnover, warm = foul/assist, cool = bookkeeping
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
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
          Top market movers  (board lane — markets repricing inside the 60s alert bucket)
        </p>
        <MoversTable movers={movers} />
      </div>

      <div>
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
          Polymarket trade prints ±5 min  (off-price lane — gold rows are concentrated
          off-price prints: vol_share ≥ 10% AND off-price-dist ≥ 0.40)
        </p>
        <MicrostructureStrip events={microstructureEvents} />
      </div>
    </div>
  );
}
