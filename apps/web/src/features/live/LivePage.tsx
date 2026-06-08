// LivePage (US-031 / PRD §FR-20, US-206).
//
// Opt-in current-game live view: polls /v1/live/:gameId, /v1/ensemble-or/:gameId,
// and point-event Polymarket trade-print surfaces every 30 s. The live screen
// intentionally separates official game/PBP activity from market model output so
// wall-clock market observations are never presented as basketball game-clock
// minutes.

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
  useEnsembleOr,
  useLive,
  useMicrostructure,
  useOffPricePrint,
  useSettings,
  type BoardObservation,
  type EnsembleOrBoardObservation,
  type EnsembleOrFire,
  type MicrostructureEvent,
  type OffPricePrintFire,
} from "../../data/queries";
import { navigateTo } from "../../router";

interface LivePageProps {
  readonly gameId: string | null;
}

const POLL_MS = 30_000;
const MODEL_EVENT_LIMIT = 8;

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const PRICE_FMT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});
const QUANTITY_FMT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});
const PCT_FMT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

function formatClock(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return TIME_FMT.format(d);
}

function formatPeriod(period: number | null): string {
  if (period === null) return "—";
  if (period <= 0) return "pregame";
  if (period <= 4) return `Q${String(period)}`;
  return `OT${String(period - 4)}`;
}

