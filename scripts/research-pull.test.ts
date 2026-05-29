import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runResearchPull } from "./research-pull";

// Behavioral contract for the thin quant:pull CLI over @signal-console/research-pull:
//   - dry-run produces a VALID plan for snapshot-eligible sources and writes NOTHING;
//   - dry-run on an unknown source returns the coded validation errors, still no write;
//   - the real enqueue path writes exactly one `queued` job.json and nothing else.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void test("dry-run for kalshi,polymarket: valid plan, NO writes", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "quant-pull-dry-"));
  try {
    const result = runResearchPull([
      "--dry-run",
      "--sources",
      "kalshi,polymarket",
      "--output-root",
      outputRoot,
    ]);

    assert.equal(result.mode, "dry-run");
    assert.equal(result.code, 0);
    assert.equal(result.plan.ok, true);
    assert.deepEqual([...result.plan.resolvedSources], ["kalshi", "polymarket"]);
    // Snapshot-eligible sources resolve to canonical snapshot-to-gold operations.
    for (const source of result.plan.sources) {
      assert.equal(source.artifactClass, "canonical");
      assert.ok(source.operations.some((op) => op.kind === "snapshot-to-gold"));
    }
    // The defining safety property: NO write and NO enqueued artifact.
    assert.equal(result.enqueuedPath, undefined);
    assert.deepEqual(readdirSync(outputRoot), []);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

void test("dry-run with an unknown source: coded errors, NO writes", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "quant-pull-dry-bad-"));
  try {
    const result = runResearchPull([
      "--dry-run",
      "--sources",
      "not-a-real-source",
      "--output-root",
      outputRoot,
    ]);

    assert.equal(result.mode, "dry-run");
    assert.equal(result.code, 1);
    assert.equal(result.plan.ok, false);
    assert.ok(result.plan.errors.some((e) => e.code === "unknown_source"));
    assert.deepEqual(readdirSync(outputRoot), []);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

void test("enqueue path: writes exactly one queued job.json", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "quant-pull-enq-"));
  try {
    const result = runResearchPull(["--sources", "kalshi,polymarket", "--output-root", outputRoot]);

    assert.equal(result.mode, "enqueue");
    assert.equal(result.code, 0);

    const enqueuedPath = result.enqueuedPath;
    assert.ok(enqueuedPath !== undefined, "enqueue path should write a job.json");
    assert.ok(existsSync(enqueuedPath));

    const jobDirs = readdirSync(outputRoot);
    assert.equal(jobDirs.length, 1);

    const parsed: unknown = JSON.parse(readFileSync(enqueuedPath, "utf8"));
    assert.ok(isRecord(parsed));
    assert.equal(parsed["state"], "queued");
    assert.deepEqual(parsed["resolvedSources"], ["kalshi", "polymarket"]);
    assert.ok(isRecord(parsed["request"]));
    assert.equal(parsed["request"]["capture_mode"], "historical");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
