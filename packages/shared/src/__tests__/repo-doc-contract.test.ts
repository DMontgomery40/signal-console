import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();
const archiveRoot = join(repoRoot, ".docs-archive", "2026-05-repo-audit");
const reportPath = join(repoRoot, "outputs/innovation-team-suspend-signal-report/REPORT.md");
const renderedReportPath = join(
  repoRoot,
  "outputs/innovation-team-suspend-signal-report/report.html",
);

const archivedRootDocs = [
  "MARKET_INCIDENT_HANDOFF_PROMPT.md",
  "NEXT_AGENT_HANDOFF_PROMPT.md",
  "SUSPEND_SIGNAL_HANDOFF_PROMPT.md",
  "TODO.md",
  "bet365_nba_signal_console_proposal.md",
];

describe("repo documentation contract", () => {
  it.skipIf(!existsSync(archiveRoot))(
    "keeps stale root prompt docs archived instead of duplicated at repo root",
    () => {
      for (const relativePath of archivedRootDocs) {
        expect(existsSync(join(repoRoot, relativePath))).toBe(false);
        expect(existsSync(join(archiveRoot, relativePath))).toBe(true);
      }
    },
  );

  it.skipIf(!existsSync(reportPath) || !existsSync(renderedReportPath))(
    "keeps rendered report docs free of stale handoff references",
    () => {
      const report = readFileSync(reportPath, "utf8");
      expect(report).not.toContain("docs/market-incident-report-format.md");
      expect(report).not.toContain("`MARKET_INCIDENT_HANDOFF_PROMPT.md`");
      expect(report).not.toContain("project memory");

      const renderedReport = readFileSync(renderedReportPath, "utf8");
      expect(renderedReport).not.toContain("MARKET_INCIDENT_HANDOFF_PROMPT.md");
      expect(renderedReport).not.toContain("TODO.md:91-111");
      expect(renderedReport).not.toContain("project memory");
    },
  );

  it("does not duplicate stale root prompt docs at repo root", () => {
    for (const relativePath of archivedRootDocs) {
      expect(existsSync(join(repoRoot, relativePath))).toBe(false);
    }
  });
});
