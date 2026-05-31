import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KALSHI_NBA_HISTORICAL_PERIOD_INTERVAL_MINUTES,
  syncBet365Historical,
  syncKalshiNbaDirect,
  syncKalshiNbaHistorical,
  syncOddsApiBet365NbaMarkets,
  syncPolymarketNbaMarkets,
  syncPolymarketNbaHistorical,
  syncPolymarketNbaTrades,
} from "@signal-console/adapters";
import { backfillGamesBodySchema, backfillMarketsBodySchema } from "@signal-console/domain";
import { validateExportRequest, type ExportRequest } from "@signal-console/research-pull";
import {
  checkDatabaseHealth,
  claimNextQueuedAdminAction,
  closeDatabase,
  createAppLogger,
  listResearchGames,
  rebuildBoardVolatilityBaselines,
  getDatabasePath,
  loadRuntimeEnv,
  markAdminActionCompleted,
  markAdminActionErrored,
  serializeErrorForLog,
  type AppLogger,
} from "@signal-console/shared";

import { writeHeartbeatJson } from "./heartbeat-emitter";
import { syncNbaSidecarWindow } from "./nba-sidecar";

const workerLogger = createAppLogger({ component: "worker" });

interface NumberEnvOptions {
  readonly integer?: boolean;
  readonly min?: number;
}

function numberFromEnv(name: string, defaultValue: number, options: NumberEnvOptions = {}) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) return defaultValue;
  if (options.integer === true && !Number.isInteger(value)) return defaultValue;
  if (options.min !== undefined && value < options.min) return defaultValue;
  return value;
}

function getDefaultIntervalMs() {
  return numberFromEnv("WORKER_INTERVAL_MS", 30_000, { integer: true, min: 1 });
}

function getDefaultMaxBackoffMs(intervalMs = getDefaultIntervalMs()) {
  return numberFromEnv("WORKER_MAX_BACKOFF_MS", intervalMs * 4, { integer: true, min: 1 });
}

function getBet365RateLimitCooldownMs() {
  return numberFromEnv("BET365_RATE_LIMIT_COOLDOWN_MS", 300_000, { integer: true, min: 0 });
}

function getSidecarLookbackDays() {
  return numberFromEnv("NBA_SIDECAR_LOOKBACK_DAYS", 1, { integer: true, min: 0 });
}

function getSidecarLookaheadDays() {
  return numberFromEnv("NBA_SIDECAR_LOOKAHEAD_DAYS", 3, { integer: true, min: 0 });
}

function getKalshiLiveMaxEvents() {
  return numberFromEnv("KALSHI_LIVE_MAX_EVENTS", 200, { integer: true, min: 1 });
}

function getKalshiLiveLookbackDays() {
  return numberFromEnv("KALSHI_LIVE_LOOKBACK_DAYS", 2, { integer: true, min: 0 });
}

function getKalshiLiveMinimumStartDate(now: Date) {
  const minimum = new Date(now);
  minimum.setUTCDate(minimum.getUTCDate() - getKalshiLiveLookbackDays());
  return minimum.toISOString().slice(0, 10);
}

function getPolymarketTradesLookbackMinutes() {
  return numberFromEnv("POLYMARKET_TRADES_LOOKBACK_MINUTES", 120, { integer: true, min: 0 });
}

function getPolymarketTradesMaxMarkets() {
  return numberFromEnv("POLYMARKET_TRADES_MAX_MARKETS", 250, { integer: true, min: 1 });
}

type ProviderCooldownState = {
  bet365UntilMs?: number;
};

type GamesBackfillPayload = ReturnType<typeof backfillGamesBodySchema.parse>;
type MarketsBackfillPayload = ReturnType<typeof backfillMarketsBodySchema.parse>;

function isWithinBackfillDateRange(scheduledStart: string, dateFrom?: string, dateTo?: string) {
  const scheduledDate = scheduledStart.slice(0, 10);
  if (dateFrom && scheduledDate < dateFrom) return false;
  if (dateTo && scheduledDate > dateTo) return false;
  return true;
}

