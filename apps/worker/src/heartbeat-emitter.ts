// Worker-native heartbeat emitter (replaces scripts/emit-heartbeat.mjs).
//
// The Settings route at apps/api/src/routes/settings.ts reads
// apps/worker/data/heartbeat.json after each ingest cycle to populate the
// per-source freshness panel. Schema (mirrored by sourceRowSchema in that
// route): { sources: Record<string, { lastSyncAt, lastError, rateLimitCooldown }> }.
//
// We derive lastSyncAt from the latest successful adapter run per source.
// This keeps heartbeat emission bounded even when quote_ticks is very large.
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
      `SELECT source, MAX(finished_at) AS last
       FROM adapter_runs
       WHERE status = 'ok'
         AND capture_mode = 'live'
         AND finished_at IS NOT NULL
       GROUP BY source`,
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

  const existingNbaSidecar = bySource["nba-sidecar"] ?? bySource["nba"];
  delete bySource["nba"];
  delete bySource["nba-sidecar"];

  // Only report nba-sidecar when the worker actually has the sidecar
  // configured; disabled sources should not look freshly synced. Prefer the
  // current worker cycle's observed sidecar time over older ok adapter rows so
  // partial PBP gaps do not pin Settings to stale freshness.
  if (options?.nbaSidecarConfigured === true) {
    bySource["nba-sidecar"] = {
      lastSyncAt: options.nbaSidecarLastSyncAt ?? existingNbaSidecar?.lastSyncAt ?? null,
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
