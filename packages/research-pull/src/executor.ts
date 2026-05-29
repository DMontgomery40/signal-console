import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { getSourceCapability, type ArtifactClass } from "./capability-matrix";
import type { PullJobRequest } from "./contract";
import { planPullJob, type PullPlan } from "./planner";
import { redactOddsApiIoUrl } from "./redact";
import { type ValidateOptions } from "./validator";

/**
 * THIN PULL EXECUTOR.
 *
 * Takes a request, VALIDATES + PLANS it (via `planPullJob`, so "takes a
 * validated plan" is literally true), then DISPATCHES each resolved source to
 * the EXISTING adapter sync functions. It never reimplements ingestion.
 *
 * Structural-safety guarantees (true by construction, not by discipline):
 *
 *  - This module holds NO database handle and NO network client of its own.
 *    Every provider call and every canonical DB write happens INSIDE an
 *    injected adapter function. The executor only orchestrates and writes a
 *    job folder of evidence to a local directory.
 *  - Adapters are dependency-INJECTED (`ExecutorAdapters`), mirroring the
 *    worker's `runAdminActionWorkerOnce(options)` shape. That keeps this
 *    package a dependency LEAF (zod only, no `@signal-console/adapters` runtime
 *    dep, mirroring detectors/validator) AND lets the unit tests pass mocked
 *    adapters so no real provider call or DB write occurs.
 *  - The admin-action queue PATTERN is mirrored (per-source try/catch + a
 *    queued|running|succeeded|partial|failed state machine), but the DB-bound
 *    `claimNextQueuedAdminAction` / `markAdminAction*` functions are
 *    deliberately NOT imported — importing them would break the leaf invariant
 *    and the no-DB safety guarantee.
 *
 * Artifact-only sources (Odds-API.io) dispatch to the `fetch*` helpers and are
 * written ONLY into the job folder as redacted artifacts. They are NEVER routed
 * through a canonical `sync*` adapter and never persisted to gold.
 */

/* ----------------------------- adapter bundle ----------------------------- */

/**
 * Structural mirror of the canonical adapter option shapes
 * (`packages/adapters/src/*`, as consumed by `apps/worker/src/backfill.ts`).
 * Declared locally so this package stays a dependency leaf. The worker — which
 * already depends on `@signal-console/adapters` — passes the real functions in;
 * the tests pass mocks. Return values are captured as opaque evidence, so they
 * are typed `unknown`.
 *
 * Keep these option fields in sync with the adapter signatures.
 */
export type CanonicalSyncSummary = unknown;

export type ExecutorAdapters = {
  /** kalshi-direct.ts syncKalshiNbaDirect */
  readonly syncKalshiNbaDirect: (options?: {
    captureMode?: "historical" | "live";
    maxEvents?: number;
    minimumStartDate?: string;
  }) => Promise<CanonicalSyncSummary>;
  /** kalshi-historical.ts syncKalshiNbaHistorical */
  readonly syncKalshiNbaHistorical: (options?: {
    dateFrom?: string;
    dateTo?: string;
    maxEvents?: number;
    maxMarkets?: number;
  }) => Promise<CanonicalSyncSummary>;
  /** kalshi-trades.ts syncKalshiNbaTrades (ISO timestamp window) */
  readonly syncKalshiNbaTrades: (options: {
    since: string;
    until: string;
    gameId?: string;
    league?: string;
    maxTickers?: number;
  }) => Promise<CanonicalSyncSummary>;
  /** polymarket-historical.ts syncPolymarketNbaHistorical */
  readonly syncPolymarketNbaHistorical: (options?: {
    fidelityMinutes?: number;
    maxEvents?: number;
    since?: string;
  }) => Promise<CanonicalSyncSummary>;
  /** polymarket-trades.ts syncPolymarketNbaTrades (ISO timestamp window) */
  readonly syncPolymarketNbaTrades: (options: {
    since: string;
    until: string;
    gameId?: string;
    league?: string;
    maxMarkets?: number;
  }) => Promise<CanonicalSyncSummary>;
  /** bet365-direct.ts syncBet365DirectLive */
  readonly syncBet365DirectLive: (options?: {
    gameLimit?: number;
    headless?: boolean;
  }) => Promise<CanonicalSyncSummary>;
  /** bet365-historical.ts syncBet365Historical */
  readonly syncBet365Historical: (options?: {
    dateFrom?: string;
    dateTo?: string;
    maxEvents?: number;
  }) => Promise<CanonicalSyncSummary>;
  /** bet365-internal-dump.ts syncBet365InternalDump (sync) */
  readonly syncBet365InternalDump: (options?: {
    dumpDir?: string;
    maxRowsPerRun?: number;
  }) => CanonicalSyncSummary;
  /** odds-api-io-live-comparator.ts fetchOddsApiIoNbaEvents */
  readonly fetchOddsApiIoNbaEvents: (options: {
    apiKey: string;
    from?: string;
    league?: string;
    to?: string;
  }) => Promise<unknown>;
  /** odds-api-io-live-comparator.ts fetchOddsApiIoEventOddsSnapshot */
  readonly fetchOddsApiIoEventOddsSnapshot: (options: {
    apiKey: string;
    bookmakers?: readonly string[];
    eventIds: readonly (number | string)[];
  }) => Promise<unknown>;
  /** odds-api-io-live-comparator.ts fetchOddsApiIoUpdatedDelta */
  readonly fetchOddsApiIoUpdatedDelta: (options: {
    apiKey: string;
    bookmaker: string;
    sinceUnixSeconds: number;
  }) => Promise<unknown>;
  /** Resolve the Odds-API.io key. Default reads env; tests inject a stub. */
  readonly readOddsApiIoApiKey?: () => string | null;
};