function selectScopedMarketBackfillGames(payload: MarketsBackfillPayload) {
  const allGames = listResearchGames({
    league: "NBA",
    limit: 500,
    scope: "all",
    sport: "basketball",
  });
  if (payload.gameId) {
    const game = allGames.find((candidate) => candidate.game.id === payload.gameId);
    if (!game) {
      throw new Error(`Unknown gameId for market backfill: ${payload.gameId}`);
    }
    return [game];
  }

  if (!payload.dateFrom && !payload.dateTo) {
    return null;
  }

  return allGames.filter((game) =>
    isWithinBackfillDateRange(game.game.scheduledStart, payload.dateFrom, payload.dateTo),
  );
}

function deriveScopedMarketBackfillDates(
  payload: MarketsBackfillPayload,
  games: ReturnType<typeof selectScopedMarketBackfillGames>,
) {
  const scheduledDates =
    games == null
      ? []
      : games
          .map((game) => game.game.scheduledStart.slice(0, 10))
          .sort((left, right) => left.localeCompare(right));
  return {
    dateFrom: payload.dateFrom ?? scheduledDates[0],
    dateTo: payload.dateTo ?? scheduledDates.at(-1),
  };
}

function isRateLimitFailure(error: ReturnType<typeof serializeErrorForLog>) {
  const message = [
    error.message,
    typeof error.cause === "object" && error.cause != null && "message" in error.cause
      ? String(error.cause.message)
      : "",
  ].join(" ");
  return /\b429\b|rate.?limit/i.test(message);
}

export type WorkerHeartbeatSummary = {
  bet365GamesMatched: number;
  bet365SourceMarketsObserved: number;
  capturedAt: string;
  database: ReturnType<typeof checkDatabaseHealth>;
  dbPath: string;
  kalshiGamesMatched: number;
  kalshiSourceMarketsObserved: number;
  nbaGamesObserved: number;
  nbaSidecarConfigured: boolean;
  nbaSidecarLastSyncAt: string | null;
  polymarketGamesMatched: number;
  polymarketSourceMarketsObserved: number;
  providerFailures: Array<{
    error: ReturnType<typeof serializeErrorForLog>;
    source: "bet365" | "kalshi" | "polymarket";
  }>;
};

