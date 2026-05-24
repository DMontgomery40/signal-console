import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isStrictYmdDate } from "@signal-console/domain";
import type {
  PlayerPropAlertPlaybackFrame,
  PlayerPropDisagreementAlert,
} from "@signal-console/domain";

type LegacyPlayerPropDisagreementAlert = PlayerPropDisagreementAlert & {
  freshness: PlayerPropDisagreementAlert["freshness"] & {
    pairGapMs?: number;
  };
};

type LegacyPlayerPropAlertPlaybackFrame = Omit<
  PlayerPropAlertPlaybackFrame,
  "alerts" | "poll"
> & {
  alerts: LegacyPlayerPropDisagreementAlert[];
  poll: Omit<PlayerPropAlertPlaybackFrame["poll"], "maxQuoteTimeGapMinutes"> & {
    maxPairGapMinutes?: number;
    maxQuoteTimeGapMinutes?: number;
  };
};

const defaultPlaybackDirectory = resolve(
  fileURLToPath(
    new URL("../../../data/player-prop-alert-playback", import.meta.url)
  )
);

const defaultPlaybackTimeZone = "America/Denver";

export type PlayerPropAlertPlaybackQuery = {
  date?: string;
  limit?: number;
};

function clampPlaybackLimit(limit: number | undefined) {
  if (limit == null || !Number.isFinite(limit)) {
    return 250;
  }

  return Math.min(1000, Math.max(0, Math.floor(limit)));
}

function assertPlaybackDate(date: string) {
  if (!isStrictYmdDate(date)) {
    throw new Error("Playback date must use YYYY-MM-DD format.");
  }
}

export function getPlayerPropAlertPlaybackDirectory() {
  return process.env.PLAYER_PROP_ALERT_PLAYBACK_DIR ?? defaultPlaybackDirectory;
}

export function resolvePlayerPropAlertPlaybackDate(
  date?: string,
  now = new Date(),
  timeZone = process.env.PLAYER_PROP_ALERT_TIME_ZONE ?? defaultPlaybackTimeZone
) {
  if (date) {
    assertPlaybackDate(date);
    return date;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

export function getPlayerPropAlertPlaybackPath(
  date?: string,
  now = new Date()
) {
  const resolvedDate = resolvePlayerPropAlertPlaybackDate(date, now);
  return resolve(
    getPlayerPropAlertPlaybackDirectory(),
    `${resolvedDate}.jsonl`
  );
}

function parsePlaybackLine(line: string): PlayerPropAlertPlaybackFrame | null {
  try {
    const frame = JSON.parse(line) as LegacyPlayerPropAlertPlaybackFrame;
    const alerts = frame.alerts.map((alert) => {
      const quoteTimeGapMs =
        alert.freshness.quoteTimeGapMs ?? alert.freshness.pairGapMs;
      return {
        ...alert,
        freshness: {
          bet365AgeMs: alert.freshness.bet365AgeMs,
          predictionMarketAgeMs: alert.freshness.predictionMarketAgeMs,
          ...(quoteTimeGapMs != null ? { quoteTimeGapMs } : {}),
        },
      };
    });
    return {
      ...frame,
      alerts,
      poll: {
        includeStale: frame.poll.includeStale,
        limit: frame.poll.limit,
        maxQuoteAgeMinutes: frame.poll.maxQuoteAgeMinutes,
        maxQuoteTimeGapMinutes:
          frame.poll.maxQuoteTimeGapMinutes ??
          frame.poll.maxPairGapMinutes ??
          10,
        minDelta: frame.poll.minDelta,
      },
    } satisfies PlayerPropAlertPlaybackFrame;
  } catch {
    return null;
  }
}

export function listPlayerPropAlertPlaybackFrames(
  query: PlayerPropAlertPlaybackQuery = {}
) {
  const date = resolvePlayerPropAlertPlaybackDate(query.date);
  const playbackPath = getPlayerPropAlertPlaybackPath(date);
  if (!existsSync(playbackPath)) {
    return [];
  }

  const lines = readFileSync(playbackPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const limit = clampPlaybackLimit(query.limit);
  const selectedLines = limit > 0 ? lines.slice(-limit) : [];

  return selectedLines
    .map(parsePlaybackLine)
    .filter((frame): frame is PlayerPropAlertPlaybackFrame => frame != null);
}

export function writePlayerPropAlertPlaybackFrame(
  frame: PlayerPropAlertPlaybackFrame
) {
  const playbackPath = getPlayerPropAlertPlaybackPath(
    undefined,
    new Date(frame.capturedAt)
  );
  mkdirSync(dirname(playbackPath), { recursive: true });
  appendFileSync(playbackPath, `${JSON.stringify(frame)}\n`, "utf8");
  return playbackPath;
}
