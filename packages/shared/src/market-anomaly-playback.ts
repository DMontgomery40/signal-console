import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isStrictYmdDate } from "@signal-console/domain";
import type { MarketAnomalyPlaybackFrame } from "@signal-console/domain";

const defaultPlaybackDirectory = resolve(
  fileURLToPath(
    new URL("../../../data/market-anomaly-playback", import.meta.url)
  )
);

const defaultPlaybackTimeZone = "America/Denver";

export type MarketAnomalyPlaybackQuery = {
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

export function getMarketAnomalyPlaybackDirectory() {
  return process.env.MARKET_ANOMALY_PLAYBACK_DIR ?? defaultPlaybackDirectory;
}

export function resolveMarketAnomalyPlaybackDate(
  date?: string,
  now = new Date(),
  timeZone = process.env.MARKET_ANOMALY_TIME_ZONE ?? defaultPlaybackTimeZone
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

export function getMarketAnomalyPlaybackPath(date?: string, now = new Date()) {
  const resolvedDate = resolveMarketAnomalyPlaybackDate(date, now);
  return resolve(getMarketAnomalyPlaybackDirectory(), `${resolvedDate}.jsonl`);
}

function parsePlaybackLine(line: string): MarketAnomalyPlaybackFrame | null {
  try {
    const frame = JSON.parse(line) as MarketAnomalyPlaybackFrame;
    return frame.source === "market-anomaly-watch" ? frame : null;
  } catch {
    return null;
  }
}

export function listMarketAnomalyPlaybackFrames(
  query: MarketAnomalyPlaybackQuery = {}
) {
  const date = resolveMarketAnomalyPlaybackDate(query.date);
  const playbackPath = getMarketAnomalyPlaybackPath(date);
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
    .filter((frame): frame is MarketAnomalyPlaybackFrame => frame != null);
}

export function writeMarketAnomalyPlaybackFrame(
  frame: MarketAnomalyPlaybackFrame
) {
  const playbackPath = getMarketAnomalyPlaybackPath(
    undefined,
    new Date(frame.capturedAt)
  );
  mkdirSync(dirname(playbackPath), { recursive: true });
  appendFileSync(playbackPath, `${JSON.stringify(frame)}\n`, "utf8");
  return playbackPath;
}