function formatGameClock(clock: string | null): string {
  if (clock === null || clock.length === 0) return "—";
  const match = /^PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(clock);
  if (match === null) return clock;
  const minutes = Number(match[1] ?? "0");
  const secondsRaw = match[2] ?? "0";
  const seconds = Math.floor(Number(secondsRaw));
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return clock;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatGameScore(awayScore: number | null, homeScore: number | null): string {
  if (awayScore === null || homeScore === null) return "—";
  return `${String(awayScore)}-${String(homeScore)}`;
}

function formatPrice(value: number | null): string {
  if (value === null) return "—";
  return PRICE_FMT.format(value);
}

function formatQuantity(value: number | null): string {
  if (value === null) return "—";
  return QUANTITY_FMT.format(value);
}

function formatVolumeShare(value: number | null): string {
  if (value === null) return "—";
  return `${PCT_FMT.format(value * 100)}%`;
}

function latestTradeEvents(events: readonly MicrostructureEvent[]): readonly MicrostructureEvent[] {
  return [...events]
    .sort((a, b) =>
      a.eventTimestamp < b.eventTimestamp ? 1 : a.eventTimestamp > b.eventTimestamp ? -1 : 0,
    )
    .slice(0, MODEL_EVENT_LIMIT);
}

function latestOffPriceFires(fires: readonly OffPricePrintFire[]): readonly OffPricePrintFire[] {
  return [...fires]
    .sort((a, b) => (a.bucketStart < b.bucketStart ? 1 : a.bucketStart > b.bucketStart ? -1 : 0))
    .slice(0, MODEL_EVENT_LIMIT);
}

function detectorScopedTradeEvents(
  events: readonly MicrostructureEvent[],
  fires: readonly OffPricePrintFire[],
): readonly MicrostructureEvent[] {
  const fireKeys = new Set(
    fires
      .filter((fire) => fire.sourceMarketId !== undefined)
      .map((fire) => `${fire.sourceMarketId}|${fire.bucketStart}`),
  );
  const unkeyedFireTimes = new Set(
    fires.filter((fire) => fire.sourceMarketId === undefined).map((fire) => fire.bucketStart),
  );
  return events.filter((event) => {
    if (event.source !== "polymarket" || event.eventType !== "trade") return false;
    return (
      fireKeys.has(`${event.sourceMarketId}|${event.eventTimestamp}`) ||
      unkeyedFireTimes.has(event.eventTimestamp)
    );
  });
}

export interface TradePrintChartPoint {
  readonly timeMs: number;
  readonly eventTimestamp: string;
  readonly instrumentId: string;
  readonly market: string;
  readonly notional: number | null;
  readonly price: number | null;
  readonly size: number | null;
  readonly volumeShare: number | null;
}

export function buildTradePrintChartData(
  events: readonly MicrostructureEvent[],
): TradePrintChartPoint[] {
  return [...events]
    .sort((a, b) =>
      a.eventTimestamp < b.eventTimestamp ? -1 : a.eventTimestamp > b.eventTimestamp ? 1 : 0,
    )
    .map((event) => ({
      timeMs: Date.parse(event.eventTimestamp),
      eventTimestamp: event.eventTimestamp,
      instrumentId: event.instrumentId ?? event.sourceMarketId,
      market: event.sourceMarketId,
      notional: event.notional,
      price: event.tradePrice ?? event.price,
      size: event.size,
      volumeShare: event.volumeShare,
    }))
    .filter((point) => Number.isFinite(point.timeMs) && point.price !== null);
}

export interface ChartPoint {
  readonly timeMs: number;
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly intensity: number;
  readonly threshold: number | null;
  readonly fired: number;
}

// Recharts' `data` prop is typed as a mutable array; return a mutable copy
// here so we don't need a type-assertion at the call site. The strict ESLint
// `consistent-type-assertions: never` rule forbids `as` casts repo-wide.
export function buildChartData(observations: readonly BoardObservation[], k: number): ChartPoint[] {
  return [...observations]
    .sort((a, b) => (a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0))
    .map((o) => ({
      timeMs: Date.parse(o.bucketStart),
      bucketStart: o.bucketStart,
      bucketEnd: o.bucketEnd,
      intensity: o.intensity,
      threshold: o.warmedUp ? thresholdFor(o, k) : null,
      fired: o.fired,
    }))
    .filter((p) => Number.isFinite(p.timeMs));
}

function thresholdFor(obs: BoardObservation, k: number): number {
  return obs.threshold ?? obs.baselineMedian + k * obs.baselineMad;
}

function formatAxisTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

interface ChartDomain {
  readonly minMs: number;
  readonly maxMs: number;
}

function chartDomain(data: readonly ChartPoint[]): ChartDomain | null {
  const starts = data.map((d) => d.timeMs).filter(Number.isFinite);
  const ends = data.map((d) => Date.parse(d.bucketEnd)).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  return {
    minMs: Math.min(...starts),
    maxMs: Math.max(...ends),
  };
}

function xAxisDomain(domain: ChartDomain | null): [number | "dataMin", number | "dataMax"] {
  return domain === null ? ["dataMin", "dataMax"] : [domain.minMs, domain.maxMs];
}

// Marker id is a string so the chart can render any off-price fire shape
// that provides a stable id plus event timestamp. React keys accept either a
// simple source id or a composite bucket/source key; per-timestamp dedup is
// preserved.
export interface OffPriceMarker {
  readonly id: string;
  readonly timeMs: number;
}

// Minimal shape the chart needs to render off-price markers. LivePage maps the
// active off-price lane into this tiny chart contract so the visualization
// stays decoupled from any richer transport type.
export interface OffPriceMarkerSource {
  readonly id: string;
  readonly eventTimestamp: string;
}

export function offPriceMarkersForDomain(
  events: readonly OffPriceMarkerSource[],
  domain: ChartDomain | null,
): OffPriceMarker[] {
  if (domain === null) return [];
  const seen = new Set<number>();
  const markers: OffPriceMarker[] = [];
  for (const ev of events) {
    const timeMs = Date.parse(ev.eventTimestamp);
    if (!Number.isFinite(timeMs) || timeMs < domain.minMs || timeMs > domain.maxMs) continue;
    if (seen.has(timeMs)) continue;
    seen.add(timeMs);
    markers.push({ id: ev.id, timeMs });
  }
  return markers.sort((a, b) => a.timeMs - b.timeMs);
}

export interface IntensityTimelineProps {
  readonly data: ChartPoint[];
  readonly offPriceEvents: readonly OffPriceMarkerSource[];
}

export function IntensityTimeline({ data, offPriceEvents }: IntensityTimelineProps): JSX.Element {
  const fires = data.filter((d) => d.fired === 1);
  const domain = chartDomain(data);
  const offPriceMarkers = offPriceMarkersForDomain(offPriceEvents, domain);
  return (
    // Fixed-height container so the layout doesn't shift between empty/loading
    // and the first resolved poll (US-031 AC #6: "renders without a layout-shift
    // flash").
    <div className="h-72 w-full" data-testid="live-timeline">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.2} strokeDasharray="2 4" />
          <XAxis
            dataKey="timeMs"
            type="number"
            domain={xAxisDomain(domain)}
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: number) => formatAxisTime(v)}
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
              typeof label === "number" ? formatAxisTime(label) : String(label)
            }
          />
          <Line
            type="linear"
            dataKey="intensity"
            name="board intensity"
            stroke={colors.accentGreen}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: colors.accentGreen, stroke: colors.accentGreen }}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="threshold"
            name="active state-space threshold"
            connectNulls={false}
            stroke={colors.textLo}
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
            data-testid="live-threshold-line"
          />
          {fires.map((f) => (
            <ReferenceDot
              key={`board-${f.bucketStart}`}
              x={f.timeMs}
              y={f.intensity}
              r={4}
              fill={colors.accentYellow}
              stroke={colors.accentYellow}
              ifOverflow="extendDomain"
            />
          ))}
          {offPriceMarkers.map((m) => (
            <ReferenceLine
              key={`offprice-${String(m.id)}-${String(m.timeMs)}`}
              x={m.timeMs}
              stroke={colors.negative}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              strokeOpacity={0.72}
              ifOverflow="extendDomain"
              data-testid="live-offprice-marker"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface LiveActivityPanelProps {
  readonly activity: NonNullable<ReturnType<typeof buildActivitySnapshot>>;
}

function buildActivitySnapshot(
  liveData: {
    readonly activity?: {
      readonly gameState: {
        readonly awayScore: number | null;
        readonly clock: string | null;
        readonly homeScore: number | null;
        readonly period: number | null;
        readonly status: string;
      } | null;
      readonly playByPlayActionCount: number;
      readonly recentPlayByPlay: readonly {
        readonly actionNumber: number;
        readonly actionType: string | null;
        readonly clock: string | null;
        readonly description: string | null;
        readonly period: number | null;
        readonly scoreAway: string | null;
        readonly scoreHome: string | null;
        readonly teamTricode: string | null;
      }[];
    };
  } | null,
) {
  if (liveData?.activity === undefined) return null;
  return liveData.activity;
}

function LiveActivityPanel({ activity }: LiveActivityPanelProps): JSX.Element {
  const state = activity.gameState;
  const latestActions = activity.recentPlayByPlay.slice(0, 4);
  return (
    <section
      className="mt-6 border-y border-surface-1 py-4"
      data-testid="live-activity-panel"
      aria-label="Live game activity"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">
            game clock
          </p>
          <p className="mt-1 text-sm font-semibold text-text-hi" data-testid="live-game-state">
            {state === null
              ? "No game state"
              : `${formatPeriod(state.period)} ${formatGameClock(state.clock)} · ${state.status}`}
          </p>
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">score</p>
          <p className="mt-1 tabular font-mono text-sm text-text-hi" data-testid="live-score">
            {state === null ? "—" : formatGameScore(state.awayScore, state.homeScore)}
          </p>
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">
            official PBP
          </p>
          <p className="mt-1 tabular font-mono text-sm text-text-hi" data-testid="live-pbp-count">
            {String(activity.playByPlayActionCount)} action
            {activity.playByPlayActionCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {latestActions.length > 0 ? (
        <ol className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="live-pbp-list">
          {latestActions.map((action) => (
            <li
              key={action.actionNumber}
              className="border-l border-surface-2 pl-3"
              data-testid="live-pbp-row"
            >
              <p className="tabular font-mono text-[11px] text-text-lo">
                {formatPeriod(action.period)} {formatGameClock(action.clock)} ·{" "}
                {action.scoreAway ?? "—"}-{action.scoreHome ?? "—"}
                {action.teamTricode !== null ? ` · ${action.teamTricode}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-text-md">
                {action.description ?? action.actionType ?? "Official action"}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

interface BoardStateSpacePanelProps {
  readonly chartData: ChartPoint[];
  readonly fires: readonly BoardObservation[];
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly liveK: number | null;
  readonly observations: readonly BoardObservation[];
  readonly offPriceEvents: readonly OffPriceMarkerSource[];
}

function BoardStateSpacePanel({
  chartData,
  fires,
  isError,
  isLoading,
  liveK,
  observations,
  offPriceEvents,
}: BoardStateSpacePanelProps): JSX.Element {
  return (
    <div className="mt-8" data-testid="live-board-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-sm font-semibold text-text-hi">
          board state-space fires (trigger{" "}
          <span data-testid="live-k" className="text-accent-yellow">
            {liveK !== null ? liveK.toFixed(1) : "—"}
          </span>
          ) <span className="text-text-lo">+</span> off-price prints
        </h3>
        <p className="max-w-full break-words text-left tabular font-mono text-xs text-text-lo sm:text-right">
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
        {isLoading ? (
          <div
            className="h-72 w-full bg-surface-1"
            data-testid="live-timeline-loading"
            role="status"
            aria-label="loading timeline"
          />
        ) : isError ? null : observations.length === 0 ? (
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
        className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] text-text-lo"
        data-testid="live-legend"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-[1.5px] w-5 bg-accent-green" />
          board intensity
        </span>
        <span className="flex items-center gap-2" data-testid="live-threshold-legend">
          <span
            aria-hidden
            className="inline-block h-0 w-5 border-t border-dashed border-text-lo"
          />
          active state-space threshold
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent-yellow" />
          board state-space fire
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
  );
}

interface TradePrintModelPanelProps {
  readonly isUnavailable: boolean;
  readonly isLoading: boolean;
  readonly tradeEvents: readonly MicrostructureEvent[];
  readonly offPriceFires: readonly OffPricePrintFire[];
}

function TradePrintModelPanel({
  isUnavailable,
  isLoading,
  tradeEvents,
  offPriceFires,
}: TradePrintModelPanelProps): JSX.Element {
  const chartData = buildTradePrintChartData(tradeEvents);
  const latestTrades = latestTradeEvents(tradeEvents);
  const latestFires = latestOffPriceFires(offPriceFires);
  return (
    <div className="mt-8" data-testid="live-model-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 className="text-sm font-semibold text-text-hi">
          trade-print model <span className="text-text-lo">(point events)</span>
        </h3>
        <p className="max-w-full break-words text-left tabular font-mono text-xs text-text-lo sm:text-right">
          {isUnavailable ? (
            <span data-testid="live-model-status" className="text-negative">
              unavailable
            </span>
          ) : (
            <>
              <span data-testid="live-trade-count" className="text-text-hi">
                {String(tradeEvents.length)}
              </span>{" "}
              trade print{tradeEvents.length === 1 ? "" : "s"} ·{" "}
              <span
                data-testid="live-trade-offprice-count"
                className={offPriceFires.length > 0 ? "text-negative" : "text-text-md"}
              >
                {String(offPriceFires.length)}
              </span>{" "}
              strict off-price fire{offPriceFires.length === 1 ? "" : "s"}
            </>
          )}
        </p>
      </div>

      {isUnavailable ? (
        <div
          className="mt-4 flex h-56 w-full items-center justify-center bg-surface-1"
          data-testid="live-model-unavailable"
        >
          <p className="font-mono text-sm text-negative">Trade-print model unavailable.</p>
        </div>
      ) : isLoading ? (
        <div
          className="mt-4 h-56 w-full bg-surface-1"
          data-testid="live-model-loading"
          role="status"
          aria-label="loading trade-print model"
        />
      ) : latestTrades.length === 0 ? (
        <div
          className="mt-4 flex h-56 w-full items-center justify-center bg-surface-1"
          data-testid="live-model-empty"
        >
          <p className="font-mono text-sm text-text-lo">No trade-print events yet.</p>
        </div>
      ) : (
        <>
          <TradePrintTimeline data={chartData} offPriceFires={offPriceFires} />
          <div className="mt-4 overflow-x-auto border-y border-surface-1">
            <table
              className="w-full min-w-[720px] border-collapse text-left"
              data-testid="live-trade-table"
            >
              <thead>
                <tr className="font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">
                  <th className="py-2 pr-4 font-medium">time</th>
                  <th className="py-2 pr-4 font-medium">market</th>
                  <th className="py-2 pr-4 text-right font-medium">price</th>
                  <th className="py-2 pr-4 text-right font-medium">size</th>
                  <th className="py-2 pr-4 text-right font-medium">notional</th>
                  <th className="py-2 text-right font-medium">vol share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-1">
                {latestTrades.map((event) => (
                  <tr key={event.id} data-testid="live-trade-row">
                    <td className="py-2 pr-4 tabular font-mono text-xs text-text-md">
                      {formatClock(event.eventTimestamp)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-text-hi">
                      {event.instrumentId ?? event.sourceMarketId}
                    </td>
                    <td className="py-2 pr-4 text-right tabular font-mono text-xs text-text-hi">
                      {formatPrice(event.tradePrice ?? event.price)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular font-mono text-xs text-text-md">
                      {formatQuantity(event.size)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular font-mono text-xs text-text-md">
                      {formatQuantity(event.notional)}
                    </td>
                    <td className="py-2 text-right tabular font-mono text-xs text-text-md">
                      {formatVolumeShare(event.volumeShare)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {latestFires.length > 0 ? (
        <ol className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="live-offprice-fire-list">
          {latestFires.map((fire) => (
            <li
              key={`${fire.bucketStart}|${fire.sourceMarketId ?? "unknown"}`}
              className="border-l border-negative pl-3"
              data-testid="live-offprice-fire-row"
            >
              <p className="tabular font-mono text-[11px] text-text-lo">
                {formatClock(fire.bucketStart)}
                {fire.sourceMarketId !== undefined ? ` · ${fire.sourceMarketId}` : ""}
              </p>
              <p className="mt-0.5 tabular font-mono text-sm text-negative">
                intensity {PRICE_FMT.format(fire.intensity)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

interface TradePrintTimelineProps {
  readonly data: TradePrintChartPoint[];
  readonly offPriceFires: readonly OffPricePrintFire[];
}

function tradePrintDomain(data: readonly TradePrintChartPoint[]): ChartDomain | null {
  const times = data.map((d) => d.timeMs).filter(Number.isFinite);
  if (times.length === 0) return null;
  return { minMs: Math.min(...times), maxMs: Math.max(...times) };
}

function offPriceFireMarkersForTradeDomain(
  fires: readonly OffPricePrintFire[],
  domain: ChartDomain | null,
): OffPriceMarker[] {
  if (domain === null) return [];
  return offPriceMarkersForDomain(
    fires.map((fire) => ({
      id:
        fire.sourceMarketId !== undefined
          ? `${fire.bucketStart}|${fire.sourceMarketId}`
          : fire.bucketStart,
      eventTimestamp: fire.bucketStart,
    })),
    domain,
  );
}

function TradePrintTimeline({ data, offPriceFires }: TradePrintTimelineProps): JSX.Element {
  const domain = tradePrintDomain(data);
  const offPriceMarkers = offPriceFireMarkersForTradeDomain(offPriceFires, domain);
  return (
    <div className="mt-4 h-64 w-full" data-testid="live-trade-timeline">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.2} strokeDasharray="2 4" />
          <XAxis
            dataKey="timeMs"
            type="number"
            domain={xAxisDomain(domain)}
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: number) => formatAxisTime(v)}
            minTickGap={32}
          />
          <YAxis
            dataKey="price"
            domain={[0, 1]}
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: number) => formatPrice(v)}
            width={42}
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
              typeof label === "number" ? formatAxisTime(label) : String(label)
            }
          />
          <Line
            type="linear"
            dataKey="price"
            name="trade price"
            stroke={colors.accentGreen}
            strokeOpacity={0}
            dot={{ r: 3, fill: colors.accentGreen, stroke: colors.accentGreen }}
            activeDot={{ r: 4, fill: colors.accentGreen, stroke: colors.accentGreen }}
            isAnimationActive={false}
          />
          {offPriceMarkers.map((marker) => (
            <ReferenceLine
              key={`trade-offprice-${marker.id}`}
              x={marker.timeMs}
              stroke={colors.negative}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              strokeOpacity={0.72}
              ifOverflow="extendDomain"
              data-testid="live-trade-offprice-marker"
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
  const settings = useSettings({ enabled: safeId.length > 0 });
  const live = useLive(safeId, { refetchInterval: POLL_MS });
  const ensemble = useEnsembleOr(safeId, { refetchInterval: POLL_MS });
  const microstructureTheta = settings.data?.detectorDefaults.offPriceMinVolumeShare;
  const microstructureOptions =
    microstructureTheta === undefined
      ? { enabled: settings.isSuccess, refetchInterval: POLL_MS }
      : {
          enabled: settings.isSuccess,
          refetchInterval: POLL_MS,
          theta: microstructureTheta,
        };
  const microstructure = useMicrostructure(safeId, microstructureOptions);
  const offPricePrint = useOffPricePrint(safeId, { refetchInterval: POLL_MS });

  if (gameId === null) {
    return <InvalidGameFallback />;
  }

  const networkErrored =
    (settings.isError && isNetworkError(settings.error)) ||
    (live.isError && isNetworkError(live.error)) ||
    (ensemble.isError && isNetworkError(ensemble.error)) ||
    (microstructure.isError && isNetworkError(microstructure.error)) ||
    (offPricePrint.isError && isNetworkError(offPricePrint.error));

  const banner = networkErrored ? (
    <ApiUnreachableBanner
      error={
        settings.error ??
        live.error ??
        ensemble.error ??
        microstructure.error ??
        offPricePrint.error ??
        null
      }
    />
  ) : settings.isError ? (
    <QueryErrorBanner query={settings} label="Failed to load detector settings" />
  ) : live.isError ? (
    <QueryErrorBanner query={live} label="Failed to load live ticks" />
  ) : ensemble.isError ? (
    <QueryErrorBanner query={ensemble} label="Failed to load ensemble-or observations" />
  ) : microstructure.isError ? (
    <QueryErrorBanner query={microstructure} label="Failed to load trade-print events" />
  ) : offPricePrint.isError ? (
    <QueryErrorBanner query={offPricePrint} label="Failed to load off-price print model" />
  ) : null;

  const observations: readonly BoardObservation[] = (ensemble.data?.boardObservations ?? []).map(
    (b: EnsembleOrBoardObservation) => ({
      bucketStart: b.bucketStart,
      bucketEnd: b.bucketEnd,
      fired: b.fired,
      intensity: b.intensity,
      baselineMedian: b.baselineMedian,
      baselineMad: b.baselineMad,
      threshold: b.threshold,
      warmedUp: b.warmedUp,
    }),
  );
  const fires = observations.filter((o) => o.fired === 1);
  const offPriceEvents: readonly OffPriceMarkerSource[] = (ensemble.data?.fires ?? [])
    .filter((f: EnsembleOrFire) => f.lane === "offprice")
    .map(
      (f: EnsembleOrFire): OffPriceMarkerSource => ({
        id: f.sourceMarketId !== undefined ? `${f.bucketStart}|${f.sourceMarketId}` : f.bucketStart,
        eventTimestamp: f.bucketStart,
      }),
    );
  const liveK = ensemble.data?.k ?? null;
  const chartData = buildChartData(observations, liveK ?? 0);
  const offPriceFires = offPricePrint.data?.fires ?? [];
  const tradeEvents = detectorScopedTradeEvents(microstructure.data?.events ?? [], offPriceFires);
  const tickCount = live.data?.ticks.length ?? 0;
  const lastWindowEnd = live.data?.windowEnd ?? null;
  const lastTickTime =
    live.data !== undefined && live.data.ticks.length > 0
      ? (live.data.ticks[live.data.ticks.length - 1]?.capturedAt ?? null)
      : null;
  const activity = buildActivitySnapshot(live.data ?? null);

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

      {activity !== null ? <LiveActivityPanel activity={activity} /> : null}

      <BoardStateSpacePanel
        chartData={chartData}
        fires={fires}
        isError={ensemble.isError}
        isLoading={ensemble.isLoading}
        liveK={liveK}
        observations={observations}
        offPriceEvents={offPriceEvents}
      />

      <TradePrintModelPanel
        isUnavailable={settings.isError || microstructure.isError || offPricePrint.isError}
        isLoading={settings.isLoading || microstructure.isLoading || offPricePrint.isLoading}
        tradeEvents={tradeEvents}
        offPriceFires={offPriceFires}
      />
    </section>
  );
}