/* ------------------------------ job records ------------------------------- */

export const JOB_STATES = ["queued", "running", "succeeded", "partial", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Artifacts larger than this (bytes) are gzipped on disk. */
export const ARTIFACT_GZIP_THRESHOLD_BYTES = 16 * 1024;

export type StoredArtifact = {
  readonly source: string;
  readonly file: string;
  /** sha256 of the REDACTED bytes that were written (before gzip). */
  readonly contentHash: string;
  readonly gzip: boolean;
  /** Size of the redacted payload before gzip, in bytes. */
  readonly bytes: number;
  readonly redacted: boolean;
};

export type SourceResult = {
  readonly id: string;
  readonly artifactClass: ArtifactClass;
  readonly state: "succeeded" | "failed" | "noop";
  readonly operations: readonly string[];
  readonly artifacts: readonly StoredArtifact[];
  readonly error?: string;
};

export type PullJob = {
  readonly jobId: string;
  readonly state: JobState;
  readonly request: PullJobRequest;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resolvedSources: readonly string[];
  readonly bookmakers: readonly string[];
};

export type ExecuteResult = {
  readonly job: PullJob;
  readonly plan: PullPlan;
  readonly sources: readonly SourceResult[];
  readonly artifacts: readonly StoredArtifact[];
  readonly jobDir: string;
};

export type ExecuteOptions = ValidateOptions & {
  /** Root under which `<job-id>/` is created. e.g. outputs/nba-quant-lab/pulls */
  readonly outputRoot: string;
  readonly jobId: string;
  readonly adapters: ExecutorAdapters;
  /** ISO clock for job timestamps. Defaults to wall clock. */
  readonly clock?: () => Date;
};

/* ----------------------------- evidence I/O ------------------------------- */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip secret-bearing material from arbitrary evidence before it ever touches
 * disk. Redacts Odds-API.io URLs (apiKey query param) wherever they appear as
 * string values, and drops keys whose name implies a secret (apiKey, api_key,
 * token, authorization, secret, key — except descriptive *_count style keys).
 */
export function redactEvidence(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(https?|wss?):\/\//i.test(value)) {
      try {
        return redactOddsApiIoUrl(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEvidence(entry));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        out[k] = "REDACTED";
        continue;
      }
      out[k] = redactEvidence(v);
    }
    return out;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "apikey" ||
    k === "api_key" ||
    k === "token" ||
    k === "authorization" ||
    k === "secret" ||
    k === "key" ||
    k.endsWith("_key") ||
    k.endsWith("_token") ||
    k.endsWith("_secret")
  );
}

/**
 * Write one evidence artifact under the job dir. Order is fixed and load-bearing:
 *   redact -> serialize -> gzip-if-large -> write -> hash(redacted bytes).
 * The content hash is computed over the REDACTED bytes, so no secret ever
 * reaches disk or the manifest hash.
 */
function writeArtifact(
  jobDir: string,
  source: string,
  basename: string,
  payload: unknown,
): StoredArtifact {
  const redacted = redactEvidence(payload);
  const json = `${JSON.stringify(redacted, null, 2)}\n`;
  const bytes = Buffer.from(json, "utf8");
  const contentHash = createHash("sha256").update(bytes).digest("hex");

  const sourceDir = join(jobDir, "evidence", source);
  mkdirSync(sourceDir, { recursive: true });

  const useGzip = bytes.byteLength > ARTIFACT_GZIP_THRESHOLD_BYTES;
  const file = useGzip ? `${basename}.json.gz` : `${basename}.json`;
  const abs = join(sourceDir, file);
  writeFileSync(abs, useGzip ? gzipSync(bytes) : bytes);

  return {
    source,
    file: join("evidence", source, file),
    contentHash,
    gzip: useGzip,
    bytes: bytes.byteLength,
    redacted: true,
  };
}

