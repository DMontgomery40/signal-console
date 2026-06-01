import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeEnvFiles = [resolve(repoRoot, ".env.local"), resolve(repoRoot, ".env")];

let runtimeEnvLoaded = false;
let lastLoadSummary: {
  loadedFiles: string[];
  repoRoot: string;
} | null = null;

export function getRepoRoot() {
  return repoRoot;
}

export function resetRuntimeEnvForTests() {
  runtimeEnvLoaded = false;
  lastLoadSummary = null;
}

// Canonical Odds-API.io credential lookup (audit F-012). ONE ordered name list,
// matching the documented order in CLAUDE.md/AGENTS.md:
//   ODDSAPI_API_KEY (preferred) → ODDS_API_KEY → ODDS_API_IO_KEY
// Every server-side reader (the odds-api + bet365-historical adapters, the worker
// enable-gate, and live-repository's source-readiness reporting) MUST resolve the
// key through here so the gate and the auth can never disagree on which names
// count. Before this, four sites hand-rolled `ODDS_API_KEY ?? ODDS_API_IO_KEY` and
// silently ignored the documented-preferred `ODDSAPI_API_KEY` — setting only that
// key disabled the provider with no error.
export const ODDS_API_KEY_ENV_NAMES = [
  "ODDSAPI_API_KEY",
  "ODDS_API_KEY",
  "ODDS_API_IO_KEY",
] as const;

export function resolveOddsApiKey(
  env: NodeJS.ProcessEnv = process.env,
  options?: { explicitKey?: string | null },
): string | null {
  if (options?.explicitKey != null && options.explicitKey !== "") {
    return options.explicitKey;
  }
  for (const name of ODDS_API_KEY_ENV_NAMES) {
    const value = env[name];
    if (value != null && value !== "") return value;
  }
  return null;
}

export function loadRuntimeEnv(options?: { envFiles?: string[] }) {
  if (runtimeEnvLoaded && lastLoadSummary) {
    return lastLoadSummary;
  }

  const loadedFiles: string[] = [];
  const envFiles = options?.envFiles ?? runtimeEnvFiles;

  // Load .env.local first because process.loadEnvFile does not overwrite keys
  // that are already present in the environment.
  for (const envPath of envFiles) {
    if (!existsSync(envPath)) {
      continue;
    }

    process.loadEnvFile(envPath);
    loadedFiles.push(envPath);
  }

  runtimeEnvLoaded = true;
  lastLoadSummary = {
    loadedFiles,
    repoRoot,
  };

  return lastLoadSummary;
}
