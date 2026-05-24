// Worker-native heartbeat emitter (replaces scripts/emit-heartbeat.mjs).
//
// The Settings route at apps/api/src/routes/settings.ts reads
// apps/worker/data/heartbeat.json after each ingest cycle to populate the
// per-source freshness panel. Schema (mirrored by sourceRowSchema in that
// route): { sources: Record<string, { lastSyncAt, lastError, rateLimitCooldown }> }.
//
// We derive lastSyncAt from MAX(quote_ticks.captured_at) per source via the
// already-open better-sqlite3 handle — no subprocess, no extra connection.
// providerFailures from the worker cycle summary populate lastError.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getDatabase, serializeErrorForLog } from "@signal-console/shared";

const DEFAULT_OUT = join(homedir(), "signal-console", "apps", "worker", "data", "heartbeat.json");

type ProviderFailure = {
  readonly error: ReturnType<typeof serializeErrorForLog>;
  readonly source: "bet365" | "kalshi" | "polymarket";
};

type SourceRow = {
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  readonly rateLimitCooldown: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (isRecord(err) && typeof err["message"] === "string") return err["message"];
  return "unknown error";
}

export function writeHeartbeatJson(options?: {
  nbaSidecarConfigured?: boolean;
  providerFailures?: readonly ProviderFailure[];
  nbaSidecarLastSyncAt?: string | null;
  outPath?: string;
}): void {
  const outPath = options?.outPath ?? DEFAULT_OUT;
  const failures = options?.providerFailures ?? [];

  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT sm.source AS source, MAX(qt.captured_at) AS last
       FROM quote_ticks qt
       JOIN source_markets sm ON sm.id = qt.source_market_id
       GROUP BY sm.source`,
    )
    .all() as Array<{ source: string; last: string | null }>;

  const bySource: Record<string, SourceRow> = {};
  for (const r of rows) {
    bySource[r.source] = {
      lastSyncAt: r.last,
      lastError: null,
      rateLimitCooldown: null,
    };
  }

  for (const failure of failures) {
    const existing = bySource[failure.source] ?? {
      lastSyncAt: null,
      lastError: null,
      rateLimitCooldown: null,
    };
    bySource[failure.source] = {
      ...existing,
      lastError: errorMessage(failure.error),
    };
  }

  // nba-sidecar has no quote_ticks rows of its own (it populates games + PBP).
  // Only report it when the worker actually has the sidecar configured; disabled
  // sources should not look freshly synced.
  if (options?.nbaSidecarConfigured === true && !bySource["nba-sidecar"]) {
    bySource["nba-sidecar"] = {
      lastSyncAt: options.nbaSidecarLastSyncAt ?? null,
      lastError: null,
      rateLimitCooldown: null,
    };
  }

  const payload = JSON.stringify({ sources: bySource }, null, 2);
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, outPath);
}