/* ------------------------------- dispatch --------------------------------- */

/** Calendar-date -> inclusive ISO-timestamp day bounds for trades windows. */
function dayBounds(dateFrom: string, dateTo: string): { since: string; until: string } {
  return { since: `${dateFrom}T00:00:00Z`, until: `${dateTo}T23:59:59Z` };
}

/**
 * Dispatch ONE canonical (snapshot-eligible) source to the right adapter,
 * keyed by (source id, capture_mode). Mirrors `apps/worker/src/backfill.ts`
 * option mapping exactly. Returns the adapter summary as opaque evidence.
 *
 * Trades adapters need an ISO TIMESTAMP window but the contract only carries
 * calendar dates, so `market_scope: "player-props"` derives day bounds via
 * `dayBounds`. Otherwise the historical board adapters are used.
 */
async function dispatchCanonical(
  id: string,
  request: PullJobRequest,
  adapters: ExecutorAdapters,
): Promise<{ operations: string[]; summary: CanonicalSyncSummary }> {
  const { capture_mode, market_scope, date_from, date_to, game_ids } = request;
  const wantsTrades = market_scope === "player-props";
  const firstGameId = game_ids?.[0];

  switch (id) {
    case "kalshi": {
      if (capture_mode === "live-capture") {
        return {
          operations: ["syncKalshiNbaDirect({captureMode:'live'})"],
          summary: await adapters.syncKalshiNbaDirect({ captureMode: "live" }),
        };
      }
      // historical | repair
      if (wantsTrades) {
        const { since, until } = dayBounds(date_from, date_to);
        return {
          operations: ["syncKalshiNbaTrades"],
          summary: await adapters.syncKalshiNbaTrades({
            since,
            until,
            ...(firstGameId ? { gameId: firstGameId } : {}),
          }),
        };
      }
      return {
        operations: ["syncKalshiNbaHistorical"],
        summary: await adapters.syncKalshiNbaHistorical({
          dateFrom: date_from,
          dateTo: date_to,
        }),
      };
    }

    case "polymarket": {
      if (wantsTrades) {
        const { since, until } = dayBounds(date_from, date_to);
        return {
          operations: ["syncPolymarketNbaTrades"],
          summary: await adapters.syncPolymarketNbaTrades({
            since,
            until,
            ...(firstGameId ? { gameId: firstGameId } : {}),
          }),
        };
      }
      return {
        operations: ["syncPolymarketNbaHistorical"],
        summary: await adapters.syncPolymarketNbaHistorical({
          fidelityMinutes: 1,
          since: date_from,
        }),
      };
    }

    case "bet365": {
      if (capture_mode === "live-capture") {
        return {
          operations: ["syncBet365DirectLive"],
          summary: await adapters.syncBet365DirectLive({ headless: true }),
        };
      }
      // historical | repair go through the Odds API historical adapter; the
      // internal dump path is reserved for repair from a local dump.
      if (capture_mode === "repair") {
        return {
          operations: ["syncBet365InternalDump"],
          summary: adapters.syncBet365InternalDump(),
        };
      }
      return {
        operations: ["syncBet365Historical"],
        summary: await adapters.syncBet365Historical({
          dateFrom: date_from,
          dateTo: date_to,
        }),
      };
    }

    case "nba": {
      // NBA sidecar is wired in the worker, not exposed as an adapter sync fn
      // in this leaf bundle; treat as a noop here so the executor never
      // pretends to ingest game state it cannot reach.
      return {
        operations: ["noop:nba-sidecar-handled-by-worker"],
        summary: { note: "nba sidecar handled by worker backfill, not this executor" },
      };
    }

    default:
      return {
        operations: [`noop:no-dispatch-for-${id}`],
        summary: { note: `no canonical dispatch wired for source ${id}` },
      };
  }
}

/**
 * Dispatch the Odds-API.io ARTIFACT-ONLY source. NEVER calls a canonical sync
 * fn; results are written only into the job folder as redacted artifacts.
 */
