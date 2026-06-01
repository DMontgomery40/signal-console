import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PRODUCT_PURPOSE_BLOCK, verifyProductPurpose } from "./verify-product-purpose";

const REQUIRED_RELATIVE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".codex/memory.md",
  "scripts/ralph/CLAUDE.md",
] as const;

function writeFile(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function writeRepoContract(root: string, projectMemoryPath: string): void {
  for (const relativePath of REQUIRED_RELATIVE_PATHS) {
    writeFile(join(root, relativePath), `${PRODUCT_PURPOSE_BLOCK}rest of ${relativePath}\n`);
  }
  writeFile(projectMemoryPath, `${PRODUCT_PURPOSE_BLOCK}project memory index\n`);
}

void test("product-purpose contract passes when agent docs and project memory start with the core purpose", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-console-purpose-pass-"));
  const projectMemoryPath = join(root, "project-memory", "MEMORY.md");
  writeRepoContract(root, projectMemoryPath);

  const result = verifyProductPurpose({ projectMemoryPath, root });

  assert.deepEqual(result.violations, []);
  assert.equal(result.checkedFiles.length, 5);
});

void test("product-purpose contract fails when an agent doc has any content before the core purpose", () => {
  const root = mkdtempSync(join(tmpdir(), "signal-console-purpose-fail-"));
  const projectMemoryPath = join(root, "project-memory", "MEMORY.md");
  writeRepoContract(root, projectMemoryPath);
  writeFile(join(root, "AGENTS.md"), `# Wrong Header\n\n${PRODUCT_PURPOSE_BLOCK}`);

  const result = verifyProductPurpose({ projectMemoryPath, root });

  assert.deepEqual(result.violations, ["AGENTS.md: must start with Signal Console Core Purpose"]);
});
