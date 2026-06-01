import { z } from "zod";

/**
 * Shared pull-job REQUEST contract.
 *
 * This is the single source of truth that BOTH the research-pull CLI and the
 * research-pull API call, so UI rules and worker behavior never drift. The
 * zod schema validates SHAPE only (presence, types, enums); cross-field and
 * provider-policy rules live in `./validator` so they can carry stable error
 * codes and an injected `now`.
 */

export const CAPTURE_MODES = ["historical", "repair", "live-capture"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const MARKET_SCOPES = ["all", "board", "player-props"] as const;
export type MarketScope = (typeof MARKET_SCOPES)[number];

export const ODDS_API_IO_MODES = ["events-snapshot", "updated-follow", "live-ws"] as const;
export type OddsApiIoMode = (typeof ODDS_API_IO_MODES)[number];

/**
 * ISO calendar date (YYYY-MM-DD). The contract uses calendar dates for the
 * pull window; `since` (a unix-seconds watermark) is a separate field used by
 * the updated-follow delta mode.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO calendar date (YYYY-MM-DD)");

const nonEmptyString = z.string().min(1, "must not be empty");

/**
 * Odds-API.io artifact-only options. Note `since` is NOT in the original field
 * enumeration (which listed discriminators); it is required by the
 * updated-follow delta watermark rule and so is carried here.
 */
export const oddsApiIoOptionsSchema = z
  .object({
    bookmakers: z.array(nonEmptyString),
    markets: z.array(nonEmptyString),
    mode: z.enum(ODDS_API_IO_MODES),
    league: nonEmptyString.optional(),
    event_ids: z.array(nonEmptyString).optional(),
    use_selected_bookmakers: z.boolean().optional(),
    /** Unix epoch SECONDS watermark for updated-follow delta pulls. */
    since: z.number().int().nonnegative().optional(),
  })
  .strict();

export type OddsApiIoOptions = z.infer<typeof oddsApiIoOptionsSchema>;

export const pullJobRequestSchema = z
  .object({
    sources: z.array(nonEmptyString).min(1, "at least one source is required"),
    date_from: isoDate,
    date_to: isoDate,
    game_ids: z.array(nonEmptyString).optional(),
    capture_mode: z.enum(CAPTURE_MODES),
    market_scope: z.enum(MARKET_SCOPES),
    odds_api_io: oddsApiIoOptionsSchema.optional(),
  })
  .strict();

export type PullJobRequest = z.infer<typeof pullJobRequestSchema>;
