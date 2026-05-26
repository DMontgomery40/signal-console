// LivePage (US-031 / PRD §FR-20, US-206).
//
// Opt-in current-game live view: polls /v1/live/:gameId and /v1/ensemble-or/:gameId
// every 30 s and renders a Recharts intensity timeline with fire markers
// from the Stage-1 cascade (board-mad board lane + off-price-print lane).
//
// AMENDED 2026-05-25 (Codex review P1, then B-followup review P1):
//   • Polls useLive(gameId) and useEnsembleOr(gameId) at refetchInterval=30000.
//   • Timeline shows board intensity (line) + fire markers (yellow dots on
//     fired=1) + off-price markers (red ReferenceLines).
//   • K for the threshold line comes from the ensemble response itself
//     (k field) so the chart's threshold is drawn against the SAME K the
//     runner used to compute the fires — no /v1/settings race.
//   • No silent-rebuild helpers imported from packages/db or packages/detectors.
//     Pre-aggregated median/MAD values arrive as data fields on the ensemble
//     API response; those are not function calls and not imports.

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
  type BoardObservation,
  type EnsembleOrBoardObservation,
  type EnsembleOrFire,
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
  return obs.baselineMedian + k * obs.baselineMad;
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

// AMENDED 2026-05-25 (Codex review P1): marker id widened to string so the
// chart can render off-price prints from either the legacy /v1/microstructure
// shape (numeric DB id) or the new /v1/ensemble-or fire shape (composite key
// of bucketStart + sourceMarketId). React keys accept either; per-timestamp
// dedup is preserved.
export interface OffPriceMarker {
  readonly id: string;
  readonly timeMs: number;
}

// Minimal shape the chart needs to render off-price markers. Both the legacy
// MicrostructureEvent and the new EnsembleOrFire (offprice lane) can satisfy
// it via a small mapping in LivePage. Decouples the chart from either source.
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
      <ResponsiveContainer width="100%" height="100%">
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
            name="active alert threshold"
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
  // Codex review P1 (2026-05-25): switched from useBoard + useMicrostructure
  // to useEnsembleOr so the Live UI now reads the Stage-1 cascade math through
  // the shared runner. /v1/ensemble-or returns board observations (per-bucket
  // aggregates with warmedUp + fired) AND lane-tagged fires (board + offprice)
  // computed by the actual off-price-print detector at live default thresholds.
  // The earlier "/v1/microstructure events labeled as off-price prints" only
  // filtered by volume_share — wrong domain, didn't apply offPriceMinOffPriceDistance.
  const ensemble = useEnsembleOr(safeId, { refetchInterval: POLL_MS });

  if (gameId === null) {
    return <InvalidGameFallback />;
  }

  const networkErrored =
    (live.isError && isNetworkError(live.error)) ||
    (ensemble.isError && isNetworkError(ensemble.error));

  const banner = networkErrored ? (
    <ApiUnreachableBanner error={live.error ?? ensemble.error ?? null} />
  ) : live.isError ? (
    <QueryErrorBanner query={live} label="Failed to load live ticks" />
  ) : ensemble.isError ? (
    <QueryErrorBanner query={ensemble} label="Failed to load ensemble-or observations" />
  ) : null;

  // Adapter: ensemble-or board lane observations have the same field shape
  // as the legacy /v1/board observations — pass through unchanged.
  const observations: readonly BoardObservation[] = (ensemble.data?.boardObservations ?? []).map(
    (b: EnsembleOrBoardObservation) => ({
      bucketStart: b.bucketStart,
      bucketEnd: b.bucketEnd,
      fired: b.fired,
      intensity: b.intensity,
      baselineMedian: b.baselineMedian,
      baselineMad: b.baselineMad,
      warmedUp: b.warmedUp,
    }),
  );
  const fires = observations.filter((o) => o.fired === 1);
  // Codex review P1: ensemble-or offprice fires → minimal OffPriceMarkerSource
  // shape the chart consumes. id = `${bucketStart}|${sourceMarketId}` so a
  // React key collision is impossible across simultaneous markets, and
  // per-timestamp dedup still happens inside offPriceMarkersForDomain.
  const offPriceEvents: readonly OffPriceMarkerSource[] = (ensemble.data?.fires ?? [])
    .filter((f: EnsembleOrFire) => f.lane === "offprice")
    .map(
      (f: EnsembleOrFire): OffPriceMarkerSource => ({
        id: f.sourceMarketId !== undefined ? `${f.bucketStart}|${f.sourceMarketId}` : f.bucketStart,
        eventTimestamp: f.bucketStart,
      }),
    );
  // Codex B-followup review P1 (2026-05-25): K comes from the ensemble
  // response itself, NOT a separate /v1/settings round-trip. The runner
  // computed these fires with this K; threshold line drawn against this K
  // is guaranteed consistent. ensembleOrSchema enforces `k` is REQUIRED
  // (no Zod default) per Codex review P2, so when ensemble.data is
  // defined, k is always the real resolved K. While ensemble.data is
  // undefined (loading / error), `liveK` is null and the label renders "—"
  // — no silent fallback number. observations is also empty during load,
  // so the chart skeleton shows; threshold lines need warmed observations
  // anyway.
  const liveK = ensemble.data?.k ?? null;
  // Chart math: use 0 when liveK is null. observations is empty during
  // loading so this never produces a visible threshold; the 0 just keeps
  // buildChartData's signature happy.
  const chartData = buildChartData(observations, liveK ?? 0);
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
            board-mad fires (sensitivity{" "}
            <span data-testid="live-k" className="text-accent-yellow">
              {liveK !== null ? liveK.toFixed(1) : "—"}
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
          {ensemble.isLoading ? (
            <div
              className="h-72 w-full bg-surface-1"
              data-testid="live-timeline-loading"
              role="status"
              aria-label="loading timeline"
            />
          ) : ensemble.isError ? null : observations.length === 0 ? (
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
            board intensity
          </span>
          <span className="flex items-center gap-2" data-testid="live-threshold-legend">
            <span
              aria-hidden
              className="inline-block h-0 w-5 border-t border-dashed border-text-lo"
            />
            active alert threshold
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
