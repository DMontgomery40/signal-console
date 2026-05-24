import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
}

interface PyprojectToml {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
}

interface WorkspaceScript {
  readonly dir: string;
  readonly kind: "node" | "python";
  readonly label: string;
  readonly command?: string;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const listOnly = args[0] === "--list";
const scriptName = listOnly ? args[1] : args[0];

if (scriptName === undefined || scriptName.length === 0) {
  throw new Error("usage: tsx scripts/run-workspace-script.ts [--list] <script-name>");
}
const requestedScriptName: string = scriptName;

function readPackageJson(path: string): PackageJson {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) return {};

  const name = typeof raw["name"] === "string" ? raw["name"] : undefined;
  const scriptsRaw = raw["scripts"];
  const scripts = isRecord(scriptsRaw)
    ? Object.fromEntries(
        Object.entries(scriptsRaw).filter((entry): entry is [string, string] => {
          const [, value] = entry;
          return typeof value === "string";
        }),
      )
    : undefined;

  return {
    ...(name !== undefined ? { name } : {}),
    ...(scripts !== undefined ? { scripts } : {}),
  };
}

function readPyprojectToml(path: string): PyprojectToml {
  const raw = readFileSync(path, "utf8");
  const project = parseTomlStringSection(raw, "project");
  const scripts = parseTomlStringSection(raw, "tool.signal-console.scripts");
  const name = project["name"];

  return {
    ...(name !== undefined ? { name } : {}),
    ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTomlStringSection(raw: string, sectionName: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  let active = false;

  for (const rawLine of raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    const section = sectionMatch?.[1];
    if (section !== undefined) {
      active = section === sectionName;
      continue;
    }

    if (!active) continue;

    const entryMatch = /^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/u.exec(
      line,
    );
    const key = entryMatch?.[1];
    const literal = entryMatch?.[2];
    if (key === undefined || literal === undefined) continue;

    entries.push([key, parseTomlStringLiteral(literal)]);
  }

  return Object.fromEntries(entries);
}

function parseTomlStringLiteral(literal: string): string {
  if (literal.startsWith("'")) {
    return literal.slice(1, -1);
  }

  const parsed: unknown = JSON.parse(literal);
  if (typeof parsed !== "string") {
    throw new Error(`expected TOML string literal, got ${literal}`);
  }
  return parsed;
}

function workspaceDirs(): readonly string[] {
  return ["apps", "packages"].flatMap((parent) => {
    const parentPath = join(repoRoot, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parentPath, entry.name))
      .toSorted();
  });
}

function workspaceScripts(name: string): readonly WorkspaceScript[] {
  return workspaceDirs().flatMap((dir) => {
    const scripts: WorkspaceScript[] = [];
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      const pkg = readPackageJson(packageJsonPath);
      if (pkg.scripts?.[name] !== undefined) {
        scripts.push({
          dir,
          kind: "node",
          label: pkg.name ?? dir,
        });
      }
    }

    const pyprojectPath = join(dir, "pyproject.toml");
    if (existsSync(pyprojectPath)) {
      const project = readPyprojectToml(pyprojectPath);
      const command = project.scripts?.[name];
      if (command !== undefined) {
        scripts.push({
          command,
          dir,
          kind: "python",
          label: project.name ?? dir,
        });
      }
    }

    return scripts;
  });
}

function pythonVenvPython(dir: string): string {
  return process.platform === "win32"
    ? join(dir, ".venv", "Scripts", "python.exe")
    : join(dir, ".venv", "bin", "python");
}

function pythonVenvBin(dir: string): string {
  return process.platform === "win32" ? join(dir, ".venv", "Scripts") : join(dir, ".venv", "bin");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function pythonBootstrapCandidates(): readonly string[] {
  return unique([
    process.env["PYTHON_BIN"] ?? "",
    process.env["PYTHON"] ?? "",
    "python3.12",
    "python3",
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
  ]);
}

function isPython312(candidate: string): boolean {
  const result = spawnSync(
    candidate,
    ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

function findPythonBootstrap(): string {
  const candidate = pythonBootstrapCandidates().find(isPython312);
  if (candidate === undefined) {
    throw new Error(
      "Python workspace scripts require Python >= 3.12. Set PYTHON_BIN to a compatible interpreter.",
    );
  }
  return candidate;
}

function ensurePythonVenv(dir: string): string {
  const pythonPath = pythonVenvPython(dir);
  if (existsSync(pythonPath)) {
    if (!isPython312(pythonPath)) {
      throw new Error(`Python workspace virtualenv at ${dir}/.venv must use Python >= 3.12.`);
    }
    ensurePythonPip(pythonPath);
    return pythonPath;
  }

  const bootstrap = findPythonBootstrap();
  const result = spawnSync(bootstrap, ["-m", "venv", ".venv"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`failed to create Python virtualenv in ${dir}`);
  }

  ensurePythonPip(pythonPath);
  return pythonPath;
}

function ensurePythonPip(pythonPath: string): void {
  const probe = spawnSync(pythonPath, ["-m", "pip", "--version"], { stdio: "ignore" });
  if (probe.status === 0) return;

  const result = spawnSync(pythonPath, ["-m", "ensurepip", "--upgrade"], {
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`failed to bootstrap pip for ${pythonPath}`);
  }
}

function runWorkspaceScript(workspaceScript: WorkspaceScript): number {
  if (workspaceScript.kind === "node") {
    const result = spawnSync(
      "corepack",
      ["pnpm", "--dir", workspaceScript.dir, "run", requestedScriptName],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    if (result.error !== undefined) throw result.error;
    return result.status ?? 1;
  }

  const pythonPath = ensurePythonVenv(workspaceScript.dir);
  const result = spawnSync(workspaceScript.command ?? "", {
    cwd: workspaceScript.dir,
    env: {
      ...process.env,
      PATH: `${pythonVenvBin(workspaceScript.dir)}${delimiter}${process.env["PATH"] ?? ""}`,
      PYTHON: pythonPath,
    },
    shell: true,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

const matchingWorkspaceScripts = workspaceScripts(requestedScriptName);
if (matchingWorkspaceScripts.length === 0) {
  throw new Error(`no workspace declares script '${requestedScriptName}'`);
}

for (const workspaceScript of matchingWorkspaceScripts) {
  console.log(`\n> ${workspaceScript.label}: ${requestedScriptName}`);
  if (listOnly) continue;

  const status = runWorkspaceScript(workspaceScript);
  if (status !== 0) process.exit(status);
}
