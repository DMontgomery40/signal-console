// Guard: every in-repo path cited in backticks inside explainer/doc copy must
// resolve to a real file. Closes audit F-011, where six `formal` explainer cards
// cited `scripts/board_signal_v2.py` (an external nba-predict path that does not
// exist in this repo) as the canonical source — a dangling citation that surfaces
// no error but sends a reader to a nonexistent file.
//
// Scope: backtick-quoted tokens that look like in-repo source paths
// (packages/… , apps/… , scripts/… , docs/… with a file extension and a slash).
// External provenance is allowed when explicitly prefixed (e.g. `nba-predict/…`):
// such tokens don't match the in-repo prefixes below, so they pass.
//
// Run in CI via `pnpm verify`. Exit 1 on a citation that doesn't resolve.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const SCANNED = ["packages/ui/src/explainers.ts", "docs/design-language.md"];

// `path/like/this.ext`, optionally with a :line suffix, rooted at a known in-repo
// top-level dir so prose like `kMad` or `K_MAD_CALM` is ignored.
const CITATION = /`((?:packages|apps|scripts|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z]+)(?::\d+)?`/g;

let violations = 0;
for (const rel of SCANNED) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(CITATION)) {
      const cited = match[1];
      if (cited === undefined) continue;
      if (!existsSync(resolve(ROOT, cited))) {
        console.error(`${rel}:${i + 1}: cited path does not resolve: ${cited}`);
        violations += 1;
      }
    }
  });
}

if (violations > 0) {
  console.error(
    `\n${violations} dangling citation(s). Repoint to a real in-repo file, or mark external provenance explicitly (e.g. \`nba-predict/...\`).`,
  );
  process.exit(1);
}
console.log("ok: all cited in-repo paths resolve");
