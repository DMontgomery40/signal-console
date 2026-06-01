// Research artifact read services.
//
// READ-ONLY filesystem helpers for the research-lab artifact tree under
// outputs/nba-quant-lab/. Every reader is resilient: a missing root, an empty
// directory, or a malformed JSON file resolves to a clean empty payload rather
// than throwing. The single writer (the pull enqueue) lives in the route, not
// here, so read/write separation is enforced structurally.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { GOLD_DB_PATH, openGoldDb } from "@signal-console/db";
import { SOURCE_CAPABILITY_MATRIX, type SourceCapability } from "@signal-console/research-pull";

/**
 * Default research artifact root: `<repo-root>/outputs/nba-quant-lab`.
 *
 * Resolved RELATIVE TO THIS MODULE (apps/api/src/services), not `process.cwd()`,
 * because the api runs with cwd=apps/api under `pnpm --filter`, which would make
 * a cwd-relative path point at a nonexistent `apps/api/outputs/...`. The
 * `RESEARCH_OUTPUT_ROOT` env var overrides it (e.g. to read a git-worktree's
 * outputs tree). Tests inject `outputRoot` directly; nothing here writes.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const DEFAULT_RESEARCH_OUTPUT_ROOT: string =
  process.env["RESEARCH_OUTPUT_ROOT"] ?? resolve(REPO_ROOT, "outputs", "nba-quant-lab");

/** The durable researcher guide. Lives in docs/ (outside the Vite web root), so
 * the /research "Open Quant Guide" link opens it via the API, not a static path
 * that would fall through to the SPA shell. */
export const DEFAULT_QUANT_GUIDE_PATH: string = resolve(
  REPO_ROOT,
  "docs",
  "quant-researcher-guide.md",
);

export interface QuantGuidePayload {
  readonly found: boolean;
  readonly content: string;
}

/** Reads the researcher guide markdown. Never throws — a missing file yields
 * found:false so the route can answer 404 instead of crashing. */
export function getQuantGuide(options: { readonly guidePath?: string } = {}): QuantGuidePayload {
  const guidePath = options.guidePath ?? DEFAULT_QUANT_GUIDE_PATH;
  try {
    return { found: true, content: readFileSync(guidePath, "utf8") };
  } catch {
    return { found: false, content: "" };
  }
}

/** Static fallback model registry when no models.json artifact exists. */
export const STATIC_MODELS: readonly ResearchModel[] = [
  {
    id: "robust_mad",
    label: "Robust MAD",
    description:
      "Robust median-absolute-deviation residual detector. Artifact-backed fallback entry; replaced when the python CLI emits models.json.",
    source: "static",
  },
  {
    id: "state_space_current",
    label: "State-space (current)",
    description:
      "Shared state-space runtime model. Artifact-backed fallback entry; replaced when the python CLI emits models.json.",
    source: "static",
  },
];

export interface ResearchModel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** "registry" when read from models.json, "static" when the fallback list. */
  readonly source: "registry" | "static";
}

export interface ResearchServiceOptions {
  /** Root that every reader resolves under. Defaults to the worktree tree. */
  readonly outputRoot?: string;
}

