// Backtest per-game timelines (US-038, drilldown UX upgrade US-054).
//
// One card per game in the executed window, capped at 20. Each card:
//   - accent-yellow 3 px left-edge stripe (matches the explainer-system identity)
//   - surface-1 fill
//   - Generous breathing room (≥ 32 px vertical gap between cards)
//   - Header at text-lg/text-base — readable at a glance, not crammed
//   - Larger sparkline (h-40 = 160 px) with YAxis labels visible (was h-20 with
//     clipped Y axis); intensity line in accent-green, fires in accent-yellow
//   - The card is a clickable button — expands inline to show a fires list
//     (mirrors GameDetailPage / US-047 UX exactly); clicking a fire expands
//     further into a context timeline (prior 20 buckets + the fire) plus
//     the FanoutPanel (US-051 PBP + movers).
//
// Snapshot vs recompute data-flow split is preserved from the original US-038
// design: intensity line reads from `snapshotObservations` so it never remounts
// on K change; fire markers + bucket context read from `recomputedObservations`
// so they update in place when the Cry Wolf dial moves.

import { useState, type JSX } from "react";
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

import { ExplainerCard, colors } from "@signal-console/ui";

import { useGame, type BacktestObservation } from "../../data/queries";
import { FanoutPanel } from "../games/FanoutPanel";

const MAX_GAMES = 20;
const CONTEXT_PRIOR_BUCKETS = 20;

const SCHEDULED_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatScheduledStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return SCHEDULED_FMT.format(d);
}

function formatBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return SCHEDULED_FMT.format(d);
}

function formatNumber(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

interface GroupedObservations {
  readonly gameId: string;
  // The snapshot row for every bucket (stable across K). Intensity line reads
  // from here; chart `data` identity never changes on K change.
  readonly snapshotRows: readonly BacktestObservation[];
  // The recomputed row for every bucket (updates on K). Fire markers and the
  // context-timeline threshold read from here.
  readonly recomputedRows: readonly BacktestObservation[];
}

function groupByGame(
  observations: readonly BacktestObservation[],
): Map<string, BacktestObservation[]> {
  const map = new Map<string, BacktestObservation[]>();
  for (const obs of observations) {
    const existing = map.get(obs.gameId);
    if (existing === undefined) {
      map.set(obs.gameId, [obs]);
    } else {
      existing.push(obs);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart));
  }
  return map;
}

function buildGroups(
  snapshotObservations: readonly BacktestObservation[],
  recomputedObservations: readonly BacktestObservation[],
): readonly GroupedObservations[] {
  const snapshotGroups = groupByGame(snapshotObservations);
  const recomputeGroups = groupByGame(recomputedObservations);
  const out: GroupedObservations[] = [];
  for (const [gameId, snapshotRows] of snapshotGroups) {
    const recomputedRows = recomputeGroups.get(gameId) ?? snapshotRows;
    out.push({ gameId, snapshotRows, recomputedRows });
  }
  return out.slice(0, MAX_GAMES);
}

function buildContextSeries(
  recomputedRows: readonly BacktestObservation[],
  focusBucketStart: string,
): readonly BacktestObservation[] {
  const focusIdx = recomputedRows.findIndex((o) => o.bucketStart === focusBucketStart);
  if (focusIdx < 0) return [];
  const start = Math.max(0, focusIdx - CONTEXT_PRIOR_BUCKETS);
  return recomputedRows.slice(start, focusIdx + 1);
}

function GameIdChip({ gameId }: { readonly gameId: string }): JSX.Element {
  return (
    <span
      data-testid="backtest-timeline-game-chip"
      className="inline-flex items-center border border-surface-2 bg-surface-1 px-2 py-0.5 tabular font-mono text-xs text-text-md"
    >
      {gameId}
    </span>
  );
}

function MetaLabel({
  gameId,
  fromRecompute,
}: {
  readonly gameId: string;
  readonly fromRecompute: boolean;
}): JSX.Element {
  const gameQuery = useGame(gameId);
  const sport = gameQuery.data?.sport ?? null;
  const scheduledStart = gameQuery.data?.scheduledStart ?? null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span
        data-testid="backtest-timeline-sport"
        data-from-recompute={fromRecompute ? "1" : "0"}
        className="text-base font-medium uppercase tracking-[0.06em] text-text-hi"
      >
        {sport ?? "—"}
      </span>
      <span
        data-testid="backtest-timeline-scheduled-start"
        className="tabular font-mono text-sm text-text-md"
      >
        {scheduledStart === null ? "—" : formatScheduledStart(scheduledStart)}
      </span>
      <GameIdChip gameId={gameId} />
    </div>
  );
}

