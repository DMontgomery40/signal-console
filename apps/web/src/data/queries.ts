// Tanstack Query hooks for the Signal Console API (US-023).
//
// Single shared fetchJson helper enforces the auth header + Zod-validated
// response shape, so every hook's return type is z.infer<typeof schema> with
// zero `any` and zero `as`.
//
// Routes that don't exist on the server yet (live, microstructure, detectors —
// US-028/029/030) have their response shapes declared here in advance from
// PRD §15. Those Zod schemas are the de facto contract: when the routes land,
// their server-side response schema must match, or the parse here will fail
// loudly at runtime.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
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

async function fetchJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
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
const boardObservationSchema = z.object({
  bucketStart: z.string(),
  bucketEnd: z.string(),
  fired: z.number().int(),
  intensity: z.number(),
  baselineMedian: z.number(),
  baselineMad: z.number(),
});
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
});
const fanoutMoverSchema = z.object({
  sourceMarketId: z.string(),
  instrument: z.string(),
  ipBefore: z.number().nullable(),
  ipAfter: z.number().nullable(),
  ipDelta: z.number().nullable(),
  contributionPct: z.number(),
  deltaSecondsFromFire: z.number(),
});
const fanoutSchema = z.object({
  bucketStart: z.string(),
  bucketEnd: z.string(),
  pbp: z.array(fanoutPbpEventSchema),
  movers: z.array(fanoutMoverSchema),
  narrative: z.string(),
});

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

// /v1/microstructure/:gameId — PRD §15: market_microstructure_events filtered
// by volume_share >= θ (default 0.10). Route TBD (US-029).
const microstructureEventSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  sourceMarketId: z.string(),
  eventTimestamp: z.string(),
  price: z.number(),
  size: z.number(),
  volumeShare: z.number(),
  offPriceDistance: z.number().nullable(),
});
const microstructureSchema = z.object({
  gameId: z.string(),
  theta: z.number(),
  events: z.array(microstructureEventSchema),
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
const settingsSchema = z.object({
  db: dbInfoSchema,
  cacheDb: cacheDbInfoSchema,
  sources: sourcesSchema,
  errors: z.array(logEntrySchema),
  about: aboutInfoSchema,
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
export type FanoutPbpEvent = z.infer<typeof fanoutPbpEventSchema>;
export type FanoutMover = z.infer<typeof fanoutMoverSchema>;
export type Fanout = z.infer<typeof fanoutSchema>;
export type DetectorEntry = z.infer<typeof detectorEntrySchema>;
export type DetectorsResponse = z.infer<typeof detectorsSchema>;
export type Settings = z.infer<typeof settingsSchema>;

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

export function useMicrostructure(gameId: string): UseQueryResult<Microstructure, Error> {
  return useQuery({
    queryKey: ["microstructure", gameId],
    queryFn: ({ signal }) =>
      fetchJson(
        `/v1/microstructure/${encodeURIComponent(gameId)}`,
        microstructureSchema,
        signal,
      ),
    enabled: gameId.length > 0,
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
// recompute kMad/trailingBuckets/warmupBuckets client-side without re-fetching.
const backtestObservationSchema = z.object({
  gameId: z.string(),
  bucketStart: z.string(),
  bucketEnd: z.string(),
  fired: z.number().int(),
  intensity: z.number(),
  baselineMedian: z.number(),
  baselineMad: z.number(),
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