function safeReadJson(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeListDirs(root: string): readonly string[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** mtime in ms for a path, or 0 when it cannot be read. */
function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Pick the "latest" directory under `root` that contains `manifestName`.
 * Prefers an ISO `generatedAt`/`created_utc` timestamp inside the manifest;
 * falls back to file mtime, then to a stable lexical sort so ties are
 * deterministic. Returns undefined when no directory has the manifest.
 */
function timestampFromManifest(path: string): number {
  const parsed = safeReadJson(path);
  if (!isRecord(parsed)) return 0;
  const iso =
    (typeof parsed["generatedAt"] === "string" && parsed["generatedAt"]) ||
    (typeof parsed["created_utc"] === "string" && parsed["created_utc"]) ||
    (typeof parsed["createdAt"] === "string" && parsed["createdAt"]) ||
    "";
  const parsedMs = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsedMs) ? parsedMs : 0;
}

function pickLatest(
  root: string,
  manifestName: string,
  /**
   * Optional sibling file the directory's timestamp should be read from when
   * the required artifact (`manifestName`) itself carries no timestamp (e.g.
   * leaderboard.json is a bare array; its run is dated by run-manifest.json).
   */
  timestampFrom?: string,
): { readonly dir: string; readonly manifestPath: string } | undefined {
  const dirs = safeListDirs(root);
  let best: { dir: string; manifestPath: string; ts: number; mtime: number } | undefined;
  for (const dir of dirs) {
    const manifestPath = join(root, dir, manifestName);
    if (!existsSync(manifestPath)) continue;
    const timestampPath =
      timestampFrom === undefined ? manifestPath : join(root, dir, timestampFrom);
    const ts = timestampFromManifest(timestampPath);
    const mtime = safeMtime(manifestPath);
    const candidate = { dir, manifestPath, ts, mtime };
    if (
      best === undefined ||
      candidate.ts > best.ts ||
      (candidate.ts === best.ts && candidate.mtime > best.mtime) ||
      (candidate.ts === best.ts && candidate.mtime === best.mtime && candidate.dir > best.dir)
    ) {
      best = candidate;
    }
  }
  return best === undefined ? undefined : { dir: best.dir, manifestPath: best.manifestPath };
}

/* ------------------------------- sources ---------------------------------- */

export interface ResearchSourcesPayload {
  readonly sources: readonly SourceCapability[];
}

/** Capability matrix from the shared research-pull package. Pure, no I/O. */
export function getResearchSources(): ResearchSourcesPayload {
  return { sources: SOURCE_CAPABILITY_MATRIX };
}

/* -------------------------------- pulls ----------------------------------- */

export interface ResearchPullsPayload {
  readonly pulls: readonly Record<string, unknown>[];
}

function pullsRoot(outputRoot: string): string {
  return join(outputRoot, "pulls");
}

/** List every pull job.json under pulls/<id>/. Empty/malformed -> empty list. */
export function listResearchPulls(options: ResearchServiceOptions = {}): ResearchPullsPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const root = pullsRoot(outputRoot);
  const pulls: Record<string, unknown>[] = [];
  for (const dir of safeListDirs(root)) {
    const job = safeReadJson(join(root, dir, "job.json"));
    if (isRecord(job)) {
      pulls.push(job);
    }
  }
  // Newest first when a comparable createdAt is present; otherwise stable.
  pulls.sort((a, b) => {
    const at = typeof a["createdAt"] === "string" ? Date.parse(a["createdAt"]) : 0;
    const bt = typeof b["createdAt"] === "string" ? Date.parse(b["createdAt"]) : 0;
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  return { pulls };
}

/** Read a single pull job by id. Returns undefined when absent/malformed. */
export function getResearchPull(
  id: string,
  options: ResearchServiceOptions = {},
): Record<string, unknown> | undefined {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  // Guard the id the same way artifact ids are guarded: a pull id is a single
  // path segment, never a traversal.
  if (!isSafeSegment(id)) return undefined;
  const job = safeReadJson(join(pullsRoot(outputRoot), id, "job.json"));
  return isRecord(job) ? job : undefined;
}

/* ------------------------------ snapshot ---------------------------------- */

export interface ResearchSnapshotPayload {
  readonly snapshot: Record<string, unknown> | null;
}

/** Latest snapshots/<id>/manifest.json. Absent -> { snapshot: null }. */
export function getLatestSnapshot(options: ResearchServiceOptions = {}): ResearchSnapshotPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const latest = pickLatest(join(outputRoot, "snapshots"), "manifest.json");
  if (latest === undefined) return { snapshot: null };
  const parsed = safeReadJson(latest.manifestPath);
  return { snapshot: isRecord(parsed) ? parsed : null };
}

/* ------------------------------ leaderboard ------------------------------- */

export interface ResearchLeaderboardPayload {
  readonly runId: string | null;
  readonly rows: readonly Record<string, unknown>[];
}

/** Latest runs/<id>/leaderboard.json. Absent -> empty rows. */
export function getLatestLeaderboard(
  options: ResearchServiceOptions = {},
): ResearchLeaderboardPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const latest = pickLatest(join(outputRoot, "runs"), "leaderboard.json", "run-manifest.json");
  if (latest === undefined) return { runId: null, rows: [] };
  const parsed = safeReadJson(latest.manifestPath);
  const rows = Array.isArray(parsed)
    ? parsed.filter((row): row is Record<string, unknown> => isRecord(row))
    : [];
  return { runId: latest.dir, rows };
}

/* -------------------------------- models ---------------------------------- */

export interface ResearchModelsPayload {
  readonly models: readonly ResearchModel[];
}

