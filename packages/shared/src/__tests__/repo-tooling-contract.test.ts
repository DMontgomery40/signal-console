import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();
const execFileAsync = promisify(execFile);
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

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("repo tooling contract", () => {
  it("installs dependencies before every ./run command enters the TypeScript runner", () => {
    const commands = ["dev", "daemon", "launch", "verify", "build", "status", "stop"];
    for (const command of commands) {
      const tmp = mkdtempSync(join(tmpdir(), "signal-console-run-contract-"));
      const fakeBinDir = join(tmp, "bin");
      const fakePnpmPath = join(fakeBinDir, "pnpm");
      const runPath = join(tmp, "run");
      const logPath = join(tmp, "pnpm.log");

      mkdirSync(fakeBinDir, { recursive: true });
      writeFileSync(runPath, readFileSync(join(repoRoot, "run"), "utf8"));
      chmodSync(runPath, 0o755);
      writeFileSync(fakePnpmPath, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PNPM_LOG"\n');
      chmodSync(fakePnpmPath, 0o755);

      try {
        execFileSync(runPath, [command], {
          cwd: tmp,
          env: {
            ...process.env,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
            PNPM_LOG: logPath,
          },
          stdio: "pipe",
        });

        expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
          "install --frozen-lockfile",
          `exec tsx scripts/dev/run.ts ${command}`,
        ]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("exits non-zero when any ./run status health endpoint is unhealthy", async () => {
    const okServer = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('{"ok":true}');
    });
    const unhealthyServer = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('{"ok":false}');
    });
    const apiPort = await listenOnEphemeralPort(okServer);
    const webPort = await listenOnEphemeralPort(unhealthyServer);

    try {
      let thrown: unknown;
      try {
        await execFileAsync(tsxBin, ["scripts/dev/run.ts", "status"], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            SIGNAL_CONSOLE_API_PORT: String(apiPort),
            SIGNAL_CONSOLE_STATUS_HOST: "127.0.0.1",
            SIGNAL_CONSOLE_WEB_PORT: String(webPort),
          },
          stdio: "pipe",
        });
      } catch (error: unknown) {
        thrown = error;
      }

      const result = thrown as
        | {
            readonly status?: number;
            readonly stdout?: string;
            readonly stderr?: string;
          }
        | undefined;
      expect(result?.status).not.toBe(0);
      expect(result?.stdout).toContain(`OK http://127.0.0.1:${String(apiPort)}/v1/health/live 200`);
      expect(result?.stdout).toContain(
        `FAIL http://127.0.0.1:${String(webPort)}/v1/health/live 503`,
      );
      expect(result?.stderr).toContain("status failed for 1 endpoint(s)");
    } finally {
      await Promise.all([closeServer(okServer), closeServer(unhealthyServer)]);
    }
  });

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