function daysBetweenUtcDates(leftIsoDate: string, rightIsoDate: string) {
  const left = Date.parse(`${leftIsoDate}T00:00:00Z`);
  const right = Date.parse(`${rightIsoDate}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 0;
  }
  return Math.round((left - right) / 86_400_000);
}

async function executeQueuedGamesBackfill(
  payload: GamesBackfillPayload,
  now: Date,
  syncNbaSidecar: typeof syncNbaSidecarWindow,
) {
  const today = now.toISOString().slice(0, 10);
  const lookbackDays = Math.max(0, daysBetweenUtcDates(today, payload.dateFrom));
  const lookaheadDays = Math.max(0, daysBetweenUtcDates(payload.dateTo, today));
  await syncNbaSidecar({
    lookaheadDays,
    lookbackDays,
  });
}

async function executeQueuedMarketsBackfill(
  payload: MarketsBackfillPayload,
  options: {
    syncBet365Historical: typeof syncBet365Historical;
    syncKalshiHistorical: typeof syncKalshiNbaHistorical;
    syncPolymarketHistorical: typeof syncPolymarketNbaHistorical;
  },
) {
  const scopedGames = selectScopedMarketBackfillGames(payload);
  if (scopedGames?.length === 0) {
    return;
  }
  const scopedDates = deriveScopedMarketBackfillDates(payload, scopedGames);

  if (!payload.source || payload.source === "polymarket") {
    await options.syncPolymarketHistorical({
      fidelityMinutes: 1,
      games: scopedGames ?? undefined,
      since: scopedDates.dateFrom,
    });
    if (payload.source === "polymarket") {
      return;
    }
  }

  if (!payload.source || payload.source === "kalshi") {
    await options.syncKalshiHistorical({
      games: scopedGames ?? undefined,
      maxEvents: 100,
      periodIntervalMinutes: KALSHI_NBA_HISTORICAL_PERIOD_INTERVAL_MINUTES,
    });
    if (payload.source === "kalshi") {
      return;
    }
  }

  if (!payload.source || payload.source === "bet365") {
    await options.syncBet365Historical({
      dateFrom: scopedDates.dateFrom,
      dateTo: scopedDates.dateTo,
      games: scopedGames ?? undefined,
      maxEvents: 200,
    });
    if (payload.source === "bet365") {
      return;
    }
  }

  if (
    payload.source &&
    payload.source !== "kalshi" &&
    payload.source !== "polymarket" &&
    payload.source !== "bet365"
  ) {
    throw new Error(`Unsupported market backfill source: ${payload.source}`);
  }
}

// Repo root from this module (apps/worker/src/index.ts -> ../../..). Used as the
// child-process cwd so `pnpm exec tsx scripts/...` resolves regardless of the
// worker's own cwd (which is apps/worker under `pnpm --filter`).
const WORKER_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Minimal injectable spawn signature so tests can substitute a fake child. */
export type SpawnProcessFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

function requireValidExportRequest(input: unknown): ExportRequest {
  const result = validateExportRequest(input);
  if (!result.ok) {
    const detail = result.errors
      .map((error) => (error.path ? `${error.code}:${error.path}` : error.code))
      .join(", ");
    throw new Error(`invalid research-export payload: ${detail}`);
  }
  return result.request;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function exportRequestPayload(payloadJson: Record<string, unknown>): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRecord(payloadJson["request"])) return payloadJson["request"];

  const request: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payloadJson)) {
    if (key !== "jobId" && key !== "outputRoot") {
      request[key] = value;
    }
  }
  return request;
}

/**
 * Map a research-export admin-action payload to the exact CLI args for
 * scripts/export-quant-snapshot.ts. PURE so the mapping is unit-testable.
 *
 *   scope "full"   -> no --sample (full corpus is the script default)
 *   scope "sample" -> --sample <n>
 *   snapshotId     -> --snapshot-id <id>
 *   since/until    -> --since/--until <date>
 *   gameIds        -> --games a,b for full/explicit exports
 *   outputRoot     -> --out <root>/snapshots from queue metadata
 *
 * Reads the export args out of payloadJson.request (the shape the API enqueues:
 * { jobId, request }), falling back to the payload root for forward-compat.
 */
export function mapExportArgs(payloadJson: Record<string, unknown>): string[] {
  const request = requireValidExportRequest(exportRequestPayload(payloadJson));
  const args: string[] = [];
  const outputRoot = optionalNonEmptyString(payloadJson["outputRoot"]);

  if (outputRoot !== undefined) {
    args.push("--out", join(outputRoot, "snapshots"));
  }

  if (request.scope === "sample") {
    args.push("--sample", String(request.sample));
  }
  // scope "full" -> no --sample (full corpus is the script default).

  if (request.snapshotId !== undefined) {
    args.push("--snapshot-id", request.snapshotId);
  }

  if (request.since !== undefined) {
    args.push("--since", request.since);
  }

  if (request.until !== undefined) {
    args.push("--until", request.until);
  }

  if (request.gameIds !== undefined && request.gameIds.length > 0) {
    args.push("--games", request.gameIds.join(","));
  }

  return args;
}

/**
 * Run the EXISTING snapshot exporter as a child process. Reuses the exact,
 * tested export code path (scripts/export-quant-snapshot.ts via the repo's tsx);
 * does NOT reimplement export logic. Resolves on exit 0; rejects with a
 * stderr-tail-bearing error otherwise so the admin-action loop marks it errored.
 * The exporter reads GOLD_DB_PATH from the inherited environment.
 */
export async function executeResearchExport(
  payloadJson: Record<string, unknown>,
  spawnProcess: SpawnProcessFn = spawn,
): Promise<void> {
  const args = mapExportArgs(payloadJson);
  const child = spawnProcess("pnpm", ["exec", "tsx", "scripts/export-quant-snapshot.ts", ...args], {
    cwd: WORKER_REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=10240" },
  });

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.on("error", (error: Error) => {
      rejectPromise(error);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = stderrChunks.join("").slice(-2000).trim();
      rejectPromise(
        new Error(
          `export-quant-snapshot.ts exited with code ${String(code)}${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
  });
}