/**
 * Registered models. Prefers an artifact-backed models.json the python CLI can
 * emit at the root of the output tree; falls back to the static list. Never
 * throws on a malformed file.
 */
export function getResearchModels(options: ResearchServiceOptions = {}): ResearchModelsPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const parsed = safeReadJson(join(outputRoot, "models.json"));
  const raw = isRecord(parsed) ? parsed["models"] : parsed;
  if (Array.isArray(raw)) {
    const models: ResearchModel[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const id = entry["id"];
      if (typeof id !== "string" || id.length === 0) continue;
      models.push({
        id,
        label: typeof entry["label"] === "string" ? entry["label"] : id,
        description: typeof entry["description"] === "string" ? entry["description"] : "",
        source: "registry",
      });
    }
    if (models.length > 0) {
      return { models };
    }
  }
  return { models: STATIC_MODELS };
}

/* ----------------------------- attribution -------------------------------- */

export interface ResearchAttributionPayload {
  /** The latest attribution re-ranker report, or null when not yet emitted. */
  readonly attribution: Record<string, unknown> | null;
}

/**
 * Root-level attribution_reranker.json emitted by `pnpm quant attribution-eval`
 * (the signed-paired re-ranker over incident truth, stratified player_swap vs
 * team_dispute). Absent/malformed -> { attribution: null }; never throws.
 */
export function getLatestAttribution(
  options: ResearchServiceOptions = {},
): ResearchAttributionPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const parsed = safeReadJson(join(outputRoot, "attribution_reranker.json"));
  return { attribution: isRecord(parsed) ? parsed : null };
}

/* --------------------------- FAR calibration ------------------------------ */

export interface ResearchFarCalibrationPayload {
  /** The latest FAR-on-control + matched-recall report, or null when not emitted. */
  readonly farCalibration: Record<string, unknown> | null;
}

/**
 * Root-level far_calibration.json emitted by `pnpm quant far-calibration` (the
 * re-ranker's false-alarm rate on non-incident control games, with matched
 * incident recall at the same operating point). Absent/malformed ->
 * { farCalibration: null }; never throws.
 */
export function getLatestFarCalibration(
  options: ResearchServiceOptions = {},
): ResearchFarCalibrationPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const parsed = safeReadJson(join(outputRoot, "far_calibration.json"));
  return { farCalibration: isRecord(parsed) ? parsed : null };
}

/* --------------------------- confluence eval ------------------------------ */

export interface ResearchConfluenceEvalPayload {
  /** The latest whole-board confluence gate + operating-point report, or null. */
  readonly confluenceEval: Record<string, unknown> | null;
}

/**
 * Root-level confluence_eval.json emitted by `pnpm quant confluence-eval` (the
 * third-model eval-first: a falsification gate — do incidents stand out vs their
 * own game? — plus the operating-point bar of >=70% recall at <=3:1 false alarms).
 * The gate can pass while the bar fails; the UI shows both. Absent/malformed ->
 * { confluenceEval: null }; never throws.
 */
export function getLatestConfluenceEval(
  options: ResearchServiceOptions = {},
): ResearchConfluenceEvalPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const parsed = safeReadJson(join(outputRoot, "confluence_eval.json"));
  return { confluenceEval: isRecord(parsed) ? parsed : null };
}

/* ----------------------------- harvested labels --------------------------- */

export interface ResearchHarvestedLabelsPayload {
  /** The latest harvested-miscredit-label report, or null when not yet emitted. */
  readonly harvestedLabels: Record<string, unknown> | null;
}

/**
 * Root-level harvested_incidents.json emitted by `pnpm tsx
 * scripts/harvest-incident-labels.ts` — credited->rightful corrections recovered
 * by diffing the versioned PBP-revision shadow (the label engine; NBA corrections
 * are silent edits with no official feed). Absent/malformed -> { harvestedLabels:
 * null }; never throws. Empty incidents is expected until captures accumulate.
 */
export function getLatestHarvestedLabels(
  options: ResearchServiceOptions = {},
): ResearchHarvestedLabelsPayload {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const parsed = safeReadJson(join(outputRoot, "harvested_incidents.json"));
  return { harvestedLabels: isRecord(parsed) ? parsed : null };
}

/* --------------------------------- gold ----------------------------------- */

