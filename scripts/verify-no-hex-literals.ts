// Ripgreps `packages/` and `apps/` for hex color literals (#abc, #aabbcc,
// #aabbccdd) and exits non-zero on any hit outside the allow-listed paths.
// The design-language contract (docs/design-language.md §"Color tokens") says
// all hex values live in packages/ui/src/tokens.ts; the Tailwind preset and
// global.css mirror them by name; everything else must consume the tokens.
//
// Allow-list:
//   - filename matches tokens.ts | global.css | tailwind-preset.cjs
//     (the canonical sources of token values; see US-043 ACs)
//   - filename matches design-language.md | PRD.md (token spec docs that may
//     live anywhere in the tree, including under packages/ or apps/ if ever
//     moved; allow-listed defensively)
//   - filename ends in .snap (vitest snapshot files that record token output)
//   - filename ends in .d.cts | .d.ts (type-only files that may reference
//     hex strings in JSDoc / comments without affecting runtime UI)
//
// Scope: `packages/` and `apps/` only, per the US-043 acceptance grep.
// `docs/`, `scripts/`, and the repo root are NOT scanned.

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import process from "node:process";

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const HEX_REGEX = "#[0-9a-fA-F]{3,8}\\b";

const ALLOWED_BASENAMES: readonly string[] = [
  "tokens.ts",
  "global.css",
  "tailwind-preset.cjs",
  "tailwind-preset.d.cts",
  "design-language.md",
  "PRD.md",
];

const ALLOWED_SUFFIXES: readonly string[] = [".snap"];

const SEARCH_ROOTS: readonly string[] = ["packages", "apps"];

function normalizeFile(rgFile: string): string {
  return rgFile.startsWith("./") ? rgFile.slice(2) : rgFile;
}

function isAllowListed(file: string): boolean {
  const name = basename(file);
  if (ALLOWED_BASENAMES.includes(name)) {
    return true;
  }
  if (ALLOWED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return false;
}

function parseRipgrepLine(rawLine: string): Hit | null {
  const firstColon = rawLine.indexOf(":");
  if (firstColon < 0) {
    return null;
  }
  const secondColon = rawLine.indexOf(":", firstColon + 1);
  if (secondColon < 0) {
    return null;
  }
  const lineNumberRaw = rawLine.slice(firstColon + 1, secondColon);
  const lineNumber = Number.parseInt(lineNumberRaw, 10);
  if (Number.isNaN(lineNumber)) {
    return null;
  }
  return {
    file: normalizeFile(rawLine.slice(0, firstColon)),
    line: lineNumber,
    text: rawLine.slice(secondColon + 1),
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

function runRipgrep(root: string, cwd: string): readonly Hit[] {
  const args: string[] = [
    "--no-messages",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color=never",
    "--regexp",
    HEX_REGEX,
    root,
  ];
  let stdout: string;
  try {
    stdout = execFileSync("rg", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err: unknown) {
    if (isNoMatchError(err)) {
      return [];
    }
    throw err;
  }
  const hits: Hit[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (rawLine.length === 0) {
      continue;
    }
    const hit = parseRipgrepLine(rawLine);
    if (hit !== null) {
      hits.push(hit);
    }
  }
  return hits;
}

function describeAllowList(): string {
  return [...ALLOWED_BASENAMES, ...ALLOWED_SUFFIXES].join(", ");
}

function main(): number {
  const repoRoot = resolve(import.meta.dirname, "..");
  const offending: Hit[] = [];
  for (const root of SEARCH_ROOTS) {
    for (const hit of runRipgrep(root, repoRoot)) {
      if (!isAllowListed(hit.file)) {
        offending.push(hit);
      }
    }
  }
  if (offending.length === 0) {
    process.stdout.write(
      `verify:no-hex-literals OK (0 hex literals outside ${describeAllowList()})\n`,
    );
    return 0;
  }
  process.stderr.write(
    `verify:no-hex-literals FAILED: ${String(offending.length)} hex literal(s) outside the allow-list\n`,
  );
  for (const hit of offending) {
    process.stderr.write(`  ${hit.file}:${String(hit.line)}  ${hit.text.trim()}\n`);
  }
  process.stderr.write(`Allow-listed: ${describeAllowList()}\n`);
  process.stderr.write(
    "All hex literals must live in tokens.ts; everything else consumes them via the Tailwind preset or CSS vars (see docs/design-language.md).\n",
  );
  return 1;
}

process.exit(main());
