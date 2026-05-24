// LivePage (US-031 / PRD §FR-20, US-206).
//
// Opt-in current-game live view: polls /v1/live/:gameId and /v1/board/:gameId
// every 30 s and renders a Recharts intensity timeline with fire markers from
// /v1/board observations at K_MAD_LIVE (the API enforces K=3.0 on this route).
//
// AC pins from US-031:
//   • Polls useLive(gameId) and useBoard(gameId) at refetchInterval=30000.
//   • Timeline shows intensity (line) + fire markers (yellow dots on fired=1).
//   • No silent-rebuild helpers imported from packages/db or packages/detectors.
//     Pre-aggregated median/MAD values arrive as data fields on the board API
//     response; those are not function calls and not imports. (See US-028's
//     grep-guard convention — never name the forbidden symbol in comments.)

import type { JSX } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { colors } from "@signal-console/ui";

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import {
  useBoard,
  useLive,
  useMicrostructure,
  type BoardObservation,
  type MicrostructureEvent,
} from "../../data/queries";
import { navigateTo } from "../../router";

interface LivePageProps {
  readonly gameId: string | null;
}

const POLL_MS = 30_000;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatClock(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return TIME_FMT.format(d);
}

interface ChartPoint {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly intensity: number;
  readonly fired: number;
}

// Recharts' `data` prop is typed as a mutable array; return a mutable copy
// here so we don't need a type-assertion at the call site. The strict ESLint
// `consistent-type-assertions: never` rule forbids `as` casts repo-wide.
function buildChartData(observations: readonly BoardObservation[]): ChartPoint[] {
  return [...observations]
    .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0))
    .map((o) => ({
      bucketStart: o.bucketStart,
      bucketEnd: o.bucketEnd,
      intensity: o.intensity,
      fired: o.fired,
    }));
}

// Snap an off-price-print event to the board bucket whose half-open window
// [bucketStart, bucketEnd) contains the event (same rule as PbpAnchoredIncidents).
// Returns null when the event falls outside every bucket (before the first or
// after the last) so we do not draw a misleading off-axis marker.
export function snapEventToBucket(
  eventIso: string,
  buckets: readonly { readonly bucketStart: string; readonly bucketEnd: string }[],
): string | null {
  const eventMs = Date.parse(eventIso);
  if (!Number.isFinite(eventMs) || buckets.length === 0) return null;
  for (const b of buckets) {
    const startMs = Date.parse(b.bucketStart);
    const endMs = Date.parse(b.bucketEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs <= eventMs && eventMs < endMs) return b.bucketStart;
  }
  return null;
}

interface IntensityTimelineProps {
  readonly data: ChartPoint[];
  readonly offPriceEvents: readonly MicrostructureEvent[];
}