async function drainQueuedAdminActions(options: {
  executeGamesBackfill: (
    payload: GamesBackfillPayload,
    now: Date,
    syncNbaSidecar: typeof syncNbaSidecarWindow,
  ) => Promise<void>;
  executeMarketsBackfill: (
    payload: MarketsBackfillPayload,
    helpers: {
      syncBet365Historical: typeof syncBet365Historical;
      syncKalshiHistorical: typeof syncKalshiNbaHistorical;
      syncPolymarketHistorical: typeof syncPolymarketNbaHistorical;
    },
  ) => Promise<void>;
  executeResearchExport: (payloadJson: Record<string, unknown>) => Promise<void>;
  logger: AppLogger;
  now: Date;
  syncBet365Historical: typeof syncBet365Historical;
  syncKalshiHistorical: typeof syncKalshiNbaHistorical;
  syncNbaSidecar: typeof syncNbaSidecarWindow;
  syncPolymarketHistorical: typeof syncPolymarketNbaHistorical;
}) {
  for (let processed = 0; processed < 10; processed += 1) {
    const action = claimNextQueuedAdminAction();
    if (!action) {
      return;
    }

    try {
      if (action.actionType === "games-backfill") {
        const payload = backfillGamesBodySchema.parse(action.payloadJson);
        await options.executeGamesBackfill(payload, options.now, options.syncNbaSidecar);
      } else if (action.actionType === "markets-backfill") {
        const payload = backfillMarketsBodySchema.parse(action.payloadJson);
        await options.executeMarketsBackfill(payload, {
          syncBet365Historical: options.syncBet365Historical,
          syncKalshiHistorical: options.syncKalshiHistorical,
          syncPolymarketHistorical: options.syncPolymarketHistorical,
        });
      } else if (action.actionType === "board-volatility-baseline-rebuild") {
        rebuildBoardVolatilityBaselines();
      } else if (action.actionType === "research-export") {
        await options.executeResearchExport(action.payloadJson);
      } else {
        throw new Error(`Unsupported admin action type: ${action.actionType}.`);
      }

      markAdminActionCompleted(action.id);
      options.logger.info({ action }, "Admin action completed.");
    } catch (error) {
      markAdminActionErrored(action.id);
      options.logger.error(
        {
          action,
          error: serializeErrorForLog(error),
        },
        "Admin action failed.",
      );
    }
  }
}

export function calculateBackoffDelay(
  intervalMs: number,
  consecutiveFailures: number,
  maxBackoffMs = getDefaultMaxBackoffMs(intervalMs),
) {
  return Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs);
}

export function buildWorkerHeartbeatSummary(options?: {
  bet365GamesMatched?: number;
  bet365SourceMarketsObserved?: number;
  kalshiGamesMatched?: number;
  kalshiSourceMarketsObserved?: number;
  nbaGameCount?: number;
  nbaSidecarConfigured?: boolean;
  nbaSidecarLastSyncAt?: string | null;
  now?: () => Date;
  polymarketGamesMatched?: number;
  polymarketSourceMarketsObserved?: number;
  providerFailures?: WorkerHeartbeatSummary["providerFailures"];
}) {
  loadRuntimeEnv();
  const now = options?.now ?? (() => new Date());

  return {
    bet365GamesMatched: options?.bet365GamesMatched ?? 0,
    bet365SourceMarketsObserved: options?.bet365SourceMarketsObserved ?? 0,
    capturedAt: now().toISOString(),
    database: checkDatabaseHealth({ integrityCheck: "skip" }),
    dbPath: getDatabasePath(),
    kalshiGamesMatched: options?.kalshiGamesMatched ?? 0,
    kalshiSourceMarketsObserved: options?.kalshiSourceMarketsObserved ?? 0,
    nbaGamesObserved: options?.nbaGameCount ?? 0,
    nbaSidecarConfigured:
      options?.nbaSidecarConfigured ?? Boolean(process.env.NBA_SIDECAR_BASE_URL),
    nbaSidecarLastSyncAt: options?.nbaSidecarLastSyncAt ?? null,
    polymarketGamesMatched: options?.polymarketGamesMatched ?? 0,
    polymarketSourceMarketsObserved: options?.polymarketSourceMarketsObserved ?? 0,
    providerFailures: options?.providerFailures ?? [],
  } satisfies WorkerHeartbeatSummary;
}