async function dispatchArtifactOnly(
  request: PullJobRequest,
  bookmakers: readonly string[],
  adapters: ExecutorAdapters,
): Promise<{ operations: string[]; artifacts: { name: string; payload: unknown }[] }> {
  const options = request.odds_api_io;
  if (!options) {
    return { operations: ["noop:no-odds-api-io-options"], artifacts: [] };
  }
  const readKey = adapters.readOddsApiIoApiKey ?? (() => null);
  const apiKey = readKey();
  if (!apiKey) {
    throw new Error(
      "Odds-API.io artifact pull requires an API key (ODDSAPI_API_KEY/ODDS_API_KEY/ODDS_API_IO_KEY).",
    );
  }

  switch (options.mode) {
    case "events-snapshot": {
      const events = await adapters.fetchOddsApiIoNbaEvents({
        apiKey,
        from: request.date_from,
        to: request.date_to,
        ...(options.league ? { league: options.league } : {}),
      });
      const eventIds = options.event_ids ?? extractEventIds(events);
      const snapshot = await adapters.fetchOddsApiIoEventOddsSnapshot({
        apiKey,
        bookmakers,
        eventIds,
      });
      return {
        operations: ["fetchOddsApiIoNbaEvents", "fetchOddsApiIoEventOddsSnapshot"],
        artifacts: [
          { name: "events", payload: events },
          { name: "snapshot", payload: snapshot },
        ],
      };
    }
    case "updated-follow": {
      const bookmaker = bookmakers[0];
      const delta = await adapters.fetchOddsApiIoUpdatedDelta({
        apiKey,
        bookmaker: bookmaker ?? "",
        sinceUnixSeconds: options.since ?? 0,
      });
      return {
        operations: ["fetchOddsApiIoUpdatedDelta"],
        artifacts: [{ name: "updated-delta", payload: delta }],
      };
    }
    case "live-ws": {
      // WebSocket capture is a long-lived stream; the executor records the
      // planned target only (no socket is opened here). Live capture is driven
      // by a dedicated streaming worker, not this batch executor.
      return {
        operations: ["plan-only:live-ws"],
        artifacts: [
          {
            name: "live-ws-plan",
            payload: {
              note: "live-ws is handled by a streaming worker, not the batch executor",
              markets: options.markets,
            },
          },
        ],
      };
    }
    default: {
      const exhaustive: never = options.mode;
      return exhaustive;
    }
  }
}

function extractEventIds(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  const ids: string[] = [];
  for (const event of events) {
    if (isPlainRecord(event)) {
      const id = event.id ?? event.eventId ?? event.event_id;
      if (typeof id === "string" || typeof id === "number") {
        ids.push(String(id));
      }
    }
  }
  return ids.slice(0, 10);
}

/* -------------------------------- writer ---------------------------------- */

