import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { PlayerPropDisagreementAlert } from "@signal-console/domain";
import {
  closeDatabase,
  createAppLogger,
  listPlayerPropDisagreementAlerts,
  loadRuntimeEnv,
  serializeErrorForLog,
  writePlayerPropAlertPlaybackFrame,
  type AppLogger,
} from "@signal-console/shared";

type WatcherSettings = {
  durationMs?: number;
  includeStale: boolean;
  intervalMs: number;
  limit: number;
  maxQuoteTimeGapMinutes: number;
  maxQuoteAgeMinutes: number;
  minDelta: number;
  notify: boolean;
};

type WatcherHandle = {
  stop: (reason: string) => void;
};

const watcherLogger = createAppLogger({
  component: "player-prop-alert-watch",
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
      (process.env.PLAYER_PROP_ALERT_WATCH_DURATION_MS
        ? numberFromEnv("PLAYER_PROP_ALERT_WATCH_DURATION_MS", 0)
        : undefined),
    includeStale:
      options?.includeStale ??
      booleanFromEnv("PLAYER_PROP_ALERT_INCLUDE_STALE", false),
    intervalMs:
      options?.intervalMs ??
      numberFromEnv("PLAYER_PROP_ALERT_WATCH_INTERVAL_MS", 10_000),
    limit: options?.limit ?? numberFromEnv("PLAYER_PROP_ALERT_LIMIT", 25),
    maxQuoteTimeGapMinutes:
      options?.maxQuoteTimeGapMinutes ??
      numberFromEnv("PLAYER_PROP_ALERT_MAX_QUOTE_TIME_GAP_MINUTES", 10),
    maxQuoteAgeMinutes:
      options?.maxQuoteAgeMinutes ??
      numberFromEnv("PLAYER_PROP_ALERT_MAX_QUOTE_AGE_MINUTES", 10),
    minDelta:
      options?.minDelta ?? numberFromEnv("PLAYER_PROP_ALERT_MIN_DELTA", 0.15),
    notify: options?.notify ?? booleanFromEnv("PLAYER_PROP_ALERT_NOTIFY", true),
  };
}

function formatProbability(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)} pp`;
}

function appleScriptString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildPlayerPropAlertNotification(
  alert: PlayerPropDisagreementAlert
) {
  return {
    body: `b365 ${formatProbability(
      alert.bet365.impliedProbability
    )} vs ${alert.predictionMarket.source} ${formatProbability(
      alert.predictionMarket.impliedProbability
    )}; delta ${formatDelta(alert.signedDelta)}`,
    subtitle: `${alert.gameLabel} | ${alert.displayLabel}`,
    title: "NBA player prop alert",
  };
}

async function sendMacNotification(alert: PlayerPropDisagreementAlert) {
  const notification = buildPlayerPropAlertNotification(alert);
  await execFile("osascript", [
    "-e",
    `display notification ${appleScriptString(
      notification.body
    )} with title ${appleScriptString(
      notification.title
    )} subtitle ${appleScriptString(notification.subtitle)}`,
  ]);
}

export function startPlayerPropAlertWatcher(options?: {
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
    logger.info({ reason }, "Player prop alert watcher stopped.");
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
      const alerts = listPlayerPropDisagreementAlerts({
        includeStale: settings.includeStale,
        limit: settings.limit,
        maxQuoteTimeGapMinutes: settings.maxQuoteTimeGapMinutes,
        maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
        minDelta: settings.minDelta,
      });
      const newAlerts = alerts.filter((alert) => !seenAlertIds.has(alert.id));
      for (const alert of alerts) {
        seenAlertIds.add(alert.id);
      }

      const playbackPath = writePlayerPropAlertPlaybackFrame({
        alertCount: alerts.length,
        alerts,
        capturedAt,
        notifiedAlertIds: newAlerts.map((alert) => alert.id),
        poll: {
          includeStale: settings.includeStale,
          limit: settings.limit,
          maxQuoteTimeGapMinutes: settings.maxQuoteTimeGapMinutes,
          maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
          minDelta: settings.minDelta,
        },
        source: "player-prop-alert-watch",
      });

      logger.info(
        {
          alertCount: alerts.length,
          newAlertCount: newAlerts.length,
          playbackPath,
        },
        "Player prop alert poll recorded."
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
      writePlayerPropAlertPlaybackFrame({
        alertCount: 0,
        alerts: [],
        capturedAt,
        error: {
          code: serialized.code,
          message: serialized.message,
        },
        notifiedAlertIds: [],
        poll: {
          includeStale: settings.includeStale,
          limit: settings.limit,
          maxQuoteTimeGapMinutes: settings.maxQuoteTimeGapMinutes,
          maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
          minDelta: settings.minDelta,
        },
        source: "player-prop-alert-watch",
      });
      logger.error({ error: serialized }, "Player prop alert poll failed.");
    } finally {
      scheduleNext();
    }
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  logger.info(
    {
      durationMs: settings.durationMs,
      includeStale: settings.includeStale,
      intervalMs: settings.intervalMs,
      limit: settings.limit,
      maxQuoteTimeGapMinutes: settings.maxQuoteTimeGapMinutes,
      maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
      minDelta: settings.minDelta,
      notify: settings.notify,
    },
    "Player prop alert watcher started."
  );

  void pollOnce();
  return { stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPlayerPropAlertWatcher();
}
