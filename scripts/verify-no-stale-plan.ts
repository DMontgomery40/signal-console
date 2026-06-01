// Ripgreps the repo for forbidden plan-drift strings and exits non-zero on any
// hit outside the allow-listed docs. The allow-list lives here.
//
// Forbidden strings (and their regex form):
//   - nba-predict/data/signal-console.sqlite  (old gold-DB location)
//   - K = 6.0 only                            (false claim of K=6 being the only K)
//   - source_data_version                     (deprecated schema column)
//   - \bdata_version\b                        (deprecated schema column, standalone)
//   - shadow mode                             (forbidden migration pattern)
//   - old worker keeps writing                (forbidden migration pattern)
//
// Allow-list:
//   - docs/gold-db-relocation.md
//   - any file under docs/relocation/
//   - any line containing the literal "(historical, do not use)"
//
// Scope: respects .gitignore by default; additionally excludes scripts/ralph/**
// (owner-maintained ralph runtime state) and this file itself.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

interface ForbiddenPattern {
  readonly id: string;
  readonly regex: string;
  readonly display: string;
}

interface Hit {
  readonly pattern: ForbiddenPattern;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const FORBIDDEN: readonly ForbiddenPattern[] = [
  {
    id: "old-gold-db-path",
    regex: "nba-predict/data/signal-console\\.sqlite",
    display: "nba-predict/data/signal-console.sqlite",
  },
  {
    id: "k-equals-6-only",
    regex: "K = 6\\.0 only",
    display: "K = 6.0 only",
  },
  {
    id: "source-data-version",
    regex: "source_data_version",
    display: "source_data_version",
  },
  {
    id: "data-version-word",
    regex: "\\bdata_version\\b",
    display: "\\bdata_version\\b",
  },
  {
    id: "shadow-mode",
    regex: "shadow mode",
    display: "shadow mode",
  },
  {
    id: "old-worker-keeps-writing",
    regex: "old worker keeps writing",
    display: "old worker keeps writing",
  },
];

const ALLOW_LIST_PATHS: readonly string[] = ["docs/gold-db-relocation.md"];

const ALLOW_LIST_PREFIXES: readonly string[] = ["docs/relocation/"];

const HISTORICAL_MARKER = "(historical, do not use)";

const EXCLUDE_GLOBS: readonly string[] = [
  "!scripts/ralph/**",
  "!scripts/verify-no-stale-plan.ts",
  "!pnpm-lock.yaml",
  "!data/**",
];

function normalizeFile(rgFile: string): string {
  return rgFile.startsWith("./") ? rgFile.slice(2) : rgFile;
}

function isAllowListed(file: string, lineText: string): boolean {
  if (ALLOW_LIST_PATHS.includes(file)) {
    return true;
  }
  if (ALLOW_LIST_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true;
  }
  if (lineText.includes(HISTORICAL_MARKER)) {
    return true;
  }
  return false;
}

function parseRipgrepLine(line: string, pattern: ForbiddenPattern): Hit | null {
  const firstColon = line.indexOf(":");
  if (firstColon < 0) {
    return null;
  }
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon < 0) {
    return null;
  }
  const lineNumberRaw = line.slice(firstColon + 1, secondColon);
  const lineNumber = Number.parseInt(lineNumberRaw, 10);
  if (Number.isNaN(lineNumber)) {
    return null;
  }
  return {
    pattern,
    file: normalizeFile(line.slice(0, firstColon)),
    line: lineNumber,
    text: line.slice(secondColon + 1),
  };
}

function isNoMatchError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  if (!("status" in err)) {
    return false;
  }
  return err.status === 1;
}

function runRipgrepOnce(pattern: ForbiddenPattern, cwd: string): string {
  const args: string[] = [
    "--no-messages",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color=never",
  ];
  for (const glob of EXCLUDE_GLOBS) {
    args.push("--glob", glob);
  }
  args.push("--regexp", pattern.regex, ".");

  try {
    return execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err: unknown) {
    if (isNoMatchError(err)) {
      return "";
    }
    throw err;
  }
}

function runRipgrep(pattern: ForbiddenPattern, cwd: string): readonly Hit[] {
  const stdout = runRipgrepOnce(pattern, cwd);
  const hits: Hit[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length === 0) {
      continue;
    }
    const hit = parseRipgrepLine(rawLine, pattern);
    if (hit !== null) {
      hits.push(hit);
    }
  }
  return hits;
}

function describeAllowList(): string {
  const parts = [
    ...ALLOW_LIST_PATHS,
    ...ALLOW_LIST_PREFIXES.map((prefix) => `${prefix}**`),
    `lines containing "${HISTORICAL_MARKER}"`,
  ];
  return parts.join(", ");
}

function main(): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  const offending: Hit[] = [];
  for (const pattern of FORBIDDEN) {
    for (const hit of runRipgrep(pattern, repoRoot)) {
      if (!isAllowListed(hit.file, hit.text)) {
        offending.push(hit);
      }
    }
  }
  if (offending.length === 0) {
    process.stdout.write("verify:no-stale-plan OK (0 forbidden plan-drift hits)\n");
    return 0;
  }
  process.stderr.write(
    `verify:no-stale-plan FAILED: ${String(offending.length)} forbidden hit(s)\n`,
  );
  for (const hit of offending) {
    process.stderr.write(
      `  ${hit.file}:${String(hit.line)}  [${hit.pattern.id}: ${hit.pattern.display}]  ${hit.text.trim()}\n`,
    );
  }
  process.stderr.write(`Allow-listed locations: ${describeAllowList()}.\n`);
  return 1;
}

process.exit(main());
