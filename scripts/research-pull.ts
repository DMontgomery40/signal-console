// Thin research-pull CLI over @signal-console/research-pull.
//
// Two modes, mirroring the API route's read/write separation:
//
//   --dry-run  PLANNER ONLY. Calls planPullJob (a pure function: validate +
//              resolve sources + expected artifact class + the operations it
//              WOULD run). Prints the plan or the coded validation errors.
//              Performs NO provider call and NO write of any kind. The provider
//              adapters module is NOT even imported in this path, so "no
//              provider call" is true by construction, not by discipline.
//
//   (default)  REAL ENQUEUE. Validates via planPullJob, then writes a single
//              `queued` job.json artifact under
//              outputs/nba-quant-lab/pulls/<job-id>/ for the worker to drain.
//              This is the queue write, NOT an inline backfill: it does not call
//              any provider and does not touch the gold DB. Invalid requests are
//              rejected and nothing is written.
//
// Usage:
//   tsx scripts/research-pull.ts --dry-run --sources kalshi,polymarket \
//     [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--capture-mode historical] \
//     [--market-scope all] [--game-ids a,b]
//   tsx scripts/research-pull.ts --sources kalshi,polymarket   # real enqueue
//
// Run via the root script: `pnpm quant:pull -- --dry-run --sources kalshi,polymarket`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { planPullJob, type PullPlan } from "../packages/research-pull/src/index";

type Args = {
  readonly dryRun: boolean;
  readonly sources: readonly string[];
  readonly dateFrom: string;
  readonly dateTo: string;
  /** Passed through verbatim; the planner's validator rejects bad enum values. */
  readonly captureMode: string;
  readonly marketScope: string;
  readonly gameIds: readonly string[];
  readonly outputRoot: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getFlag(argv: readonly string[], name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === `--${name}`) return argv[i + 1];
    if (arg !== undefined && arg.startsWith(eqPrefix)) return arg.slice(eqPrefix.length);
  }
  return undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const today = todayIso();
  return {
    dryRun: argv.includes("--dry-run"),
    sources: parseList(getFlag(argv, "sources")),
    dateFrom: getFlag(argv, "from") ?? today,
    dateTo: getFlag(argv, "to") ?? today,
    captureMode: getFlag(argv, "capture-mode") ?? "historical",
    marketScope: getFlag(argv, "market-scope") ?? "all",
    gameIds: parseList(getFlag(argv, "game-ids")),
    outputRoot:
      getFlag(argv, "output-root") ?? resolve(process.cwd(), "outputs", "nba-quant-lab", "pulls"),
  };
}

/**
 * Build the pull-job request shape. Typed as a plain record (not the strict
 * `PullJobRequest`) because the planner accepts `unknown` and is the single
 * source of validation — so the CLI never needs an unchecked enum cast.
 */
function buildRequest(args: Args): Record<string, unknown> {
  return {
    sources: [...args.sources],
    date_from: args.dateFrom,
    date_to: args.dateTo,
    capture_mode: args.captureMode,
    market_scope: args.marketScope,
    ...(args.gameIds.length > 0 ? { game_ids: [...args.gameIds] } : {}),
  };
}

function printPlan(plan: PullPlan): void {
  if (!plan.ok) {
    console.log("PLAN: INVALID — request rejected, nothing enqueued.");
    console.log("validation errors:");
    for (const err of plan.errors) {
      const path = err.path === undefined ? "" : ` (${err.path})`;
      console.log(`  [${err.code}]${path} ${err.message}`);
    }
    return;
  }
  console.log("PLAN: ok");
  console.log(`resolved sources: ${plan.resolvedSources.join(", ")}`);
  console.log(`bookmakers: ${plan.bookmakers.length > 0 ? plan.bookmakers.join(", ") : "(none)"}`);
  for (const source of plan.sources) {
    console.log(`\n  source ${source.id}  [artifact class: ${source.artifactClass}]`);
    for (const op of source.operations) {
      const target = op.target === undefined ? "" : `  -> ${op.target}`;
      console.log(`    - ${op.kind}: ${op.description}${target}`);
    }
  }
}

export type PullCliResult = {
  /** Process exit code. */
  readonly code: number;
  readonly mode: "dry-run" | "enqueue";
  readonly plan: PullPlan;
  /** Absolute path of the job.json written, or undefined when nothing was written. */
  readonly enqueuedPath?: string;
  readonly jobId?: string;
};

/**
 * Pure-ish CLI core: given argv, plan and (only on the enqueue path) write a
 * single `queued` job.json. The dry-run branch returns BEFORE any filesystem
 * call, so it provably performs no write. No provider adapter is imported in
 * either branch.
 */
export function runResearchPull(argv: readonly string[]): PullCliResult {
  const args = parseArgs(argv);

  if (args.sources.length === 0) {
    console.error(
      "error: at least one --sources value is required (e.g. --sources kalshi,polymarket)",
    );
    return { code: 2, mode: args.dryRun ? "dry-run" : "enqueue", plan: emptyPlan() };
  }

  const request = buildRequest(args);
  const now = Math.floor(Date.now() / 1000);
  const plan = planPullJob(request, { now });

  if (args.dryRun) {
    console.log("MODE: dry-run (planner only — NO provider calls, NO writes)\n");
    printPlan(plan);
    return { code: plan.ok ? 0 : 1, mode: "dry-run", plan };
  }

  // Real enqueue path. Reject invalid requests WITHOUT writing anything.
  if (!plan.ok) {
    console.error("MODE: enqueue — request INVALID, nothing enqueued.\n");
    printPlan(plan);
    return { code: 1, mode: "enqueue", plan };
  }

  const jobId = `pull-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const jobDir = join(args.outputRoot, jobId);
  const jobPath = join(jobDir, "job.json");
  const nowIso = new Date().toISOString();
  // A `queued` job artifact: the queue write only. The worker (which owns the
  // @signal-console/adapters runtime dep) drains this and runs the real pull.
  // This CLI deliberately never imports an adapter or touches the gold DB.
  const job = {
    jobId,
    state: "queued" as const,
    request,
    createdAt: nowIso,
    startedAt: "",
    finishedAt: "",
    resolvedSources: [...plan.resolvedSources],
    bookmakers: [...plan.bookmakers],
  };
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  console.log("MODE: enqueue\n");
  printPlan(plan);
  console.log(`\nenqueued: ${jobPath}`);
  console.log(`job_id: ${jobId}  state: queued`);
  return { code: 0, mode: "enqueue", plan, enqueuedPath: jobPath, jobId };
}

function emptyPlan(): PullPlan {
  return { ok: false, resolvedSources: [], bookmakers: [], sources: [], errors: [] };
}

// Only run as a CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runResearchPull(process.argv.slice(2)).code);
}
