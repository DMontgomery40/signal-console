// `quant` umbrella: forward args to the python research CLI
// (`python -m nba_sidecar.research <subcommand> ...`).
//
// Subcommands: list-models, run-model, score-predictions, compare, report,
// doctor, bootstrap. This wrapper resolves the nba-sidecar research virtualenv
// python and execs the module with every trailing arg forwarded verbatim, so
// `pnpm quant list-models` == `python -m nba_sidecar.research list-models`.
//
// It mirrors the existing `tsx scripts/*.ts` convention (rather than the
// pyproject [tool.signal-console.scripts] runner, which forwards no args).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecarDir = join(repoRoot, "apps", "nba-sidecar");

function venvPython(): string {
  return process.platform === "win32"
    ? join(sidecarDir, ".venv", "Scripts", "python.exe")
    : join(sidecarDir, ".venv", "bin", "python");
}

const pythonPath = venvPython();
if (!existsSync(pythonPath)) {
  console.error(
    `error: nba-sidecar research virtualenv not found at ${pythonPath}\n` +
      `create it and install research deps with:\n` +
      `  cd apps/nba-sidecar && uv sync --extra research\n` +
      `(or: python3.12 -m venv .venv && .venv/bin/python -m pip install -e '.[research,dev]')`,
  );
  process.exit(1);
}

const forwarded = process.argv.slice(2);
// Run from the REPO ROOT so relative snapshot / predictions / runs-root paths
// resolve the way an operator (and the R starter's printed `pnpm quant
// score-predictions <snapshot>` hint) expects. The package is venv-installed,
// so `python -m nba_sidecar.research` imports cwd-independently.
const result = spawnSync(pythonPath, ["-m", "nba_sidecar.research", ...forwarded], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error !== undefined) {
  throw result.error;
}
process.exit(result.status ?? 1);
