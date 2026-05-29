import { getSourceCapability, isKnownSource } from "./capability-matrix";
import { pullJobRequestSchema, type PullJobRequest } from "./contract";

/**
 * VALIDATOR. Enforces the provider-policy and cross-field rules with stable
 * error codes (assert on `code`, not message text). The `now` (unix SECONDS)
 * is injected so the time-dependent updated-follow watermark rule stays
 * deterministic and the planner that calls this remains pure.
 */

// Canonical source: packages/adapters/src/odds-api-io-live-comparator.ts
// (ODDS_API_IO_SELECTED_BOOKMAKER_SPINE / ODDS_API_IO_NBA_MARKETS, base
// https://api.odds-api.io/v3). Re-declared locally to keep this shared-contract
// package a dependency leaf (no workspace runtime deps), mirroring the
// detectors package. Keep in sync with the adapter.
export const ODDS_API_IO_SPINE = [
  "Bet365",
  "DraftKings",
  "FanDuel",
  "Kalshi",
  "Polymarket",
] as const;
export const ODDS_API_IO_MARKETS = ["ML", "Spread", "Totals", "Player Props"] as const;

// NEW constants — not present in the adapter; canonical here.
/** `/odds/multi` accepts at most this many eventIds per request. */
export const ODDS_API_IO_MULTI_MAX_EVENT_IDS = 10;
/** `/odds/multi` accepts at most this many bookmakers per request. */
export const ODDS_API_IO_MULTI_MAX_BOOKMAKERS = 30;
/** updated-follow `since` watermark must be no older than this (seconds). */
export const UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS = 60;

export const VALIDATION_CODES = [
  "schema_invalid",
  "unknown_source",
  "unsupported_source_mode",
  "odds_api_io_options_without_source",
  "odds_api_io_source_without_options",
  "date_range_inverted",
  "live_ws_requires_markets",
  "live_ws_league_and_event_ids",
  "updated_follow_requires_one_bookmaker",
  "updated_follow_requires_since",
  "updated_follow_since_stale",
  "events_snapshot_too_many_event_ids",
  "events_snapshot_too_many_bookmakers",
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export type ValidationError = {
  readonly code: ValidationCode;
  readonly message: string;
  readonly path?: string;
};

export type ValidationResult =
  | { readonly ok: true; readonly request: PullJobRequest; readonly errors: readonly [] }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

export type ValidateOptions = {
  /** Unix epoch SECONDS treated as "now" for time-dependent rules. */
  readonly now: number;
};

function resolvedBookmakerCount(options: NonNullable<PullJobRequest["odds_api_io"]>): number {
  if (options.use_selected_bookmakers) {
    return ODDS_API_IO_SPINE.length;
  }
  return options.bookmakers.length;
}

/**
 * Validate a pull-job request. Returns a discriminated result with LOUD,
 * coded errors. Pure: depends only on `request` and the injected `now`.
 */
export function validatePullJobRequest(input: unknown, options: ValidateOptions): ValidationResult {
  const parsed = pullJobRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "schema_invalid" as const,
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }

  const request = parsed.data;
  const errors: ValidationError[] = [];

  // --- date window ---
  if (request.date_from > request.date_to) {
    errors.push({
      code: "date_range_inverted",
      message: `date_from (${request.date_from}) must be <= date_to (${request.date_to}).`,
      path: "date_from",
    });
  }

  // --- source identity + source/mode support ---
  for (const source of request.sources) {
    if (!isKnownSource(source)) {
      errors.push({
        code: "unknown_source",
        message: `Unknown source "${source}". Not present in the capability matrix.`,
        path: "sources",
      });
      continue;
    }
    const capability = getSourceCapability(source);
    if (capability && !capability.supportedModes.includes(request.capture_mode)) {
      errors.push({
        code: "unsupported_source_mode",
        message: `Source "${source}" (${capability.class}) does not support capture_mode "${request.capture_mode}". Supported: ${
          capability.supportedModes.length > 0 ? capability.supportedModes.join(", ") : "<none>"
        }.`,
        path: "capture_mode",
      });
    }
  }

  // --- odds_api_io <-> sources pairing ---
  const sourcesIncludeOddsApiIo = request.sources.includes("odds-api-io");
  if (request.odds_api_io && !sourcesIncludeOddsApiIo) {
    errors.push({
      code: "odds_api_io_options_without_source",
      message: 'odds_api_io options were provided but "odds-api-io" is not listed in sources.',
      path: "odds_api_io",
    });
  }
  if (sourcesIncludeOddsApiIo && !request.odds_api_io) {
    errors.push({
      code: "odds_api_io_source_without_options",
      message:
        'Source "odds-api-io" requires an odds_api_io options block (bookmakers, markets, mode).',
      path: "sources",
    });
  }

  // --- odds_api_io mode-specific rules ---
  const oddsApiIo = request.odds_api_io;
  if (oddsApiIo) {
    if (oddsApiIo.mode === "live-ws") {
      if (oddsApiIo.markets.length === 0) {
        errors.push({
          code: "live_ws_requires_markets",
          message: "live-ws requires at least one market.",
          path: "odds_api_io.markets",
        });
      }
      if (oddsApiIo.league != null && (oddsApiIo.event_ids?.length ?? 0) > 0) {
        errors.push({
          code: "live_ws_league_and_event_ids",
          message: "live-ws cannot combine league and event_ids in the same filter.",
          path: "odds_api_io.event_ids",
        });
      }
    }

    if (oddsApiIo.mode === "updated-follow") {
      if (resolvedBookmakerCount(oddsApiIo) !== 1) {
        errors.push({
          code: "updated_follow_requires_one_bookmaker",
          message: `updated-follow requires exactly one bookmaker (resolved ${resolvedBookmakerCount(
            oddsApiIo,
          )}; use_selected_bookmakers resolves to the ${ODDS_API_IO_SPINE.length}-book spine).`,
          path: "odds_api_io.bookmakers",
        });
      }
      if (oddsApiIo.since == null) {
        errors.push({
          code: "updated_follow_requires_since",
          message: "updated-follow requires a `since` unix-seconds watermark.",
          path: "odds_api_io.since",
        });
      } else if (options.now - oddsApiIo.since > UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS) {
        errors.push({
          code: "updated_follow_since_stale",
          message: `updated-follow since (${oddsApiIo.since}) is older than ${UPDATED_FOLLOW_MAX_SINCE_AGE_SECONDS}s relative to now (${options.now}); use /events + /odds snapshot to resync.`,
          path: "odds_api_io.since",
        });
      }
    }

    if (oddsApiIo.mode === "events-snapshot") {
      const eventIdCount = oddsApiIo.event_ids?.length ?? 0;
      if (eventIdCount > ODDS_API_IO_MULTI_MAX_EVENT_IDS) {
        errors.push({
          code: "events_snapshot_too_many_event_ids",
          message: `events-snapshot uses /odds/multi which accepts at most ${ODDS_API_IO_MULTI_MAX_EVENT_IDS} eventIds (got ${eventIdCount}).`,
          path: "odds_api_io.event_ids",
        });
      }
      if (resolvedBookmakerCount(oddsApiIo) > ODDS_API_IO_MULTI_MAX_BOOKMAKERS) {
        errors.push({
          code: "events_snapshot_too_many_bookmakers",
          message: `events-snapshot uses /odds/multi which accepts at most ${ODDS_API_IO_MULTI_MAX_BOOKMAKERS} bookmakers (resolved ${resolvedBookmakerCount(
            oddsApiIo,
          )}).`,
          path: "odds_api_io.bookmakers",
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, request, errors: [] };
}
