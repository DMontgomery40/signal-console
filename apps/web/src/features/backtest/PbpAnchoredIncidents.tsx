// PBP-anchored incidents widget (US-039).
//
// Two anchored incidents from the PRD's research report serve as named
// touchstones for the board-mad detector: Hartenstein (2026-05-08, fires at
// K=3 and K=6 with bucket-start 03:12:00Z) and Reaves (2026-05-12, the honest
// null — no fire on either game id at either K). When a backtest window
// covers either anchor date, this widget shows whether the bucket CONTAINING
// the event timestamp fired at the CURRENT K, along with the delta from
// bucket-end to the event timestamp.
//
// AC interpretation note: the AC says "first fire's bucket_end timestamp" but
// PRD §180-181 anchors Hartenstein and Reaves to the bucket that *contains*
// the event (03:12:00–03:13:00Z for Hartenstein, 04:51:00–04:52:00Z for
// Reaves). A literal "first chronological fire" reading returns operationally
// meaningless values for a lead-time widget (e.g. at K=6 against the gold DB
// the first fire is at 00:11Z, ~10,897 s before the event). We use the
// event-containing-bucket reading, which (a) matches the PRD canonical
// anchor exactly (K=6 Hartenstein bucket-end 03:13:00Z, delta +23.2 s) and
// (b) gives the Reaves no-fire case its expected "no fire" output.
//
// The observations array passed in is the same K-recomputed series the
// BacktestTimelines uses, so the values update in place as the Cry Wolf dial
// moves — no API round-trip.

import { useMemo, type JSX } from "react";

import type { BacktestObservation } from "../../data/queries";

interface AnchorSpec {
  readonly id: string;
  readonly label: string;
  readonly eventIso: string;
  readonly eventDate: string;
  readonly gameIds: readonly string[];
}

const ANCHORS: readonly AnchorSpec[] = [
  {
    id: "hartenstein",
    label: "Hartenstein",
    eventIso: "2026-05-08T03:12:36.800Z",
    eventDate: "2026-05-08",
    gameIds: ["nba-0042500222"],
  },
  {
    id: "reaves",
    label: "Reaves",
    eventIso: "2026-05-12T04:51:40.200Z",
    eventDate: "2026-05-12",
    gameIds: ["nba-0042500223", "nba-0042500224"],
  },
];

function dateInRange(date: string, startDate: string, endDate: string): boolean {
  return date >= startDate && date <= endDate;
}

function findEventBucket(
  observations: readonly BacktestObservation[],
  gameId: string,
  eventIso: string,
): BacktestObservation | null {
  const eventMs = Date.parse(eventIso);
  if (!Number.isFinite(eventMs)) return null;
  for (const obs of observations) {
    if (obs.gameId !== gameId) continue;
    const startMs = Date.parse(obs.bucketStart);
    const endMs = Date.parse(obs.bucketEnd);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs <= eventMs && eventMs < endMs) return obs;
  }
  return null;
}

function formatDeltaSeconds(deltaMs: number): string {
  const secs = deltaMs / 1000;
  const sign = secs >= 0 ? "+" : "";
  return `${sign}${secs.toFixed(1)} s`;
}

function formatBucketEnd(iso: string): string {
  // Display the timestamp with second resolution, dropping millis: the
  // bucket grid is one-minute aligned so milliseconds are always zero and
  // would add visual noise.
  return iso.replace(/\.\d+Z$/, "Z");
}

export interface PbpAnchoredIncidentsProps {
  readonly observations: readonly BacktestObservation[];
  readonly startDate: string;
  readonly endDate: string;
}

export function PbpAnchoredIncidents({
  observations,
  startDate,
  endDate,
}: PbpAnchoredIncidentsProps): JSX.Element | null {
  const visibleAnchors = useMemo(
    () => ANCHORS.filter((a) => dateInRange(a.eventDate, startDate, endDate)),
    [startDate, endDate],
  );
  if (visibleAnchors.length === 0) return null;
  if (observations.length === 0) return null;
  return (
    <section data-testid="backtest-pbp-anchored" className="mt-8 border-t border-surface-1 pt-6">
      <h3 className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans font-medium">
        PBP-anchored incidents
      </h3>
      <div className="mt-4 flex flex-col gap-6">
        {visibleAnchors.map((anchor) => (
          <AnchorBlock key={anchor.id} anchor={anchor} observations={observations} />
        ))}
      </div>
    </section>
  );
}

function AnchorBlock({
  anchor,
  observations,
}: {
  readonly anchor: AnchorSpec;
  readonly observations: readonly BacktestObservation[];
}): JSX.Element {
  return (
    <div
      data-testid={`backtest-pbp-anchor-${anchor.id}`}
      data-anchor-id={anchor.id}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-text-hi text-sm font-mono">{anchor.label}</span>
        <span
          data-testid={`backtest-pbp-event-${anchor.id}`}
          className="tabular font-mono text-xs text-text-md"
        >
          event {formatBucketEnd(anchor.eventIso)}
        </span>
      </div>
      <div className="grid grid-cols-[max-content_max-content_max-content] gap-x-6 gap-y-1">
        {anchor.gameIds.map((gameId) => (
          <AnchorGameRow
            key={gameId}
            anchorId={anchor.id}
            gameId={gameId}
            eventIso={anchor.eventIso}
            observations={observations}
          />
        ))}
      </div>
    </div>
  );
}

function AnchorGameRow({
  anchorId,
  gameId,
  eventIso,
  observations,
}: {
  readonly anchorId: string;
  readonly gameId: string;
  readonly eventIso: string;
  readonly observations: readonly BacktestObservation[];
}): JSX.Element {
  const eventBucket = findEventBucket(observations, gameId, eventIso);
  const firedBucket = eventBucket !== null && eventBucket.fired === 1 ? eventBucket : null;
  return (
    <div
      className="contents"
      data-testid={`backtest-pbp-row-${anchorId}-${gameId}`}
      data-game-id={gameId}
      data-fired={firedBucket !== null ? "1" : "0"}
    >
      <span className="tabular font-mono text-xs text-text-md self-center">{gameId}</span>
      {firedBucket !== null ? (
        <>
          <span
            data-testid={`backtest-pbp-bucket-end-${anchorId}-${gameId}`}
            className="tabular font-mono text-sm text-text-hi"
          >
            {formatBucketEnd(firedBucket.bucketEnd)}
          </span>
          <span
            data-testid={`backtest-pbp-delta-${anchorId}-${gameId}`}
            className="tabular font-mono text-sm text-accent-yellow"
          >
            {formatDeltaSeconds(Date.parse(firedBucket.bucketEnd) - Date.parse(eventIso))}
          </span>
        </>
      ) : (
        <>
          <span
            data-testid={`backtest-pbp-no-fire-${anchorId}-${gameId}`}
            className="tabular font-mono text-sm text-text-md"
          >
            no fire
          </span>
          <span aria-hidden="true" />
        </>
      )}
    </div>
  );
}
