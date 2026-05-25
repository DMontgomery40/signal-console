// Tanstack Query hooks for the Signal Console API (US-023).
//
// Single shared fetchJson helper enforces the auth header + Zod-validated
// response shape, so every hook's return type is z.infer<typeof schema> with
// zero `any` and zero `as`.
//
// Zod schemas mirror the shipped API response shapes and are the data boundary
// for the UI. When server-side response schemas change, these client contracts
// must move with them or React Query will fail loudly at runtime.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
} from "@signal-console/detectors/board-mad/config";
import { z } from "zod";

const API_BASE_URL: string =
  typeof import.meta.env.VITE_API_URL === "string" && import.meta.env.VITE_API_URL.length > 0
    ? import.meta.env.VITE_API_URL
    : "";

const SIGNAL_TOKEN: string =
  typeof import.meta.env.VITE_SIGNAL_TOKEN === "string" &&
  import.meta.env.VITE_SIGNAL_TOKEN.length > 0
    ? import.meta.env.VITE_SIGNAL_TOKEN
    : "dev";

async function fetchJson<TOutput>(
  path: string,
  schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  signal?: AbortSignal,
): Promise<TOutput> {
  const init: RequestInit = {
    headers: { "X-Signal-Token": SIGNAL_TOKEN },
    ...(signal !== undefined ? { signal } : {}),
  };
  const res = await fetch(`${API_BASE_URL}${path}`, init);
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)} ${res.statusText} for ${path}`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

// ── Schemas ────────────────────────────────────────────────────────────────

// /v1/games + /v1/games/:gameId — mirrors apps/api/src/routes/games.ts.
const gameRowSchema = z.object({
  id: z.string(),
  sport: z.string(),
  league: z.string(),
  scheduledStart: z.string(),
  homeParticipantJson: z.string(),
  awayParticipantJson: z.string(),
  status: z.string().nullable(),
});
const gamesListSchema = z.object({ games: z.array(gameRowSchema) });

// /v1/board/:gameId — mirrors apps/api/src/routes/board.ts.
const boardObservationSchema = z
  .object({
    bucketStart: z.string(),
    bucketEnd: z.string(),
    fired: z.number().int(),
    intensity: z.number(),
    baselineMedian: z.number(),
    baselineMad: z.number(),
    warmedUp: z.boolean().optional(),
    lane: z.enum(["board", "offprice"]).optional(),
    sourceMarketId: z.string().optional(),
  })
  .transform((obs) => ({
    ...obs,
    warmedUp:
      obs.warmedUp ??
      (obs.fired > 0 || obs.baselineMedian !== 0 || obs.baselineMad !== 0),
  }));
const boardSchema = z.object({
  gameId: z.string(),
  runId: z.number().int(),
  k: z.number(),
  observations: z.array(boardObservationSchema),
});

// /v1/board/:gameId/fanout — PRD §FR-21 (US-051). Strict ±5 min PBP cap
// and per-market intensity contribution decomposition. The route lives
// alongside /v1/board/:gameId in routes/board.ts; the query is keyed on
// (gameId, bucketStart) so the UI re-fetches when a different fired
// bucket is expanded.
const fanoutPbpEventSchema = z.object({
  timeActual: z.string(),
  actionType: z.string().nullable(),
  playerName: z.string().nullable(),
  description: z.string().nullable(),
  deltaSecondsFromFire: z.number(),
  // event_time − bucket_end. Negative = event before alert confirmation.
  // Optional for back-compat with older API responses that pre-dated the
  // honest-framing fix.
  deltaSecondsFromAlert: z.number().optional(),
  // NBA period (1-4 = quarters, 5+ = overtimes). Optional for back-compat.
  period: z.number().nullable().optional(),
  // ISO 8601 duration ("PT08M19.00S"). UI renders "Q3 8:19". Optional for
  // back-compat with older API responses.
  clock: z.string().nullable().optional(),
});
const fanoutMoverSchema = z.object({
  sourceMarketId: z.string(),
  instrument: z.string(),
  ipBefore: z.number().nullable(),
  ipAfter: z.number().nullable(),
  ipDelta: z.number().nullable(),
  contributionPct: z.number(),
  deltaSecondsFromFire: z.number(),
  // Cumulative market volume traded during the 60s bucket. Optional for
  // back-compat with older API responses that pre-dated the money-move
  // column.
  bucketVolume: z.number().nullable().optional(),
});
const fanoutMicroEventSchema = z.object({
  eventTimestamp: z.string(),
  sourceMarketId: z.string(),
  instrument: z.string(),
  tradePrice: z.number().nullable(),
  size: z.number().nullable(),
  notional: z.number().nullable(),
  volumeShare: z.number().nullable(),
  offPriceDistance: z.number().nullable(),
  deltaSecondsFromAlert: z.number(),
});
const fanoutSchema = z
  .object({
    bucketStart: z.string(),
    bucketEnd: z.string(),
    pbp: z.array(fanoutPbpEventSchema),
    movers: z.array(fanoutMoverSchema),
    // Optional input for back-compat: older API responses didn't include the
    // Polymarket trade-print strip yet.
    microstructureEvents: z.array(fanoutMicroEventSchema).optional(),
    narrative: z.string(),
  })
  .transform(({ microstructureEvents, ...fanout }) => ({
    ...fanout,
    microstructureEvents: microstructureEvents ?? [],
  }));

// /v1/live/:gameId — PRD §15: last 5 min of quote_ticks joined to
// source_markets for instrument metadata. Schema matches the shipped route
// (US-028 services/live.ts): { gameId, windowStart, windowEnd, ticks } with
// each tick carrying impliedProbability/volume/heartbeat plus the joined
// instrumentId/rawFamily/rawLabel (no separate sourceMarkets array).
const quoteTickSchema = z.object({
  sourceMarketId: z.string(),
  capturedAt: z.string(),
  impliedProbability: z.number().nullable(),
  volume: z.number(),
  isHeartbeat: z.number().int(),
  instrumentId: z.string().nullable(),
  rawFamily: z.string().nullable(),
  rawLabel: z.string().nullable(),
});
const liveSchema = z.object({
  gameId: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  ticks: z.array(quoteTickSchema),
});

// /v1/microstructure/:gameId — mirrors apps/api/src/routes/microstructure.ts.
const microstructureEventSchema = z.object({
  id: z.number().int(),
  source: z.string(),
  sourceMarketId: z.string(),
  gameId: z.string(),
  instrumentId: z.string().nullable(),
  eventType: z.string(),
  apiSurface: z.string(),
  eventTimestamp: z.string(),
  capturedAt: z.string(),
  price: z.number().nullable(),
  previousPrice: z.number().nullable(),
  tradePrice: z.number().nullable(),
  size: z.number().nullable(),
  notional: z.number().nullable(),
  volume: z.number().nullable(),
  finalMarketVolume: z.number().nullable(),
  volumeShare: z.number().nullable(),
  bestBid: z.number().nullable(),
  bestAsk: z.number().nullable(),
  spread: z.number().nullable(),
  depthScore: z.number().nullable(),
});
const microstructureSchema = z.object({
  gameId: z.string(),
  theta: z.number(),
  events: z.array(microstructureEventSchema),
});

// /v1/ensemble-or/:gameId — mirrors apps/api/src/routes/ensemble-or.ts
// Stage-1 cascade: board-mad board lane + off-price-print fires from the
// shared runner.
const ensembleOrBoardObservationSchema = z.object({
  bucketStart: z.string(),
  bucketEnd: z.string(),
  fired: z.number().int(),
  intensity: z.number(),
  baselineMedian: z.number(),
  baselineMad: z.number(),
  warmedUp: z.boolean(),
});
const ensembleOrFireSchema = z.object({
  bucketStart: z.string(),
  bucketEnd: z.string(),
  intensity: z.number(),
  baselineMedian: z.number().optional(),
  baselineMad: z.number().optional(),
  lane: z.enum(["board", "offprice"]),
  sourceMarketId: z.string().optional(),
});
const ensembleOrSchema = z.object({
  gameId: z.string(),
  runId: z.number().int(),
  // Resolved K the runner computed with (Codex B-followup review P1) —
  // single source of truth for the Live chart's threshold line, eliminates
  // the /v1/settings race. Default applied if an older API serves a
  // response without the field; LivePage degrades gracefully.
  k: z.number().default(3.0),
  boardObservations: z.array(ensembleOrBoardObservationSchema),
  fires: z.array(ensembleOrFireSchema),
});

// /v1/detectors — PRD §15 + §10: registry entries. apps/api/src/routes/detectors.ts
// returns the rows wrapped as { detectors: [...] }; paramsSchema is a JSON
// Schema object produced via zod-to-json-schema and we keep it as a
// passthrough record so the UI can iterate properties without forcing a
// specific JSON-Schema dialect through Zod. `sources` is the closed set the
// detector declares (US-048) — the UI renders the SOURCES chip from it.
const detectorSourceSchema = z.enum(["bet365", "kalshi", "polymarket"]);
const detectorEntrySchema = z.object({
  id: z.string(),
  version: z.string(),
  displayName: z.string(),
  sources: z.array(detectorSourceSchema),
  paramsSchema: z.record(z.unknown()),
});
const detectorsSchema = z.object({ detectors: z.array(detectorEntrySchema) });

// /v1/settings — mirrors apps/api/src/routes/settings.ts.
const sourceRowSchema = z.object({
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  rateLimitCooldown: z.string().nullable(),
});
const sourcesSchema = z.union([
  z.object({
    ingestPaused: z.literal(false),
    bySource: z.record(sourceRowSchema),
  }),
  z.object({
    ingestPaused: z.literal(true),
    lastKnown: z.record(sourceRowSchema),
  }),
]);
const dbInfoSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int(),
  walBytes: z.number().int(),
  pageCount: z.number().int(),
  pageSize: z.number().int(),
  lastModified: z.string(),
  mode: z.enum(["read-only", "error"]),
  openError: z.string().optional(),
});
const cacheDbInfoSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().int(),
  pageCount: z.number().int(),
});
const logEntrySchema = z.object({
  level: z.string(),
  message: z.string(),
  time: z.string().nullable(),
});
const aboutInfoSchema = z.object({
  appVersion: z.string(),
  detectorVersions: z.array(z.object({ id: z.string(), version: z.string() })),
  dbSchemaVersion: z.number().int(),
});
// Detector defaults are runtime-editable via POST /v1/settings/detector-defaults
// (US-053). The shape mirrors apps/api/src/services/detector-defaults.ts.
const detectorDefaultsSchema = z.object({
  kMadLive: z.number(),
  baselineMode: z.enum([
    BOARD_MAD_BASELINE_MODE_TRAILING,
    BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
    BOARD_MAD_BASELINE_MODE_HISTORICAL_BLEND,
  ]),
  bucketSeconds: z.number().int(),
  openingBaselineBuckets: z.number().int(),
  openingRampCompleteBuckets: z.number().int(),
  trailingBuckets: z.number().int(),
  warmupBuckets: z.number().int(),
  freshCapSeconds: z.number().int(),
  historicalLastGames: z.number().int(),
  historicalAwayWeight: z.number(),
  historicalPriorWeight: z.number(),
  historicalRampCompleteGameMinutes: z.number(),
  trailingGameMinutes: z.number(),
  recentWallMinutes: z.number(),
  recentWallWeight: z.number(),
  pbpPreBufferMs: z.number().int(),
  pbpPostBufferMs: z.number().int(),
  // Phase B3: off-price-print thresholds, runtime-tunable.
  offPriceMinVolumeShare: z.number().default(0.1),
  offPriceMinOffPriceDistance: z.number().default(0.4),
});
const settingsSchema = z.object({
  db: dbInfoSchema,
  cacheDb: cacheDbInfoSchema,
  sources: sourcesSchema,
  errors: z.array(logEntrySchema),
  about: aboutInfoSchema,
  detectorDefaults: detectorDefaultsSchema,
});

// ── Inferred public types ──────────────────────────────────────────────────

export type Game = z.infer<typeof gameRowSchema>;
export type GamesList = z.infer<typeof gamesListSchema>;
export type BoardObservation = z.infer<typeof boardObservationSchema>;
export type Board = z.infer<typeof boardSchema>;
export type QuoteTick = z.infer<typeof quoteTickSchema>;
export type Live = z.infer<typeof liveSchema>;
export type MicrostructureEvent = z.infer<typeof microstructureEventSchema>;
export type Microstructure = z.infer<typeof microstructureSchema>;
export type EnsembleOrLive = z.infer<typeof ensembleOrSchema>;
export type EnsembleOrBoardObservation = z.infer<typeof ensembleOrBoardObservationSchema>;
export type EnsembleOrFire = z.infer<typeof ensembleOrFireSchema>;
export type FanoutPbpEvent = z.infer<typeof fanoutPbpEventSchema>;
export type FanoutMover = z.infer<typeof fanoutMoverSchema>;
export type FanoutMicroEvent = z.infer<typeof fanoutMicroEventSchema>;
export type Fanout = z.infer<typeof fanoutSchema>;
export type DetectorEntry = z.infer<typeof detectorEntrySchema>;
export type DetectorsResponse = z.infer<typeof detectorsSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type DetectorDefaults = z.infer<typeof detectorDefaultsSchema>;

// ── Hooks ──────────────────────────────────────────────────────────────────

export function useGames(since?: string): UseQueryResult<GamesList, Error> {
  const sinceKey = since ?? "PT24H";
  const query =
    since !== undefined && since.length > 0
      ? `?since=${encodeURIComponent(since)}`
      : "";
  return useQuery({
    queryKey: ["games", sinceKey],
    queryFn: ({ signal }) => fetchJson(`/v1/games${query}`, gamesListSchema, signal),
  });
}

export function useGame(gameId: string): UseQueryResult<Game, Error> {
  return useQuery({
    queryKey: ["game", gameId],
    queryFn: ({ signal }) =>
      fetchJson(`/v1/games/${encodeURIComponent(gameId)}`, gameRowSchema, signal),
    enabled: gameId.length > 0,
  });
}

// `refetchInterval` is opt-in (US-031 Live page sets 30_000 ms; Recent leaves
// it unset so the fires cell stays one-shot per visit).
export interface PollOptions {
  readonly refetchInterval?: number;
}

export function useLive(gameId: string, opts?: PollOptions): UseQueryResult<Live, Error> {
  return useQuery({
    queryKey: ["live", gameId],
    queryFn: ({ signal }) =>
      fetchJson(`/v1/live/${encodeURIComponent(gameId)}`, liveSchema, signal),
    enabled: gameId.length > 0,
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

export function useBoard(gameId: string, opts?: PollOptions): UseQueryResult<Board, Error> {
  return useQuery({
    queryKey: ["board", gameId],
    queryFn: ({ signal }) =>
      fetchJson(`/v1/board/${encodeURIComponent(gameId)}`, boardSchema, signal),
    enabled: gameId.length > 0,
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

export function useFanout(
  gameId: string,
  bucketStart: string,
): UseQueryResult<Fanout, Error> {
  return useQuery({
    queryKey: ["fanout", gameId, bucketStart],
    queryFn: ({ signal }) =>
      fetchJson(
        `/v1/board/${encodeURIComponent(gameId)}/fanout?bucket_start=${encodeURIComponent(bucketStart)}`,
        fanoutSchema,
        signal,
      ),
    enabled: gameId.length > 0 && bucketStart.length > 0,
  });
}

export function useMicrostructure(
  gameId: string,
  opts?: PollOptions,
): UseQueryResult<Microstructure, Error> {
  return useQuery({
    queryKey: ["microstructure", gameId],
    queryFn: ({ signal }) =>
      fetchJson(
        `/v1/microstructure/${encodeURIComponent(gameId)}`,
        microstructureSchema,
        signal,
      ),
    enabled: gameId.length > 0,
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

// Phase B2 / Codex review P1 (2026-05-25): consume the new live ensemble-or
// route that the shared runner backs. Returns board lane per-bucket
// observations (mirrors /v1/board shape) PLUS lane-tagged fires (board +
// offprice) — the Stage-1 cascade math David's bet365 demo is built around.
export function useEnsembleOr(
  gameId: string,
  opts?: PollOptions,
): UseQueryResult<EnsembleOrLive, Error> {
  return useQuery({
    queryKey: ["ensemble-or", gameId],
    queryFn: ({ signal }) =>
      fetchJson(
        `/v1/ensemble-or/${encodeURIComponent(gameId)}`,
        ensembleOrSchema,
        signal,
      ),
    enabled: gameId.length > 0,
    ...(opts?.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
  });
}

export function useDetectors(): UseQueryResult<DetectorsResponse, Error> {
  return useQuery({
    queryKey: ["detectors"],
    queryFn: ({ signal }) => fetchJson(`/v1/detectors`, detectorsSchema, signal),
  });
}

export function useSettings(): UseQueryResult<Settings, Error> {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => fetchJson(`/v1/settings`, settingsSchema, signal),
  });
}

// /v1/backtest — mirrors apps/api/src/routes/backtest.ts response. The body
// is { detector_id, params, window: {start, end}, game_ids? }; the response
// shape matches BacktestResult: { runId, stats, observations[] }.
// Observations are all-buckets (not fires-only) so US-035/US-036/US-037 can
// recompute kMad and baseline-timing params client-side without re-fetching.
const backtestObservationSchema = z.object({
  gameId: z.string(),
  bucketStart: z.string(),
  bucketEnd: z.string(),
  fired: z.number().int(),
  intensity: z.number(),
  baselineMedian: z.number(),
  baselineMad: z.number(),
  lane: z.enum(["board", "offprice"]).optional(),
  sourceMarketId: z.string().optional(),
});
const backtestStatsSchema = z.object({
  firesPerGame: z.number(),
  totalFires: z.number().int(),
  gamesInWindow: z.number().int(),
});
const backtestResponseSchema = z.object({
  runId: z.number().int(),
  stats: backtestStatsSchema,
  observations: z.array(backtestObservationSchema),
});
const backtestErrorSchema = z.object({ error: z.string() });

export type BacktestObservation = z.infer<typeof backtestObservationSchema>;
export type BacktestStats = z.infer<typeof backtestStatsSchema>;
export type BacktestResponse = z.infer<typeof backtestResponseSchema>;

export interface BacktestRequest {
  readonly detector_id: string;
  readonly params: Record<string, unknown>;
  readonly window: { readonly start: string; readonly end: string };
  readonly game_ids?: readonly string[];
}

async function runBacktestRequest(req: BacktestRequest): Promise<BacktestResponse> {
  const res = await fetch(`${API_BASE_URL}/v1/backtest`, {
    method: "POST",
    headers: {
      "X-Signal-Token": SIGNAL_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(req),
  });
  const text = await res.text();
  if (!res.ok) {
    // Best-effort message extraction — API returns { error: string } on 400.
    const parsed = (() => {
      try {
        return backtestErrorSchema.safeParse(JSON.parse(text));
      } catch {
        return { success: false } as const;
      }
    })();
    const detail = parsed.success ? parsed.data.error : text || res.statusText;
    throw new Error(`HTTP ${String(res.status)}: ${detail}`);
  }
  const json: unknown = JSON.parse(text);
  return backtestResponseSchema.parse(json);
}

export function useBacktest(): UseMutationResult<BacktestResponse, Error, BacktestRequest> {
  return useMutation({
    mutationFn: runBacktestRequest,
  });
}

// /v1/cache — DELETE clears detector_runs (cascade) and returns { deleted }.
const clearCacheResponseSchema = z.object({ deleted: z.number().int() });
export type ClearCacheResponse = z.infer<typeof clearCacheResponseSchema>;

async function clearCacheRequest(): Promise<ClearCacheResponse> {
  const res = await fetch(`${API_BASE_URL}/v1/cache`, {
    method: "DELETE",
    headers: { "X-Signal-Token": SIGNAL_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)} ${res.statusText} for /v1/cache`);
  }
  const json: unknown = await res.json();
  return clearCacheResponseSchema.parse(json);
}

