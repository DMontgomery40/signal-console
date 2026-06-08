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

// Odds-API.io credential lookup order is documented in AGENTS.md/CLAUDE.md:
// ODDSAPI_API_KEY (preferred), then ODDS_API_KEY, then ODDS_API_IO_KEY. This is
// the single source of truth so a user who sets only the preferred name is not a
// silent provider no-op (audit F-012).
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