export async function runWorkerCycle(options?: {
  consecutiveFailures?: number;
  executeGamesBackfill?: (
    payload: GamesBackfillPayload,
    now: Date,
    syncNbaSidecar: typeof syncNbaSidecarWindow,
  ) => Promise<void>;
  executeMarketsBackfill?: (
    payload: MarketsBackfillPayload,
    helpers: {
      syncBet365Historical: typeof syncBet365Historical;
      syncKalshiHistorical: typeof syncKalshiNbaHistorical;
      syncPolymarketHistorical: typeof syncPolymarketNbaHistorical;
    },
  ) => Promise<void>;
  executeResearchExport?: (payloadJson: Record<string, unknown>) => Promise<void>;
  intervalMs?: number;
  logger?: AppLogger;
  maxBackoffMs?: number;
  now?: () => Date;
  onHeartbeat?: (summary: WorkerHeartbeatSummary) => Promise<void> | void;
  providerCooldowns?: ProviderCooldownState;
  syncBet365?: typeof syncOddsApiBet365NbaMarkets;
  syncBet365Historical?: typeof syncBet365Historical;
  syncKalshi?: typeof syncKalshiNbaDirect;
  syncKalshiHistorical?: typeof syncKalshiNbaHistorical;
  syncNbaSidecar?: typeof syncNbaSidecarWindow;
  syncPolymarket?: typeof syncPolymarketNbaMarkets;
  syncPolymarketHistorical?: typeof syncPolymarketNbaHistorical;
  syncPolymarketTrades?: typeof syncPolymarketNbaTrades;
}) {
  loadRuntimeEnv();
  const intervalMs = options?.intervalMs ?? getDefaultIntervalMs();
  const logger = options?.logger ?? workerLogger;
  const maxBackoffMs = options?.maxBackoffMs ?? getDefaultMaxBackoffMs(intervalMs);
  const consecutiveFailures = options?.consecutiveFailures ?? 0;
  const now = options?.now ?? (() => new Date());
  const syncBet365 = options?.syncBet365 ?? syncOddsApiBet365NbaMarkets;
  const syncBet365HistoricalRange = options?.syncBet365Historical ?? syncBet365Historical;
  const syncKalshi = options?.syncKalshi ?? syncKalshiNbaDirect;
  const syncKalshiHistorical = options?.syncKalshiHistorical ?? syncKalshiNbaHistorical;
  const syncNbaSidecar = options?.syncNbaSidecar ?? syncNbaSidecarWindow;
  const syncPolymarket = options?.syncPolymarket ?? syncPolymarketNbaMarkets;
  const syncPolymarketHistorical = options?.syncPolymarketHistorical ?? syncPolymarketNbaHistorical;
  const syncPolymarketTrades = options?.syncPolymarketTrades ?? syncPolymarketNbaTrades;
  const queuedGamesBackfill = options?.executeGamesBackfill ?? executeQueuedGamesBackfill;
  const queuedMarketsBackfill = options?.executeMarketsBackfill ?? executeQueuedMarketsBackfill;
  const queuedResearchExport =
    options?.executeResearchExport ?? ((payloadJson) => executeResearchExport(payloadJson));

  try {
    let bet365GamesMatched = 0;
    let bet365SourceMarketsObserved = 0;
    let kalshiGamesMatched = 0;
    let kalshiSourceMarketsObserved = 0;
    let nbaGameCount = 0;
    let nbaSidecarLastSyncAt: string | null = null;
    let polymarketGamesMatched = 0;
    let polymarketSourceMarketsObserved = 0;
    const providerFailures: WorkerHeartbeatSummary["providerFailures"] = [];
    const nbaSidecarConfigured = Boolean(process.env.NBA_SIDECAR_BASE_URL);
    const oddsApiConfigured = Boolean(process.env.ODDS_API_KEY ?? process.env.ODDS_API_IO_KEY);
    const kalshiDirectConfigured = Boolean(process.env.KALSHI_API_KEY);
    let marketProviderAttempts = 0;

    if (nbaSidecarConfigured) {
      const syncResult = await syncNbaSidecar({
        lookaheadDays: getSidecarLookaheadDays(),
        lookbackDays: getSidecarLookbackDays(),
        now: options?.now,
      });
      nbaGameCount = syncResult.gamesSeen;
      nbaSidecarLastSyncAt = syncResult.finishedAt;
      if (syncResult.ok) {
        logger.info(syncResult, "NBA sidecar sync completed.");
      } else {
        logger.warn(syncResult, "NBA sidecar sync completed with partial play-by-play gaps.");
      }
    }

    if (oddsApiConfigured) {
      const nowMs = now().getTime();
      const bet365CooldownUntilMs = options?.providerCooldowns?.bet365UntilMs;
      if (
        bet365CooldownUntilMs != null &&
        Number.isFinite(bet365CooldownUntilMs) &&
        nowMs < bet365CooldownUntilMs
      ) {
        logger.warn(
          {
            retryAt: new Date(bet365CooldownUntilMs).toISOString(),
            remainingMs: Math.max(0, bet365CooldownUntilMs - nowMs),
          },
          "Skipping Bet365 sync during rate-limit cooldown.",
        );
      } else {
        marketProviderAttempts += 1;
        try {
          const bet365Result = await syncBet365({
            now: options?.now,
          });
          if (options?.providerCooldowns) {
            options.providerCooldowns.bet365UntilMs = 0;
          }
          bet365GamesMatched = bet365Result.gamesMatched;
          bet365SourceMarketsObserved = bet365Result.sourceMarketsObserved;
          logger.info(bet365Result, "Bet365 sync completed.");
        } catch (error) {
          const serialized = serializeErrorForLog(error);
          if (isRateLimitFailure(serialized) && options?.providerCooldowns) {
            options.providerCooldowns.bet365UntilMs = nowMs + getBet365RateLimitCooldownMs();
          }
          providerFailures.push({ error: serialized, source: "bet365" });
          logger.error({ error: serialized }, "Bet365 sync failed.");
        }
      }
    }

    if (kalshiDirectConfigured) {
      marketProviderAttempts += 1;
      try {
        const kalshiResult = await syncKalshi({
          maxEvents: getKalshiLiveMaxEvents(),
          minimumStartDate: getKalshiLiveMinimumStartDate(now()),
          now: options?.now,
        });
        kalshiGamesMatched = kalshiResult.gamesMatched;
        kalshiSourceMarketsObserved = kalshiResult.sourceMarketsObserved;
        logger.info(kalshiResult, "Kalshi sync completed.");
      } catch (error) {
        const serialized = serializeErrorForLog(error);
        providerFailures.push({ error: serialized, source: "kalshi" });
        logger.error({ error: serialized }, "Kalshi sync failed.");
      }
    }

    marketProviderAttempts += 1;
    try {
      const polymarketResult = await syncPolymarket({
        now: options?.now,
      });
      polymarketGamesMatched = polymarketResult.gamesMatched;
      polymarketSourceMarketsObserved = polymarketResult.sourceMarketsObserved;
      logger.info(polymarketResult, "Polymarket sync completed.");
      marketProviderAttempts += 1;
      try {
        const until = now().toISOString();
        const since = new Date(
          now().getTime() - getPolymarketTradesLookbackMinutes() * 60_000,
        ).toISOString();
        const tradesResult = await syncPolymarketTrades({
          since,
          until,
          league: "NBA",
          maxMarkets: getPolymarketTradesMaxMarkets(),
        });
        if (!tradesResult.ok || tradesResult.errors.length > 0) {
          providerFailures.push({
            error: serializeErrorForLog(
              new Error(
                `Polymarket trades sync had ${tradesResult.errors.length} partial failure(s).`,
              ),
            ),
            source: "polymarket",
          });
        }
        logger.info(tradesResult, "Polymarket trades sync completed.");
      } catch (tradeError) {
        providerFailures.push({
          error: serializeErrorForLog(tradeError),
          source: "polymarket",
        });
        logger.error(
          { error: serializeErrorForLog(tradeError) },
          "Polymarket trades sync failed after market discovery.",
        );
      }
    } catch (error) {
      const serialized = serializeErrorForLog(error);
      providerFailures.push({ error: serialized, source: "polymarket" });
      logger.error({ error: serialized }, "Polymarket sync failed.");
    }

    await drainQueuedAdminActions({
      executeGamesBackfill: queuedGamesBackfill,
      executeMarketsBackfill: queuedMarketsBackfill,
      executeResearchExport: queuedResearchExport,
      logger,
      now: now(),
      syncBet365Historical: syncBet365HistoricalRange,
      syncKalshiHistorical,
      syncNbaSidecar,
      syncPolymarketHistorical,
    });

    if (marketProviderAttempts > 0 && providerFailures.length === marketProviderAttempts) {
      throw new Error(
        `All configured market providers failed: ${providerFailures
          .map((failure) => failure.source)
          .join(", ")}`,
      );
    }

    const summary = buildWorkerHeartbeatSummary({
      bet365GamesMatched,
      bet365SourceMarketsObserved,
      kalshiGamesMatched,
      kalshiSourceMarketsObserved,
      nbaGameCount,
      nbaSidecarConfigured,
      nbaSidecarLastSyncAt,
      now: options?.now,
      polymarketGamesMatched,
      polymarketSourceMarketsObserved,
      providerFailures,
    });

    await options?.onHeartbeat?.(summary);
    logger.info(summary, "Worker heartbeat completed.");

    return {
      nextDelayMs: intervalMs,
      ok: true as const,
      summary,
    };
  } catch (error) {
    const nextDelayMs = calculateBackoffDelay(intervalMs, consecutiveFailures + 1, maxBackoffMs);

    logger.error(
      {
        error: serializeErrorForLog(error),
        nextDelayMs,
      },
      "Worker cycle failed.",
    );

    return {
      error,
      nextDelayMs,
      ok: false as const,
    };
  }
}