export function useClearCache(): UseMutationResult<ClearCacheResponse, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clearCacheRequest,
    onSuccess: () => {
      // Refresh the Settings query so cacheDb.sizeBytes/pageCount reflect the
      // post-delete state. Gold DB size is independent and unaffected.
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

// POST /v1/settings/detector-defaults (US-053). Body is a full DetectorDefaults
// payload (no partial PATCH semantics on the server). On success, invalidate
// ['settings'] so the AboutSection's board-mad version + the editable form's
// canonical values both refresh.
async function updateDetectorDefaultsRequest(
  body: DetectorDefaults,
): Promise<DetectorDefaults> {
  const res = await fetch(`${API_BASE_URL}/v1/settings/detector-defaults`, {
    method: "POST",
    headers: { "X-Signal-Token": SIGNAL_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HTTP ${String(res.status)} ${res.statusText} for /v1/settings/detector-defaults: ${text}`,
    );
  }
  const json: unknown = await res.json();
  return detectorDefaultsSchema.parse(json);
}

export function useUpdateDetectorDefaults(): UseMutationResult<
  DetectorDefaults,
  Error,
  DetectorDefaults
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateDetectorDefaultsRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

const scheduledDetectorDefaultsSchema = z.object({
  effectiveAt: z.string(),
  defaults: detectorDefaultsSchema,
});
export type ScheduledDetectorDefaults = z.infer<typeof scheduledDetectorDefaultsSchema>;

async function scheduleDetectorDefaultsRequest(body: {
  readonly defaults: DetectorDefaults;
  readonly effectiveAt: string;
}): Promise<ScheduledDetectorDefaults> {
  const res = await fetch(`${API_BASE_URL}/v1/settings/detector-defaults/schedule`, {
    method: "POST",
    headers: { "X-Signal-Token": SIGNAL_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `HTTP ${String(res.status)} ${res.statusText} for /v1/settings/detector-defaults/schedule: ${text}`,
    );
  }
  const json: unknown = await res.json();
  return scheduledDetectorDefaultsSchema.parse(json);
}

export function useScheduleDetectorDefaults(): UseMutationResult<
  ScheduledDetectorDefaults,
  Error,
  { readonly defaults: DetectorDefaults; readonly effectiveAt: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: scheduleDetectorDefaultsRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
