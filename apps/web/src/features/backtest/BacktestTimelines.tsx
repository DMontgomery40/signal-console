// Backtest per-game timelines (US-038).
//
// One small Recharts timeline per game in the executed window, capped at 20.
// The intensity line is sourced from the SNAPSHOT (snapshot.response.observations)
// so its `data` prop is referentially stable across K changes — the chart never
// remounts when the Cry Wolf dial moves. Fire markers are sourced from the
// RECOMPUTE output (recomputeView.observations) so they update in place as K
// changes. Splitting the data this way is the load-bearing technical pattern
// behind AC #3 ("markers update in place as the dial moves; no chart remount").

import { useMemo, type JSX } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, XAxis } from "recharts";

import { colors } from "@signal-console/ui";

import { useGame, type BacktestObservation } from "../../data/queries";

const MAX_GAMES = 20;

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

interface IntensityPoint {
  readonly bucketStart: string;
  readonly intensity: number;
}

interface FirePoint {
  readonly bucketStart: string;
  readonly intensity: number;
}

interface GroupedObservations {
  readonly gameId: string;
  readonly intensitySeries: readonly IntensityPoint[];
  readonly fires: readonly FirePoint[];
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

// `snapshotObservations` and `recomputedObservations` carry the SAME
// (gameId, bucketStart) keyset by construction — the recompute walks the same
// observations and only mutates `fired` / `baselineMedian` / `baselineMad`. We
// emit a stable per-game IntensityPoint[] from the snapshot, and a per-game
// FirePoint[] from the recompute. The chart `data` prop reads from the
// intensitySeries (snapshot) so it never changes identity on a K move.
function buildGroups(
  snapshotObservations: readonly BacktestObservation[],
  recomputedObservations: readonly BacktestObservation[],
): readonly GroupedObservations[] {
  const intensityGroups = groupByGame(snapshotObservations);
  const recomputeGroups = groupByGame(recomputedObservations);
  const out: GroupedObservations[] = [];
  for (const [gameId, list] of intensityGroups) {
    const intensitySeries: IntensityPoint[] = list.map((o) => ({
      bucketStart: o.bucketStart,
      intensity: o.intensity,
    }));
    const recomputed = recomputeGroups.get(gameId) ?? list;
    const fires: FirePoint[] = recomputed
      .filter((o) => o.fired === 1)
      .map((o) => ({ bucketStart: o.bucketStart, intensity: o.intensity }));
    out.push({ gameId, intensitySeries, fires });
  }
  return out.slice(0, MAX_GAMES);
}

function GameIdChip({ gameId }: { readonly gameId: string }): JSX.Element {
  // Opaque identifier chip — borrowed from the Detectors / Settings chip
  // pattern: text-lo border, tabular monospace, uppercase tracking on the
  // label. We use surface-1 fill rather than transparent so the chip reads as
  // a distinct unit against the row whitespace.
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
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span
        data-testid="backtest-timeline-sport"
        data-from-recompute={fromRecompute ? "1" : "0"}
        className="text-xs uppercase tracking-[0.08em] text-text-lo"
      >
        {sport ?? "—"}
      </span>
      <span
        data-testid="backtest-timeline-scheduled-start"
        className="tabular font-mono text-xs text-text-md"
      >
        {scheduledStart === null ? "—" : formatScheduledStart(scheduledStart)}
      </span>
      <GameIdChip gameId={gameId} />
    </div>
  );
}

function TimelineChart({
  intensitySeries,
  fires,
}: {
  readonly intensitySeries: readonly IntensityPoint[];
  readonly fires: readonly FirePoint[];
}): JSX.Element {
  // Recharts' `data` prop is typed as a mutable array (same reason LivePage
  // makes a mutable copy). We freeze identity via the parent useMemo on
  // intensitySeries — the spread here is the unfreezing step Recharts wants.
  const data = [...intensitySeries];
  return (
    <div className="h-20 w-full" data-testid="backtest-timeline-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 12, left: 4 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.15} strokeDasharray="2 4" />
          <XAxis
            dataKey="bucketStart"
            tick={{ fill: colors.textLo, fontSize: 9, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: string) => v.slice(11, 16)}
            minTickGap={48}
            interval="preserveStartEnd"
          />
          <Line
            type="monotone"
            dataKey="intensity"
            stroke={colors.accentGreen}
            strokeWidth={1}
            dot={false}
            isAnimationActive={false}
          />
          {fires.map((f) => (
            <ReferenceDot
              key={f.bucketStart}
              x={f.bucketStart}
              y={f.intensity}
              r={3}
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

function TimelineRow({
  group,
  fromRecompute,
}: {
  readonly group: GroupedObservations;
  readonly fromRecompute: boolean;
}): JSX.Element {
  return (
    <div
      data-testid="backtest-timeline-row"
      data-game-id={group.gameId}
      data-from-recompute={fromRecompute ? "1" : "0"}
      className="flex flex-col gap-2 border-t border-surface-1 py-4"
    >
      <div className="flex items-baseline justify-between gap-4">
        <MetaLabel gameId={group.gameId} fromRecompute={fromRecompute} />
        <span
          data-testid="backtest-timeline-fires"
          className={`tabular font-mono text-xs ${group.fires.length > 0 ? "text-accent-yellow" : "text-text-lo"}`}
        >
          {String(group.fires.length)} fire{group.fires.length === 1 ? "" : "s"}
        </span>
      </div>
      <TimelineChart intensitySeries={group.intensitySeries} fires={group.fires} />
    </div>
  );
}

export interface BacktestTimelinesProps {
  // Snapshot observations: stable across K changes. Drives the intensity line
  // identity so the chart never remounts when the dial moves.
  readonly snapshotObservations: readonly BacktestObservation[];
  // Recomputed observations: same shape, but `fired` reflects the current K.
  // Falls back to snapshotObservations when no recompute is available (e.g.
  // off-price-print or pre-recompute state).
  readonly recomputedObservations: readonly BacktestObservation[];
  // True iff the recompute pipeline produced the firing flags; used as the
  // `data-from-recompute` canary on each row so a regression that drops the
  // recompute path stays detectable in tests.
  readonly fromRecompute: boolean;
}

export function BacktestTimelines({
  snapshotObservations,
  recomputedObservations,
  fromRecompute,
}: BacktestTimelinesProps): JSX.Element {
  const groups = useMemo(
    () => buildGroups(snapshotObservations, recomputedObservations),
    [snapshotObservations, recomputedObservations],
  );
  if (groups.length === 0) {
    return (
      <p data-testid="backtest-timelines-empty" className="mt-4 text-sm text-text-md">
        No per-game observations in this window.
      </p>
    );
  }
  return (
    <div data-testid="backtest-timelines" className="mt-4 flex flex-col">
      {groups.map((g) => (
        <TimelineRow key={g.gameId} group={g} fromRecompute={fromRecompute} />
      ))}
    </div>
  );
}
