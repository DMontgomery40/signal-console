import { classToArtifactClass, getSourceCapability, type ArtifactClass } from "./capability-matrix";
import type { PullJobRequest } from "./contract";
import {
  ODDS_API_IO_SPINE,
  UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS,
  validatePullJobRequest,
  type ValidateOptions,
  type ValidationError,
} from "./validator";

/**
 * PLANNER (dry-run / plan mode).
 *
 * Given a request, returns WITHOUT any provider call or DB write:
 *  - the resolved sources,
 *  - each source's expected ARTIFACT CLASS (canonical | artifact_only | pending),
 *  - the concrete operations it WOULD run, and
 *  - any validation errors.
 *
 * Pure: depends only on `request` and the injected `now`. No I/O.
 */

export type PlannedOperation = {
  readonly kind: "snapshot-to-gold" | "events-snapshot" | "updated-follow" | "live-ws" | "noop";
  readonly description: string;
  /** REST path or ws hint this operation would target, if any. */
  readonly target?: string;
};

export type PlannedSource = {
  readonly id: string;
  readonly artifactClass: ArtifactClass;
  readonly operations: readonly PlannedOperation[];
};

export type PullPlan = {
  readonly ok: boolean;
  readonly resolvedSources: readonly string[];
  readonly bookmakers: readonly string[];
  readonly sources: readonly PlannedSource[];
  readonly errors: readonly ValidationError[];
};

function resolveBookmakers(request: PullJobRequest): readonly string[] {
  const options = request.odds_api_io;
  if (!options) {
    return [];
  }
  return options.use_selected_bookmakers ? [...ODDS_API_IO_SPINE] : options.bookmakers;
}

function planSnapshotEligible(id: string): readonly PlannedOperation[] {
  return [
    {
      kind: "snapshot-to-gold",
      description: `Pull ${id} snapshot and persist to the gold DB as canonical research truth.`,
      target: `gold:${id}`,
    },
  ];
}

function planOddsApiIo(
  request: PullJobRequest,
  bookmakers: readonly string[],
): readonly PlannedOperation[] {
  const options = request.odds_api_io;
  if (!options) {
    return [];
  }
  switch (options.mode) {
    case "events-snapshot":
      return [
        {
          kind: "events-snapshot",
          description: `Discover NBA events via /events, then fetch a snapshot for ${bookmakers.length} bookmaker(s); artifact only, not persisted to gold.`,
          target: (options.event_ids?.length ?? 0) > 0 ? "/v3/odds/multi" : "/v3/odds",
        },
      ];
    case "updated-follow":
      return [
        {
          kind: "updated-follow",
          description: `Follow /odds/updated deltas for ${bookmakers[0] ?? "<bookmaker>"} since the watermark (<= ${UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS}s old); artifact only.`,
          target: "/v3/odds/updated",
        },
      ];
    case "live-ws":
      return [
        {
          kind: "live-ws",
          description: `Open the Odds-API.io WebSocket with markets=${options.markets.join(",")}; artifact only, replay via lastSeq.`,
          target: "wss://api.odds-api.io/v3/ws",
        },
      ];
    default: {
      const exhaustive: never = options.mode;
      return exhaustive;
    }
  }
}

function planPending(id: string): readonly PlannedOperation[] {
  return [
    {
      kind: "noop",
      description: `${id} is pending: reachable only via odds-api-io, no persisted direct adapter; no operations run.`,
    },
  ];
}

/**
 * Build a dry-run plan. Always validates first; if invalid, returns the errors
 * and an empty operation set. Never performs I/O.
 */
export function planPullJob(input: unknown, options: ValidateOptions): PullPlan {
  const validation = validatePullJobRequest(input, options);
  if (!validation.ok) {
    return {
      ok: false,
      resolvedSources: [],
      bookmakers: [],
      sources: [],
      errors: validation.errors,
    };
  }

  const request = validation.request;
  const bookmakers = resolveBookmakers(request);

  const sources: PlannedSource[] = request.sources.map((id) => {
    const capability = getSourceCapability(id);
    // Validation guarantees capability is defined and the mode is supported.
    const sourceClass = capability!.class;
    const artifactClass = classToArtifactClass(sourceClass);

    let operations: readonly PlannedOperation[];
    switch (sourceClass) {
      case "snapshot-eligible":
        operations = planSnapshotEligible(id);
        break;
      case "artifact-only":
        operations = planOddsApiIo(request, bookmakers);
        break;
      case "pending":
        operations = planPending(id);
        break;
      default: {
        const exhaustive: never = sourceClass;
        operations = exhaustive;
      }
    }

    return { id, artifactClass, operations };
  });

  return {
    ok: true,
    resolvedSources: [...request.sources],
    bookmakers,
    sources,
    errors: [],
  };
}