function IntensityTimeline({ data, offPriceEvents }: IntensityTimelineProps): JSX.Element {
  const fires = data.filter((d) => d.fired === 1);
  const offPriceMarkers = offPriceEvents
    .map((ev) => ({ snapped: snapEventToBucket(ev.eventTimestamp, data), ev }))
    .filter((m): m is { snapped: string; ev: MicrostructureEvent } => m.snapped !== null);
  return (
    // Fixed-height container so the layout doesn't shift between empty/loading
    // and the first resolved poll (US-031 AC #6: "renders without a layout-shift
    // flash").
    <div className="h-72 w-full" data-testid="live-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.2} strokeDasharray="2 4" />
          <XAxis
            dataKey="bucketStart"
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: string) => v.slice(11, 19)}
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: colors.surface1,
              border: `1px solid ${colors.surface2}`,
              borderRadius: 0,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
              color: colors.textHi,
            }}
            labelFormatter={(label) =>
              typeof label === "string" ? label.slice(11, 19) : String(label)
            }
          />
          <Line
            type="monotone"
            dataKey="intensity"
            stroke={colors.accentGreen}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: colors.accentGreen, stroke: colors.accentGreen }}
            isAnimationActive={false}
          />
          {fires.map((f) => (
            <ReferenceDot
              key={`board-${f.bucketStart}`}
              x={f.bucketStart}
              y={f.intensity}
              r={4}
              fill={colors.accentYellow}
              stroke={colors.accentYellow}
              ifOverflow="extendDomain"
            />
          ))}
          {offPriceMarkers.map((m, idx) => (
            <ReferenceLine
              key={`offprice-${m.ev.id}-${String(idx)}`}
              x={m.snapped}
              stroke={colors.negative}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              ifOverflow="extendDomain"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function InvalidGameFallback(): JSX.Element {
  return (
    <section data-testid="live-no-game">
      <h2 className="text-lg font-semibold text-text-hi">Live</h2>
      <p className="mt-3 text-sm text-text-md">
        Click a game from Recent to open its live view. Live polls every 30 s and is opt-in — there
        is no preload from the Recent list.
      </p>
      <a
        href="/"
        onClick={(e) => {
          navigateTo(e, "/");
        }}
        className="mt-6 inline-block border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from"
      >
        Back to Recent
      </a>
    </section>
  );
}

export function LivePage({ gameId }: LivePageProps): JSX.Element {
  // Hooks must run unconditionally; pass empty id to disable while null. The
  // 30 s poll is set here and nowhere else — Recent's useBoard stays one-shot
  // so opening Recent never triggers polling.
  const safeId = gameId ?? "";
  const live = useLive(safeId, { refetchInterval: POLL_MS });
  const board = useBoard(safeId, { refetchInterval: POLL_MS });
  // Pair board-mad with off-price-print on the same chart — the report's
  // headline finding: "pairing it with the big-off-price-bet alarm catches
  // what either one misses." See innovation-team-suspend-signal-report
  // §formulas.
  const micro = useMicrostructure(safeId, { refetchInterval: POLL_MS });

  if (gameId === null) {
    return <InvalidGameFallback />;
  }

  const networkErrored =
    (live.isError && isNetworkError(live.error)) || (board.isError && isNetworkError(board.error));

  const banner = networkErrored ? (
    <ApiUnreachableBanner error={live.error ?? board.error ?? null} />
  ) : live.isError ? (
    <QueryErrorBanner query={live} label="Failed to load live ticks" />
  ) : board.isError ? (
    <QueryErrorBanner query={board} label="Failed to load board observations" />
  ) : null;

  const observations: readonly BoardObservation[] = board.data?.observations ?? [];
  const chartData = buildChartData(observations);
  const fires = observations.filter((o) => o.fired === 1);
  const offPriceEvents: readonly MicrostructureEvent[] = micro.data?.events ?? [];
  const k = board.data?.k ?? 3.0;
  const tickCount = live.data?.ticks.length ?? 0;
  const lastWindowEnd = live.data?.windowEnd ?? null;
  const lastTickTime =
    live.data !== undefined && live.data.ticks.length > 0
      ? (live.data.ticks[live.data.ticks.length - 1]?.capturedAt ?? null)
      : null;

  return (
    <section data-testid="live-page" data-game-id={gameId}>
      {banner}
      <a
        href="/"
        onClick={(e) => {
          navigateTo(e, "/");
        }}
        data-testid="live-back-to-recent"
        className="inline-block text-xs font-mono text-text-lo hover:text-text-hi"
      >
        ← Recent
      </a>

      <div className="mt-4 flex items-baseline justify-between gap-6">
        <h2 className="text-lg font-semibold text-text-hi" data-testid="live-title">
          {gameId}
        </h2>
        <p
          className="tabular font-mono text-xs text-text-lo"
          data-testid="live-meta"
          aria-live="polite"
        >
          {live.isLoading
            ? "loading…"
            : `${String(tickCount)} tick${tickCount === 1 ? "" : "s"} · last poll ${formatClock(
                lastWindowEnd,
              )}${lastTickTime !== null ? ` · last tick ${formatClock(lastTickTime)}` : ""}`}
        </p>
      </div>

      <div className="mt-8" data-testid="live-board-panel">
        <div className="flex items-baseline justify-between gap-6">
          <h3 className="text-sm font-semibold text-text-hi">
            board-mad fires (K=
            <span data-testid="live-k" className="text-accent-yellow">
              {k.toFixed(1)}
            </span>
            ) <span className="text-text-lo">+</span> off-price prints
          </h3>
          <p className="tabular font-mono text-xs text-text-lo">
            <span
              data-testid="live-fires-count"
              className={fires.length > 0 ? "text-accent-yellow" : "text-text-md"}
            >
              {String(fires.length)}
            </span>{" "}
            board ·{" "}
            <span data-testid="live-offprice-count" className="text-negative">
              {String(offPriceEvents.length)}
            </span>{" "}
            off-price · {String(observations.length)} bucket
            {observations.length === 1 ? "" : "s"}
          </p>
        </div>

        <div className="mt-4">
          {board.isLoading ? (
            <div
              className="h-72 w-full bg-surface-1"
              data-testid="live-timeline-loading"
              role="status"
              aria-label="loading timeline"
            />
          ) : board.isError ? null : observations.length === 0 ? (
            <div
              className="flex h-72 w-full items-center justify-center bg-surface-1"
              data-testid="live-timeline-empty"
            >
              <p className="font-mono text-sm text-text-lo">
                No board observations yet. Polling every 30 s…
              </p>
            </div>
          ) : (
            <IntensityTimeline data={chartData} offPriceEvents={offPriceEvents} />
          )}
        </div>

        <div
          className="mt-3 flex items-center gap-5 font-mono text-[11px] text-text-lo"
          data-testid="live-legend"
        >
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-[1.5px] w-5 bg-accent-green" />
            $wt intensity
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent-yellow" />
            board-mad fire
          </span>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-3 w-[2px] bg-negative"
              style={{ borderRight: `1.5px dashed ${colors.negative}` }}
            />
            off-price print
          </span>
        </div>
      </div>
    </section>
  );
}