function writeJobFolder(
  jobDir: string,
  job: PullJob,
  sources: readonly SourceResult[],
  artifacts: readonly StoredArtifact[],
): void {
  mkdirSync(jobDir, { recursive: true });

  const summary = {
    jobId: job.jobId,
    state: job.state,
    resolvedSources: job.resolvedSources,
    bookmakers: job.bookmakers,
    sources: sources.map((s) => ({
      id: s.id,
      artifactClass: s.artifactClass,
      state: s.state,
      operations: s.operations,
      artifactCount: s.artifacts.length,
      error: s.error,
    })),
    artifactCount: artifacts.length,
  };

  writeFileSync(join(jobDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(
    join(jobDir, "manifest.json"),
    `${JSON.stringify({ jobId: job.jobId, artifacts }, null, 2)}\n`,
  );
  writeFileSync(join(jobDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(jobDir, "SUMMARY.md"), renderSummaryMd(job, sources, artifacts));
}

function renderSummaryMd(
  job: PullJob,
  sources: readonly SourceResult[],
  artifacts: readonly StoredArtifact[],
): string {
  const lines: string[] = [
    `# Pull job ${job.jobId}`,
    "",
    `- State: **${job.state}**`,
    `- Window: ${job.request.date_from} -> ${job.request.date_to}`,
    `- Capture mode: ${job.request.capture_mode}`,
    `- Market scope: ${job.request.market_scope}`,
    `- Resolved sources: ${job.resolvedSources.join(", ") || "(none)"}`,
    `- Bookmakers: ${job.bookmakers.join(", ") || "(none)"}`,
    `- Started: ${job.startedAt}`,
    `- Finished: ${job.finishedAt}`,
    "",
    "## Sources",
    "",
    "| Source | Class | State | Operations | Artifacts |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of sources) {
    lines.push(
      `| ${s.id} | ${s.artifactClass} | ${s.state} | ${s.operations.join("; ") || "-"} | ${s.artifacts.length}${s.error ? ` (error: ${s.error})` : ""} |`,
    );
  }
  lines.push("", "## Artifacts", "");
  if (artifacts.length === 0) {
    lines.push("_None written._");
  } else {
    lines.push("| File | gzip | bytes | sha256 |", "| --- | --- | --- | --- |");
    for (const a of artifacts) {
      lines.push(`| ${a.file} | ${a.gzip} | ${a.bytes} | ${a.contentHash.slice(0, 16)}… |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------- executor --------------------------------- */

/**
 * Execute a pull job: validate+plan, dispatch each source to the injected
 * adapters, write a job folder of redacted evidence, and return the result.
 *
 * If validation fails, writes a `failed` job folder and returns it; no adapter
 * is called.
 */
export async function executePullJob(
  input: unknown,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const clock = options.clock ?? (() => new Date());
  const createdAt = clock().toISOString();
  const jobDir = join(options.outputRoot, options.jobId);

  const plan = planPullJob(input, { now: options.now });

  if (!plan.ok) {
    const startedAt = clock().toISOString();
    const finishedAt = clock().toISOString();
    const failedJob: PullJob = {
      jobId: options.jobId,
      state: "failed",
      // input failed validation; persist the raw input shape for evidence.
      request: input as PullJobRequest,
      createdAt,
      startedAt,
      finishedAt,
      resolvedSources: [],
      bookmakers: [],
    };
    const failArtifacts: StoredArtifact[] = [];
    mkdirSync(jobDir, { recursive: true });
    failArtifacts.push(writeArtifact(jobDir, "_validation", "errors", { errors: plan.errors }));
    writeJobFolder(jobDir, failedJob, [], failArtifacts);
    return { job: failedJob, plan, sources: [], artifacts: failArtifacts, jobDir };
  }

  const request = (() => {
    // plan.ok guarantees the input parsed; reuse the validated shape.
    return input as PullJobRequest;
  })();

  const startedAt = clock().toISOString();
  const sourceResults: SourceResult[] = [];
  const allArtifacts: StoredArtifact[] = [];

  for (const planned of plan.sources) {
    const capability = getSourceCapability(planned.id);
    const sourceClass = capability?.class;
    const artifactClass: ArtifactClass = planned.artifactClass;

    try {
      if (sourceClass === "snapshot-eligible") {
        const { operations, summary } = await dispatchCanonical(
          planned.id,
          request,
          options.adapters,
        );
        const artifact = writeArtifact(jobDir, planned.id, "summary", summary);
        allArtifacts.push(artifact);
        sourceResults.push({
          id: planned.id,
          artifactClass,
          state: "succeeded",
          operations,
          artifacts: [artifact],
        });
      } else if (sourceClass === "artifact-only") {
        const { operations, artifacts } = await dispatchArtifactOnly(
          request,
          plan.bookmakers,
          options.adapters,
        );
        const stored = artifacts.map((a) => writeArtifact(jobDir, planned.id, a.name, a.payload));
        allArtifacts.push(...stored);
        sourceResults.push({
          id: planned.id,
          artifactClass,
          state: "succeeded",
          operations,
          artifacts: stored,
        });
      } else {
        // pending: no concrete operations.
        sourceResults.push({
          id: planned.id,
          artifactClass,
          state: "noop",
          operations: planned.operations.map((op) => op.kind),
          artifacts: [],
        });
      }
    } catch (error) {
      sourceResults.push({
        id: planned.id,
        artifactClass,
        state: "failed",
        operations: planned.operations.map((op) => op.kind),
        artifacts: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finishedAt = clock().toISOString();
  const state = resolveJobState(sourceResults);
  const job: PullJob = {
    jobId: options.jobId,
    state,
    request,
    createdAt,
    startedAt,
    finishedAt,
    resolvedSources: plan.resolvedSources,
    bookmakers: plan.bookmakers,
  };

  writeJobFolder(jobDir, job, sourceResults, allArtifacts);
  return { job, plan, sources: sourceResults, artifacts: allArtifacts, jobDir };
}

/**
 * Job state machine (mirrors the worker admin-action failure handling):
 *  - all sources failed  -> failed
 *  - some failed, some ok -> partial
 *  - none failed          -> succeeded
 * `noop` sources (pending) do not count as failures.
 */
export function resolveJobState(sources: readonly SourceResult[]): JobState {
  const failed = sources.filter((s) => s.state === "failed").length;
  const succeeded = sources.filter((s) => s.state === "succeeded").length;
  if (failed === 0) {
    return "succeeded";
  }
  if (succeeded === 0) {
    return "failed";
  }
  return "partial";
}
