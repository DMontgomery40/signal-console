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

import { ApiUnreachableBanner, isNetworkError } from "../../components/ApiUnreachableBanner";
import { QueryErrorBanner } from "../../components/QueryErrorBanner";
import { useBoard, useGame, type BoardObservation } from "../../data/queries";
import { navigateTo } from "../../router";
import { participantLabel } from "../recent/RecentPage";
import { FanoutPanel } from "./FanoutPanel";

interface GameDetailPageProps {
  readonly gameId: string | null;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatScheduledStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return TIME_FMT.format(d);
}

function formatBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return TIME_FMT.format(d);
}

function formatNumber(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

// Build the 21-point context series around a clicked fired bucket: prior 20
// buckets (chronologically) + the fired bucket itself. `observations` is the
// full /v1/board observations array (US-047 persistence change) including
// fired=0 rows; if the cache predates US-047 the array only has fires and we
// fall back to just the fired bucket + the closest fires we can find.
function buildContextSeries(
  observations: readonly BoardObservation[],
  focusBucketStart: string,
): readonly BoardObservation[] {
  const sorted = [...observations].sort((a, b) =>
    a.bucketStart < b.bucketStart ? -1 : a.bucketStart > b.bucketStart ? 1 : 0,
  );
  const focusIdx = sorted.findIndex((o) => o.bucketStart === focusBucketStart);
  if (focusIdx < 0) return [];
  const start = Math.max(0, focusIdx - 20);
  return sorted.slice(start, focusIdx + 1);
}

function ContextTimeline({
  series,
  focusBucketStart,
  k,
}: {
  readonly series: readonly BoardObservation[];
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
    <div className="h-40 w-full" data-testid="context-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 16, left: 4 }}>
          <CartesianGrid stroke={colors.textLo} strokeOpacity={0.2} strokeDasharray="2 4" />
          <XAxis
            dataKey="bucketStart"
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            tickFormatter={(v: string) => v.slice(11, 19)}
          />
          <YAxis
            tick={{ fill: colors.textLo, fontSize: 10, fontFamily: "JetBrains Mono" }}
            width={36}
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
              r={4}
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
  readonly obs: BoardObservation;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
  readonly contextSeries: readonly BoardObservation[];
  readonly k: number;
}): JSX.Element {
  return (
    <li
      data-testid="fired-bucket-row"
      data-bucket-start={obs.bucketStart}
      data-expanded={isExpanded ? "true" : "false"}
      className="border-t border-surface-1"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        data-testid="fired-bucket-toggle"
        className="grid w-full grid-cols-[1.4fr_1fr_1fr_1fr_1.6fr] gap-x-6 px-2 py-3 text-left transition-colors duration-fast ease-out hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2"
      >
        <span className="tabular font-mono text-sm text-text-md" data-testid="bucket-start">
          {formatBucket(obs.bucketStart)}
        </span>
        <span className="tabular font-mono text-sm text-text-hi" data-testid="bucket-intensity">
          {formatNumber(obs.intensity, 3)}
        </span>
        <span
          className="tabular font-mono text-sm text-text-md"
          data-testid="bucket-baseline-median"
        >
          {formatNumber(obs.baselineMedian, 3)}
        </span>
        <span className="tabular font-mono text-sm text-text-md" data-testid="bucket-baseline-mad">
          {formatNumber(obs.baselineMad, 3)}
        </span>
        <span className="text-sm text-text-lo">
          <ExplainerCard id="trailing-baseline">
            <span data-testid="bucket-explainer-trigger">why this fired</span>
          </ExplainerCard>
        </span>
      </button>
      {isExpanded ? (
        <div className="bg-surface-1 px-4 py-4" data-testid="context-panel">
          <p className="mb-3 font-mono text-xs uppercase tracking-[0.08em] text-text-lo">
            Context: prior elapsed lookback + this fire
          </p>
          <ContextTimeline series={contextSeries} focusBucketStart={obs.bucketStart} k={k} />
          <FanoutPanel gameId={gameId} bucketStart={obs.bucketStart} />
        </div>
      ) : null}
    </li>
  );
}

export function GameDetailPage({ gameId }: GameDetailPageProps): JSX.Element {
  // hooks must be called unconditionally; pass empty id to disable when null.
  const safeId = gameId ?? "";
  const game = useGame(safeId);
  const board = useBoard(safeId);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (gameId === null) {
    return (
      <section>
        <p data-testid="invalid-game-id" className="font-mono text-sm text-negative">
          Invalid game id.
        </p>
        <a
          href="/"
          onClick={(e) => {
            navigateTo(e, "/");
          }}
          className="mt-4 inline-block border border-accent-yellow px-3 py-1.5 text-sm font-medium text-text-hi transition-colors duration-fast ease-out hover:bg-accent-yellow hover:text-surface-0-from"
        >
          Back to Recent
        </a>
      </section>
    );
  }

  const networkErrored =
    (game.isError && isNetworkError(game.error)) || (board.isError && isNetworkError(board.error));

  const banner = networkErrored ? (
    <ApiUnreachableBanner error={game.error ?? board.error ?? null} />
  ) : game.isError ? (
    <QueryErrorBanner query={game} label="Failed to load game metadata" />
  ) : board.isError ? (
    <QueryErrorBanner query={board} label="Failed to load fires" />
  ) : null;

  const observations: readonly BoardObservation[] = board.data?.observations ?? [];
  const fires = observations.filter((o) => o.fired === 1);
  const k = board.data?.k ?? 3.0;

  function handleToggle(bucketStart: string): void {
    setExpanded((prev) => (prev === bucketStart ? null : bucketStart));
  }

  return (
    <section data-testid="game-detail-page">
      {banner}
      <a
        href="/"
        onClick={(e) => {
          navigateTo(e, "/");
        }}
        data-testid="back-to-recent"
        className="inline-block text-xs font-mono text-text-lo hover:text-text-hi"
      >
        ← Recent
      </a>

      <div className="mt-4 flex items-baseline justify-between gap-6">
        <h2 className="text-lg font-semibold text-text-hi" data-testid="game-detail-title">
          {gameId}
        </h2>
        <div className="flex items-baseline gap-4">
          <p className="tabular font-mono text-xs text-text-lo" data-testid="game-detail-meta">
            {game.isLoading
              ? "loading…"
              : game.data !== undefined
                ? `${game.data.sport} · ${game.data.league} · ${formatScheduledStart(
                    game.data.scheduledStart,
                  )}${game.data.status !== null ? ` · ${game.data.status}` : ""}`
                : "—"}
          </p>
          <a
            href={`/live/${encodeURIComponent(gameId)}`}
            data-testid="watch-live-link"
            onClick={(e) => {
              navigateTo(e, `/live/${encodeURIComponent(gameId)}`);
            }}
            className="text-xs font-medium text-accent-green underline-offset-2 hover:underline focus:underline transition-colors duration-fast ease-out"
          >
            Watch live →
          </a>
        </div>
      </div>

      {game.data !== undefined ? (
        <p className="mt-2 tabular font-mono text-sm text-text-hi" data-testid="game-detail-teams">
          {participantLabel(game.data.homeParticipantJson)} vs{" "}
          {participantLabel(game.data.awayParticipantJson)}
        </p>
      ) : null}

      <div className="mt-8" data-testid="fires-panel">
        <h3 className="text-sm font-semibold text-text-hi">Past fires</h3>
        {board.isLoading ? (
          <p className="mt-3 font-mono text-sm text-text-md">Loading fires…</p>
        ) : board.isError ? null : fires.length === 0 ? (
          <p className="mt-3 font-mono text-sm text-text-lo" data-testid="no-fires-empty-state">
            No fires recorded for this game at live sensitivity 3.0
          </p>
        ) : (
          <div className="mt-3 max-h-[70vh] overflow-y-auto bg-surface-1">
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
            <ul data-testid="fired-bucket-list">
              {fires.map((obs) => (
                <FiredBucketRow
                  key={obs.bucketStart}
                  gameId={gameId}
                  obs={obs}
                  isExpanded={expanded === obs.bucketStart}
                  onToggle={() => {
                    handleToggle(obs.bucketStart);
                  }}
                  contextSeries={buildContextSeries(observations, obs.bucketStart)}
                  k={k}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
