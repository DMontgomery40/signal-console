import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();

describe("repo tooling contract", () => {
  it("ignores GitNexus local cache files during prettier checks", () => {
    const probePath = join(repoRoot, ".gitnexus", "__prettier-contract__.json");

    mkdirSync(join(repoRoot, ".gitnexus"), { recursive: true });
    writeFileSync(probePath, '{"z":1,"a":2}');

    try {
      expect(() =>
        execFileSync(
          "pnpm",
          [
            "exec",
            "prettier",
            "--check",
            ".gitnexus/__prettier-contract__.json",
            "--ignore-unknown",
          ],
          { cwd: repoRoot, stdio: "pipe" }
        )
      ).not.toThrow();
    } finally {
      rmSync(probePath, { force: true });
    }
  });
});
