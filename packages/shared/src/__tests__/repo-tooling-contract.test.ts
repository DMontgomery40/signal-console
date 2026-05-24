import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();
const prettierBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prettier.cmd" : "prettier",
);
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

describe("repo tooling contract", () => {
  it("ignores GitNexus local cache files during prettier checks", () => {
    const probePath = join(repoRoot, ".gitnexus", "__prettier-contract__.json");

    mkdirSync(join(repoRoot, ".gitnexus"), { recursive: true });
    writeFileSync(probePath, '{"z":1,"a":2}');

    try {
      expect(() =>
        execFileSync(
          prettierBin,
          ["--check", ".gitnexus/__prettier-contract__.json", "--ignore-unknown"],
          { cwd: repoRoot, stdio: "pipe" },
        ),
      ).not.toThrow();
    } finally {
      rmSync(probePath, { force: true });
    }
  });

  it("prints a cache-clear command that matches the migrated cache schema", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "restore-gold-db-from-recover.sh"),
      "utf8",
    );

    expect(script).toContain("DELETE FROM detector_runs");
    expect(script).not.toContain("detector_cache_runs");
    expect(script).not.toContain("detector_cache_observations");
    expect(script).not.toContain("detector_cache_fires");
  });

  it("includes Python workspaces in the standard workspace verify sweep", () => {
    const output = execFileSync(tsxBin, ["scripts/run-workspace-script.ts", "--list", "verify"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(output).toContain("> @signal-console/api: verify");
    expect(output).toContain("> nba-sidecar: verify");
  });

  it("fails when the requested workspace script is not declared anywhere", () => {
    expect(() =>
      execFileSync(tsxBin, ["scripts/run-workspace-script.ts", "--list", "__missing_script__"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/no workspace declares script '__missing_script__'/);
  });

  it("runs query-plan verification from the umbrella verify command", () => {
    const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");

    expect(packageJson).toContain("tsx scripts/verify-queries.ts");
  });

  it("treats SQLite 'SCAN TABLE <name>' plan rows as full scans", async () => {
    const { offendingScans } = await import("../../../../scripts/verify-queries");

    expect(offendingScans([{ id: 1, parent: 0, detail: "SCAN TABLE quote_ticks" }], {})).toEqual([
      `full SCAN of 'quote_ticks' — plan row: "SCAN TABLE quote_ticks"`,
    ]);
    expect(
      offendingScans(
        [{ id: 1, parent: 0, detail: "SCAN TABLE quote_ticks USING INDEX idx_qt" }],
        {},
      ),
    ).toEqual([]);
  });
});