export function startWorker(options?: {
  intervalMs?: number;
  logger?: AppLogger;
  maxBackoffMs?: number;
}) {
  loadRuntimeEnv();
  const intervalMs = options?.intervalMs ?? getDefaultIntervalMs();
  const logger = options?.logger ?? workerLogger;
  const maxBackoffMs = options?.maxBackoffMs ?? getDefaultMaxBackoffMs(intervalMs);
  let stopped = false;
  let consecutiveFailures = 0;
  const providerCooldowns: ProviderCooldownState = {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (reason: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    closeDatabase();
    logger.info({ reason }, "Worker shutdown complete.");
  };

  const scheduleNext = (delayMs: number) => {
    if (stopped) {
      return;
    }

    timer = setTimeout(async () => {
      const cycleLogger = logger.child({ cycleDelayMs: delayMs });
      const result = await runWorkerCycle({
        consecutiveFailures,
        intervalMs,
        logger: cycleLogger,
        maxBackoffMs,
        onHeartbeat: (summary) => {
          try {
            writeHeartbeatJson({
              nbaSidecarConfigured: summary.nbaSidecarConfigured,
              nbaSidecarLastSyncAt: summary.nbaSidecarLastSyncAt,
              providerFailures: summary.providerFailures,
            });
          } catch (err) {
            cycleLogger.warn({ error: serializeErrorForLog(err) }, "heartbeat.json write failed");
          }
        },
        providerCooldowns,
      });

      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1;
      scheduleNext(result.nextDelayMs);
    }, delayMs);
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      intervalMs,
      maxBackoffMs,
    },
    "Worker started.",
  );

  scheduleNext(0);

  return {
    stop,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
}
