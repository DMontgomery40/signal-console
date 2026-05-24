import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";

import { defaultApiPort, defaultWebPort } from "../../packages/shared/src/ports";

const repoRoot = new URL("../..", import.meta.url).pathname;
const pnpmBin = process.env["SIGNAL_CONSOLE_PNPM"] ?? "pnpm";
const logDir = "/tmp";
const STATUS_HEALTH_TIMEOUT_MS = 2_000;
const STATUS_HEALTH_HOST_ENV = "SIGNAL_CONSOLE_STATUS_HOST";

type CommandName = "dev" | "daemon" | "launch" | "verify" | "build" | "status" | "stop";

interface ChildSpec {
  readonly name: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

function resolvePort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return parsed;
}

function printUsage(): never {
  console.log(`Usage: ./run [dev|daemon|launch|verify|build|status|stop]

Commands:
  dev      Start API + web dev servers on the Signal Console high ports.
  daemon   Start API + web dev servers in the background.
  launch   Install, verify, build, then start API + web dev servers.
  verify   Run the repo verification gate.
  build    Run the repo build.
  status   Check the API directly and through the web proxy.
  stop     Stop listeners on the configured Signal Console dev ports.

Ports:
  API  SIGNAL_CONSOLE_API_PORT=${String(resolvePort("SIGNAL_CONSOLE_API_PORT", defaultApiPort))}
  Web  SIGNAL_CONSOLE_WEB_PORT=${String(resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort))}
`);
  process.exit(2);
}

function parseCommand(): CommandName {
  const raw = process.argv[2] ?? "dev";
  if (
    raw === "dev" ||
    raw === "daemon" ||
    raw === "launch" ||
    raw === "verify" ||
    raw === "build" ||
    raw === "status" ||
    raw === "stop"
  ) {
    return raw;
  }
  printUsage();
}

function devSpecs(apiHost: string, apiPort: number, webPort: number): readonly ChildSpec[] {
  const apiTarget = `http://${apiHost}:${String(apiPort)}`;
  return [
    {
      name: "api",
      cwd: `${repoRoot}/apps/api`,
      args: ["dev"],
      env: {
        SIGNAL_CONSOLE_API_HOST: apiHost,
        SIGNAL_CONSOLE_API_PORT: String(apiPort),
      },
    },
    {
      name: "web",
      cwd: `${repoRoot}/apps/web`,
      args: ["exec", "vite", "--host", "localhost", "--port", String(webPort), "--strictPort"],
      env: {
        SIGNAL_CONSOLE_API_TARGET: apiTarget,
        SIGNAL_CONSOLE_WEB_PORT: String(webPort),
      },
    },
  ];
}

function runForeground(args: readonly string[], cwd = repoRoot): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pnpmBin, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${pnpmBin} ${args.join(" ")} exited with ${signal ?? String(code)}`));
    });
  });
}

function spawnManaged(spec: ChildSpec): ChildProcess {
  const child = spawn(pnpmBin, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`[${spec.name}] failed to start: ${error.message}`);
  });

  return child;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
}

async function startDev(): Promise<void> {
  const apiPort = resolvePort("SIGNAL_CONSOLE_API_PORT", defaultApiPort);
  const webPort = resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort);
  const apiHost = process.env["SIGNAL_CONSOLE_API_HOST"] ?? "localhost";
  const apiTarget = `http://${apiHost}:${String(apiPort)}`;

  console.log(`Signal Console dev ports:
  API  ${apiTarget}
  Web  http://localhost:${String(webPort)}
`);

  const children = devSpecs(apiHost, apiPort, webPort).map((spec) => spawnManaged(spec));

  let stopping = false;
  function stopAll(): void {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      killChild(child);
    }
  }

  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  await new Promise<void>((resolvePromise, reject) => {
    for (const child of children) {
      child.on("exit", (code, signal) => {
        stopAll();
        if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
          resolvePromise();
          return;
        }
        reject(new Error(`dev server exited with ${signal ?? String(code)}`));
      });
    }
  });
}

function spawnDaemon(spec: ChildSpec): number {
  const logPath = `${logDir}/signal-console-${spec.name}.log`;
  const out = openSync(logPath, "a");
  try {
    const child = spawn(pnpmBin, spec.args, {
      cwd: spec.cwd,
      detached: true,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", out, out],
    });
    child.unref();
    writeFileSync(
      `${logDir}/signal-console-${spec.name}.pid`,
      `${String(child.pid ?? "")}\n`,
      "utf8",
    );
    console.log(`${spec.name} pid ${String(child.pid ?? "?")} log ${logPath}`);
    return child.pid ?? 0;
  } finally {
    closeSync(out);
  }
}

function startDaemon(): void {
  const apiPort = resolvePort("SIGNAL_CONSOLE_API_PORT", defaultApiPort);
  const webPort = resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort);
  const apiHost = process.env["SIGNAL_CONSOLE_API_HOST"] ?? "localhost";

  for (const spec of devSpecs(apiHost, apiPort, webPort)) {
    spawnDaemon(spec);
  }

  console.log(`Signal Console daemon ports:
  API  http://${apiHost}:${String(apiPort)}
  Web  http://localhost:${String(webPort)}
`);
}

async function status(): Promise<void> {
  const apiPort = resolvePort("SIGNAL_CONSOLE_API_PORT", defaultApiPort);
  const webPort = resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort);
  const statusHost = process.env[STATUS_HEALTH_HOST_ENV] ?? "localhost";
  const apiUrl = `http://${statusHost}:${String(apiPort)}/v1/health/live`;
  const proxyUrl = `http://${statusHost}:${String(webPort)}/v1/health/live`;
  let failures = 0;

  for (const url of [apiUrl, proxyUrl]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(STATUS_HEALTH_TIMEOUT_MS) });
      const body = await response.text();
      console.log(`${response.ok ? "OK" : "FAIL"} ${url} ${String(response.status)} ${body}`);
      if (!response.ok) {
        failures += 1;
      }
    } catch (error: unknown) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${url} error ${message}`);
    }
  }

  if (failures > 0) {
    throw new Error(`status failed for ${String(failures)} endpoint(s)`);
  }
}

async function stop(): Promise<void> {
  const ports = [
    resolvePort("SIGNAL_CONSOLE_API_PORT", defaultApiPort),
    resolvePort("SIGNAL_CONSOLE_WEB_PORT", defaultWebPort),
  ];

  for (const port of ports) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("exit", () => {
        const pids = stdout
          .split(/\s+/)
          .map((pid) => pid.trim())
          .filter((pid) => pid.length > 0);
        for (const pid of pids) {
          process.kill(Number(pid), "SIGTERM");
          console.log(`stopped port ${String(port)} pid ${pid}`);
        }
        resolvePromise();
      });
    });
  }
}

async function main(): Promise<void> {
  const command = parseCommand();

  switch (command) {
    case "dev":
      await startDev();
      break;
    case "daemon":
      startDaemon();
      break;
    case "launch":
      await runForeground(["install", "--frozen-lockfile"]);
      await runForeground(["verify"]);
      await runForeground(["build"]);
      await startDev();
      break;
    case "verify":
      await runForeground(["verify"]);
      break;
    case "build":
      await runForeground(["build"]);
      break;
    case "status":
      await status();
      break;
    case "stop":
      await stop();
      break;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