export interface ResearchGoldPayload {
  /** Gold DB file exists and opened read-only. */
  readonly present: boolean;
  /** Absolute gold DB path inspected. */
  readonly path: string;
  /** File size in bytes (0 if absent). */
  readonly sizeBytes: number;
  /** ISO mtime ("" if absent). */
  readonly lastModified: string;
  /** SELECT count(*) FROM games; null if DB absent/unreadable. */
  readonly gameCount: number | null;
}

export interface ResearchGoldOptions {
  /** Gold DB path to inspect. Defaults to the shared GOLD_DB_PATH. */
  readonly goldDbPath?: string;
}

/**
 * Read-only status of the gold DB. NEVER throws: a missing or locked DB returns
 * present:false with zeros rather than surfacing openGoldDb's fileMustExist
 * throw. File stats (size/mtime) are reported whenever the file exists, even if
 * the connection cannot be opened (e.g. locked); gameCount is null whenever the
 * `games` table cannot be read.
 */
export function getResearchGold(options: ResearchGoldOptions = {}): ResearchGoldPayload {
  const path = options.goldDbPath ?? GOLD_DB_PATH;

  // Absent file is the literal zeros case.
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { present: false, path, sizeBytes: 0, lastModified: "", gameCount: null };
  }

  const sizeBytes = stats.size;
  let lastModified = "";
  try {
    lastModified = stats.mtime.toISOString();
  } catch {
    lastModified = "";
  }

  // The file exists; try to open it read-only and count games. A locked/corrupt
  // DB leaves present:false with the real stats and gameCount:null.
  let present = false;
  let gameCount: number | null = null;
  let db;
  try {
    db = openGoldDb(path);
    present = true;
    try {
      const row: unknown = db.prepare("SELECT count(*) AS n FROM games").get();
      gameCount =
        typeof row === "object" && row !== null && "n" in row && typeof row.n === "number"
          ? row.n
          : null;
    } catch {
      gameCount = null;
    }
  } catch {
    present = false;
    gameCount = null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close failures on an already-broken handle.
    }
  }

  return { present, path, sizeBytes, lastModified, gameCount };
}

/* ------------------------------- artifacts -------------------------------- */

/**
 * Allow-listed artifact ids. Each id maps to a RELATIVE path under the output
 * root. Only ids in this list resolve; any other id (including any request
 * path) is rejected before touching the filesystem. The mapping is the single
 * authority for what bytes the API will serve.
 */
export const ARTIFACT_ID_ALLOWLIST: Readonly<Record<string, string>> = {
  "snapshot-latest-manifest": "snapshots/latest/manifest.json",
  models: "models.json",
};

export type ArtifactResolution =
  | { readonly ok: true; readonly path: string; readonly relativePath: string }
  | { readonly ok: false; readonly reason: "unknown_id" | "unsafe_path" | "not_found" };

/**
 * A safe single path segment: no separators, no traversal, no absolute marker.
 * Used for pull ids and as the inner guard for allow-listed relative paths.
 */
function isSafeSegment(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (value === "." || value === "..") return false;
  return true;
}

/**
 * Resolve an allow-listed artifact id to an absolute path strictly UNDER the
 * output root. Defense in depth:
 *  1. id must be in the allow-list (rejects arbitrary request paths),
 *  2. the mapped relative path must not be absolute and must not escape via
 *     `..` after normalization,
 *  3. the fully resolved path must remain inside the resolved root.
 * Never serves an arbitrary request-supplied path.
 */
export function resolveArtifact(
  id: string,
  options: ResearchServiceOptions = {},
): ArtifactResolution {
  const outputRoot = options.outputRoot ?? DEFAULT_RESEARCH_OUTPUT_ROOT;
  const relativePath = ARTIFACT_ID_ALLOWLIST[id];
  if (relativePath === undefined) {
    return { ok: false, reason: "unknown_id" };
  }
  if (isAbsolute(relativePath)) {
    return { ok: false, reason: "unsafe_path" };
  }
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || normalized.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "unsafe_path" };
  }
  const rootResolved = resolve(outputRoot);
  const candidate = resolve(rootResolved, normalized);
  const rel = relative(rootResolved, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: "unsafe_path" };
  }
  // Belt-and-suspenders prefix check.
  if (!candidate.startsWith(rootResolved + sep)) {
    return { ok: false, reason: "unsafe_path" };
  }
  if (!existsSync(candidate)) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, path: candidate, relativePath: normalized };
}
