import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRuntimeEnv, resetRuntimeEnvForTests } from "../env";

let tempDir = "";

describe("runtime env loading", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-env-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RUNTIME_ENV_SHARED_ONLY;
    delete process.env.RUNTIME_ENV_LOCAL_ONLY;
    delete process.env.RUNTIME_ENV_LOCAL_OVERRIDE;
    resetRuntimeEnvForTests();

    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("loads repo env files without clobbering explicit shell values", () => {
    const envLocalPath = join(tempDir, ".env.local");
    const envPath = join(tempDir, ".env");

    writeFileSync(
      envLocalPath,
      ["RUNTIME_ENV_LOCAL_ONLY=from-local", "RUNTIME_ENV_LOCAL_OVERRIDE=local"]
        .join("\n")
        .concat("\n")
    );
    writeFileSync(
      envPath,
      ["RUNTIME_ENV_SHARED_ONLY=from-env", "RUNTIME_ENV_LOCAL_OVERRIDE=env"]
        .join("\n")
        .concat("\n")
    );

    process.env.RUNTIME_ENV_LOCAL_OVERRIDE = "shell";

    const summary = loadRuntimeEnv({
      envFiles: [envLocalPath, envPath],
    });

    expect(summary.loadedFiles).toHaveLength(2);
    expect(process.env.RUNTIME_ENV_SHARED_ONLY).toBe("from-env");
    expect(process.env.RUNTIME_ENV_LOCAL_ONLY).toBe("from-local");
    expect(process.env.RUNTIME_ENV_LOCAL_OVERRIDE).toBe("shell");
  });
});
