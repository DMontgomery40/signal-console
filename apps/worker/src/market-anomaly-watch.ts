import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { MarketAnomalyAlert } from "@signal-console/domain";
import {
  closeDatabase,
  createAppLogger,
  listMarketAnomalyAlerts,
  loadRuntimeEnv,
  serializeErrorForLog,
  writeMarketAnomalyPlaybackFrame,
  type AppLogger,
} from "@signal-console/shared";

type WatcherSettings = {
  durationMs?: number;
  includeHistorical: boolean;
  includeUnmapped: boolean;
  intervalMs: number;
  limit: number;
  minConfidence: number;
  minScore: number;
  notify: boolean;
  requireBet365: boolean;
};

type WatcherHandle = {
  stop: (reason: string) => void;
};

const watcherLogger = createAppLogger({
  component: "market-anomaly-watch",
});
const execFile = promisify(execFileCallback);

function numberFromEnv(name: string, defaultValue: number) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : defaultValue;
}

function booleanFromEnv(name: string, defaultValue: boolean) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }

  return defaultValue;
}

function resolveSettings(options?: Partial<WatcherSettings>): WatcherSettings {
  return {
    durationMs:
      options?.durationMs ??
      (process.env.MARKET_ANOMALY_WATCH_DURATION_MS
        ? numberFromEnv("MARKET_ANOMALY_WATCH_DURATION_MS", 0)
        : undefined),
    includeHistorical:
      options?.includeHistorical ??
      booleanFromEnv("MARKET_ANOMALY_INCLUDE_HISTORICAL", false),
    includeUnmapped:
      options?.includeUnmapped ??
      booleanFromEnv("MARKET_ANOMALY_INCLUDE_UNMAPPED", true),
    intervalMs:
      options?.intervalMs ??
      numberFromEnv("MARKET_ANOMALY_WATCH_INTERVAL_MS", 10_000),
    limit: options?.limit ?? numberFromEnv("MARKET_ANOMALY_LIMIT", 25),
    minConfidence:
      options?.minConfidence ??
      numberFromEnv("MARKET_ANOMALY_MIN_CONFIDENCE", 0.45),
    minScore:
      options?.minScore ?? numberFromEnv("MARKET_ANOMALY_MIN_SCORE", 45),
    notify: options?.notify ?? booleanFromEnv("MARKET_ANOMALY_NOTIFY", true),
    requireBet365:
      options?.requireBet365 ??
      booleanFromEnv("MARKET_ANOMALY_REQUIRE_BET365", false),
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(0)}%`;
}

function appleScriptString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildMarketAnomalyNotification(alert: MarketAnomalyAlert) {
  const labels = alert.labels.slice(0, 2).join(", ") || "market anomaly";
  return {
    body: `${alert.source} ${alert.apiSurface}; score ${
      alert.score
    }, confidence ${formatPercent(alert.confidence)}; ${labels}`,
    subtitle: `${alert.gameLabel} | ${alert.displayLabel}`,
    title: "Prediction-market weirdness",
  };
}

async function sendMacNotification(alert: MarketAnomalyAlert) {
  const notification = buildMarketAnomalyNotification(alert);
  await execFile("osascript", [
    "-e",
    `display notification ${appleScriptString(
      notification.body
    )} with title ${appleScriptString(
      notification.title
    )} subtitle ${appleScriptString(notification.subtitle)}`,
  ]);
}

export function startMarketAnomalyWatcher(options?: {
  logger?: AppLogger;
  settings?: Partial<WatcherSettings>;
}): WatcherHandle {
  loadRuntimeEnv();
  const logger = options?.logger ?? watcherLogger;
  const settings = resolveSettings(options?.settings);
  const startedAt = Date.now();
  const seenAlertIds = new Set<string>();
  let stopped = false;
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
    logger.info({ reason }, "Market anomaly watcher stopped.");
  };

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    if (
      settings.durationMs != null &&
      settings.durationMs > 0 &&
      Date.now() - startedAt >= settings.durationMs
    ) {
      stop("duration-elapsed");
      return;
    }

    timer = setTimeout(() => {
      void pollOnce();
    }, settings.intervalMs);
  };

  const pollOnce = async () => {
    const capturedAt = new Date().toISOString();

    try {
      const alerts = listMarketAnomalyAlerts({
        includeHistorical: settings.includeHistorical,
        includeUnmapped: settings.includeUnmapped,
        limit: settings.limit,
        minConfidence: settings.minConfidence,
        minScore: settings.minScore,
        requireBet365: settings.requireBet365,
      });
      const newAlerts = alerts.filter((alert) => !seenAlertIds.has(alert.id));
      for (const alert of alerts) {
        seenAlertIds.add(alert.id);
      }

      const playbackPath = writeMarketAnomalyPlaybackFrame({
        alertCount: alerts.length,
        alerts,
        capturedAt,
        notifiedAlertIds: newAlerts.map((alert) => alert.id),
        poll: {
          includeHistorical: settings.includeHistorical,
          includeUnmapped: settings.includeUnmapped,
          limit: settings.limit,
          minConfidence: settings.minConfidence,
          minScore: settings.minScore,
          requireBet365: settings.requireBet365,
        },
        source: "market-anomaly-watch",
      });

      logger.info(
        {
          alertCount: alerts.length,
          newAlertCount: newAlerts.length,
          playbackPath,
        },
        "Market anomaly poll recorded."
      );

      if (settings.notify) {
        for (const alert of newAlerts) {
          try {
            await sendMacNotification(alert);
          } catch (error) {
            logger.warn(
              { alertId: alert.id, error: serializeErrorForLog(error) },
              "Desktop notification failed."
            );
          }
        }
      }
    } catch (error) {
      const serialized = serializeErrorForLog(error);
      writeMarketAnomalyPlaybackFrame({
        alertCount: 0,
        alerts: [],
        capturedAt,
        error: {
          code: serialized.code,
          message: serialized.message,
        },
        notifiedAlertIds: [],
        poll: {
          includeHistorical: settings.includeHistorical,
          includeUnmapped: settings.includeUnmapped,
          limit: settings.limit,
          minConfidence: settings.minConfidence,
          minScore: settings.minScore,
          requireBet365: settings.requireBet365,
        },
        source: "market-anomaly-watch",
      });
      logger.error({ error: serialized }, "Market anomaly poll failed.");
    } finally {
      scheduleNext();
    }
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      durationMs: settings.durationMs,
      includeHistorical: settings.includeHistorical,
      includeUnmapped: settings.includeUnmapped,
      intervalMs: settings.intervalMs,
      limit: settings.limit,
      minConfidence: settings.minConfidence,
      minScore: settings.minScore,
      notify: settings.notify,
      requireBet365: settings.requireBet365,
    },
    "Market anomaly watcher started."
  );

  void pollOnce();
  return { stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMarketAnomalyWatcher();
}
