import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();
const archiveRoot = join(repoRoot, ".docs-archive", "2026-05-repo-audit");

const archivedRootDocs = [
  "MARKET_INCIDENT_HANDOFF_PROMPT.md",
  "NEXT_AGENT_HANDOFF_PROMPT.md",
  "SUSPEND_SIGNAL_HANDOFF_PROMPT.md",
  "TODO.md",
  "bet365_nba_signal_console_proposal.md",
];

describe("repo documentation contract", () => {
  it("keeps stale root prompt docs archived instead of duplicated at repo root", () => {
    for (const relativePath of archivedRootDocs) {
      expect(existsSync(join(repoRoot, relativePath))).toBe(false);
      expect(existsSync(join(archiveRoot, relativePath))).toBe(true);
    }
  });

  it("keeps active docs aligned with runtime source-of-truth and safe commands", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("nba_play_by_play_actions");
    expect(agents).toContain("market_microstructure_events");

    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("pnpm backfill --help");
    expect(readme).not.toMatch(/(?:^|\n)pnpm backfill(?:\r?\n|$)/);

    const report = readFileSync(
      join(repoRoot, "outputs/innovation-team-suspend-signal-report/REPORT.md"),
      "utf8"
    );
    expect(report).not.toContain("docs/market-incident-report-format.md");
    expect(report).not.toContain("`MARKET_INCIDENT_HANDOFF_PROMPT.md`");
    expect(report).not.toContain("project memory");

    const renderedReport = readFileSync(
      join(
        repoRoot,
        "outputs/innovation-team-suspend-signal-report/report.html"
      ),
      "utf8"
    );
    expect(renderedReport).not.toContain("MARKET_INCIDENT_HANDOFF_PROMPT.md");
    expect(renderedReport).not.toContain("TODO.md:91-111");
    expect(renderedReport).not.toContain("project memory");
  });
});
