import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeEnvFiles = [
  resolve(repoRoot, ".env.local"),
  resolve(repoRoot, ".env"),
];

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