function TimelineChart({
  snapshotRows,
  recomputedRows,
}: {
  readonly snapshotRows: readonly BacktestObservation[];
  readonly recomputedRows: readonly BacktestObservation[];
}): JSX.Element {
  // `data` identity is anchored to snapshotRows so the chart never remounts
  // on K change. The spread is the unfreezing step Recharts wants (its `data`
  // prop is typed mutable even though it doesn't mutate).
  const data = snapshotRows.map((o) => ({
    bucketStart: o.bucketStart,
    intensity: o.intensity,
  }));
  const fires = recomputedRows.filter((o) => o.fired === 1);
  return (
    <div className="h-40 w-full" data-testid="backtest-timeline-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 28, left: 4 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.15} strokeDasharray="2 4" />
          <XAxis
            dataKey="bucketStart"
            tick={{ fill: colors.textLo, fontSize: 13, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: string) => v.slice(11, 16)}
            minTickGap={72}
            interval="preserveStartEnd"
            label={{
              value: "UTC (HH:MM)",
              position: "insideBottom",
              offset: -10,
              fill: colors.textLo,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
            }}
          />
          <YAxis
            tick={{ fill: colors.textLo, fontSize: 13, fontFamily: "JetBrains Mono" }}
            width={56}
            label={{
              value: "intensity",
              angle: -90,
              position: "insideLeft",
              fill: colors.textLo,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
              offset: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey="intensity"
            stroke={colors.accentGreen}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {fires.map((f) => (
            <ReferenceDot
              key={f.bucketStart}
              x={f.bucketStart}
              y={f.intensity}
              r={4}
              fill={colors.accentYellow}
              stroke={colors.accentYellow}
              ifOverflow="extendDomain"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ContextTimeline({
  series,
  focusBucketStart,
  k,
}: {
  readonly series: readonly BacktestObservation[];
  readonly focusBucketStart: string;
  readonly k: number;
}): JSX.Element {
  if (series.length === 0) {
    return (
      <p className="font-mono text-xs text-text-lo">No context data available for this bucket.</p>
    );
  }
  const data = series.map((o) => ({
    bucketStart: o.bucketStart,
    intensity: o.intensity,
    threshold: o.baselineMedian + k * o.baselineMad,
  }));
  const focusPoint = data.find((d) => d.bucketStart === focusBucketStart);
  return (
    <div className="h-44 w-full" data-testid="backtest-context-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 28, left: 4 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.2} strokeDasharray="2 4" />
          <XAxis
            dataKey="bucketStart"
            tick={{ fill: colors.textLo, fontSize: 13, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: string) => v.slice(11, 19)}
            minTickGap={64}
            label={{
              value: "UTC (HH:MM:SS)",
              position: "insideBottom",
              offset: -10,
              fill: colors.textLo,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
            }}
          />
          <YAxis
            tick={{ fill: colors.textLo, fontSize: 13, fontFamily: "JetBrains Mono" }}
            width={56}
            label={{
              value: "intensity",
              angle: -90,
              position: "insideLeft",
              fill: colors.textLo,
              fontFamily: "JetBrains Mono",
              fontSize: 11,
              offset: 12,
            }}
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
            dot={{ r: 2, fill: colors.accentGreen, stroke: colors.accentGreen }}
            activeDot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="threshold"
            stroke={colors.textLo}
            strokeWidth={1}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
          <ReferenceLine
            x={focusBucketStart}
            stroke={colors.accentYellow}
            strokeDasharray="2 3"
            strokeOpacity={0.6}
          />
          {focusPoint !== undefined ? (
            <ReferenceDot
              x={focusPoint.bucketStart}
              y={focusPoint.intensity}
              r={5}
              fill={colors.accentYellow}
              stroke={colors.accentYellow}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function FiredBucketRow({
  gameId,
  obs,
  isExpanded,
  onToggle,
  contextSeries,
  k,
}: {
  readonly gameId: string;
  readonly obs: BacktestObservation;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly contextSeries: readonly BacktestObservation[];
  readonly k: number;
}): JSX.Element {
  return (
    <li
      data-testid="backtest-fired-bucket-row"
      data-bucket-start={obs.bucketStart}
      data-expanded={isExpanded ? "true" : "false"}
      className="border-t border-surface-2"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        data-testid="backtest-fired-bucket-toggle"
        className="grid w-full grid-cols-[1.4fr_1fr_1fr_1fr_1.6fr] gap-x-6 px-2 py-3 text-left transition-colors duration-fast ease-out hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2"
      >
        <span className="tabular font-mono text-sm text-text-md">
          {formatBucket(obs.bucketStart)}
        </span>
        <span className="tabular font-mono text-sm text-text-hi">
          {formatNumber(obs.intensity, 3)}
        </span>
        <span className="tabular font-mono text-sm text-text-md">
          {formatNumber(obs.baselineMedian, 3)}
        </span>
        <span className="tabular font-mono text-sm text-text-md">
          {formatNumber(obs.baselineMad, 3)}
        </span>
        <span className="text-sm text-text-lo">
          <ExplainerCard id="trailing-baseline">
            <span data-testid="backtest-bucket-explainer-trigger">why this fired</span>
          </ExplainerCard>
        </span>
      </button>
      {isExpanded ? (
        <div className="bg-surface-1 px-4 py-4" data-testid="backtest-context-panel">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
            Context: prior {CONTEXT_PRIOR_BUCKETS} buckets + this fire
          </p>
          <ContextTimeline series={contextSeries} focusBucketStart={obs.bucketStart} k={k} />
          <FanoutPanel gameId={gameId} bucketStart={obs.bucketStart} />
        </div>
      ) : null}
    </li>
  );
}

function GameCard({
  group,
  fromRecompute,
  k,
}: {
  readonly group: GroupedObservations;
  readonly fromRecompute: boolean;
  readonly k: number;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedFire, setExpandedFire] = useState<string | null>(null);
  const fires = group.recomputedRows.filter((o) => o.fired === 1);

  return (
    <article
      data-testid="backtest-timeline-row"
      data-game-id={group.gameId}
      data-from-recompute={fromRecompute ? "1" : "0"}
      data-expanded={isOpen ? "true" : "false"}
      className="relative overflow-hidden bg-surface-1"
    >
      {/* accent-yellow left-edge stripe — matches the explainer-system identity */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-[3px] bg-accent-yellow"
        data-testid="backtest-timeline-row-stripe"
      />

      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => !prev);
        }}
        aria-expanded={isOpen}
        data-testid="backtest-timeline-row-toggle"
        className="grid w-full grid-cols-[1fr_auto] items-baseline gap-x-6 px-5 py-4 text-left transition-colors duration-fast ease-out hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2"
      >
        <MetaLabel gameId={group.gameId} fromRecompute={fromRecompute} />
        <span
          data-testid="backtest-timeline-fires"
          className={`tabular font-mono text-xl ${fires.length > 0 ? "text-accent-yellow" : "text-text-lo"}`}
        >
          {String(fires.length)} fire{fires.length === 1 ? "" : "s"}
        </span>
      </button>

      <div className="px-5 pb-5">
        <TimelineChart snapshotRows={group.snapshotRows} recomputedRows={group.recomputedRows} />
      </div>

      {isOpen ? (
        <div
          className="border-t border-surface-2 bg-surface-1 px-5 py-5"
          data-testid="backtest-timeline-drilldown"
        >
          <h4 className="text-sm font-semibold text-text-hi">
            Past fires in this game at K={k.toFixed(2)}
          </h4>
          {fires.length === 0 ? (
            <p
              className="mt-3 font-mono text-sm text-text-lo"
              data-testid="backtest-no-fires-empty"
            >
              No fires for this game at K={k.toFixed(2)}.
            </p>
          ) : (
            <div className="mt-3 max-h-[60vh] overflow-y-auto bg-surface-0-to">
              <div
                role="row"
                className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1.6fr] gap-x-6 px-2 pb-3 pt-2 text-xs uppercase tracking-[0.08em] text-text-lo"
              >
                <span>Bucket start</span>
                <span>Intensity</span>
                <span>Baseline med</span>
                <span>Baseline MAD</span>
                <span />
              </div>
              <ul data-testid="backtest-fired-bucket-list">
                {fires.map((obs) => (
                  <FiredBucketRow
                    key={obs.bucketStart}
                    gameId={group.gameId}
                    obs={obs}
                    isExpanded={expandedFire === obs.bucketStart}
                    onToggle={() => {
                      setExpandedFire((prev) =>
                        prev === obs.bucketStart ? null : obs.bucketStart,
                      );
                    }}
                    contextSeries={buildContextSeries(group.recomputedRows, obs.bucketStart)}
                    k={k}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

export interface BacktestTimelinesProps {
  readonly snapshotObservations: readonly BacktestObservation[];
  readonly recomputedObservations: readonly BacktestObservation[];
  readonly fromRecompute: boolean;
  // Current K — used for the threshold line on the context timeline and the
  // drilldown header. Backtest's K dial drives this.
  readonly k: number;
}

export function BacktestTimelines({
  snapshotObservations,
  recomputedObservations,
  fromRecompute,
  k,
}: BacktestTimelinesProps): JSX.Element {
  const groups = buildGroups(snapshotObservations, recomputedObservations);
  if (groups.length === 0) {
    return (
      <p data-testid="backtest-timelines-empty" className="mt-4 text-sm text-text-md">
        No per-game observations in this window.
      </p>
    );
  }
  return (
    <div data-testid="backtest-timelines" className="mt-6 flex flex-col gap-y-8">
      {groups.map((g) => (
        <GameCard key={g.gameId} group={g} fromRecompute={fromRecompute} k={k} />
      ))}
    </div>
  );
}
