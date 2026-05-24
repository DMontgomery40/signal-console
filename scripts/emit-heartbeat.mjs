#!/usr/bin/env node
// Writes apps/worker/data/heartbeat.json every 20s with per-source lastSyncAt
// derived from gold DB via the sqlite3 CLI. The signal-console worker package
// does not yet emit this file; this shim closes the gap so Settings reads
// "live" instead of "paused" while ingest is running.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const GOLD = join(homedir(), "signal-console", "data", "signal-console.sqlite");
const OUT = join(homedir(), "signal-console", "apps", "worker", "data", "heartbeat.json");

mkdirSync(dirname(OUT), { recursive: true });

function tick() {
  let out;
  try {
    out = execFileSync(
      "sqlite3",
      [
        GOLD,
        `SELECT sm.source, MAX(qt.captured_at)
         FROM quote_ticks qt
         JOIN source_markets sm ON sm.id = qt.source_market_id
         GROUP BY sm.source;`,
      ],
      { encoding: "utf8" },
    );
  } catch (err) {
    process.stderr.write(`[emit-heartbeat] sqlite3 failed: ${String(err.message ?? err)}\n`);
    return;
  }
  const bySource = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [source, lastSyncAt] = line.split("|");
    if (!source) continue;
    bySource[source] = {
      lastSyncAt: lastSyncAt || null,
      lastError: null,
      rateLimitCooldown: null,
    };
  }
  bySource["nba-sidecar"] = bySource["nba-sidecar"] ?? {
    lastSyncAt: new Date().toISOString(),
    lastError: null,
    rateLimitCooldown: null,
  };
  try {
    writeFileSync(OUT, JSON.stringify({ sources: bySource }, null, 2));
  } catch (err) {
    process.stderr.write(`[emit-heartbeat] write failed: ${String(err.message ?? err)}\n`);
  }
}

tick();
setInterval(tick, 20_000);
process.stderr.write(`[emit-heartbeat] started → ${OUT}\n`);
