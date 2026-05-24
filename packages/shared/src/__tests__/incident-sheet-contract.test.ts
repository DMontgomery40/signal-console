import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getRepoRoot } from "../env";

const repoRoot = getRepoRoot();
const researchDir = join(
  repoRoot,
  "outputs",
  "innovation-team-suspend-signal-report",
  "research"
);

function loadJson(relativePath: string) {
  return JSON.parse(readFileSync(join(researchDir, relativePath), "utf8")) as {
    summary: Record<string, unknown>;
    incidents?: Array<Record<string, unknown>>;
    rows?: Array<Record<string, unknown>>;
    fixtures?: Array<Record<string, unknown>>;
  };
}

describe("incident sheet contract", () => {
  it("keeps the permanent registry, sheet, and fixture in sync", () => {
    const registry = loadJson("incident-registry-expanded.json");
    const sheet = loadJson("incident-board-sheet.json");
    const fixture = loadJson("incident-backtest-fixture.json");

    expect(registry.summary).toEqual(sheet.summary);
    expect(registry.summary).toEqual(fixture.summary);

    expect(registry.summary).toMatchObject({
      registry_total: 16,
      local_labels_count: 9,
      openai_new_count: 7,
      second_anchored_count: 8,
      second_anchored_unique_games: 7,
      local_board_scoreable_second_anchored: 7,
      external_polymarket_board_available_second_anchored: 8,
      external_kalshi_board_available_second_anchored: 7,
    });

    expect(registry.incidents).toHaveLength(16);
    expect(sheet.rows).toHaveLength(16);
    expect(fixture.fixtures).toHaveLength(8);
  });

  it("preserves the board-scoreability boundary for anchored incidents", () => {
    const sheet = loadJson("incident-board-sheet.json");
    const fixture = loadJson("incident-backtest-fixture.json");
    const rows = new Map(
      (sheet.rows ?? []).map((row) => [String(row.id), row] as const)
    );
    const fixtures = new Map(
      (fixture.fixtures ?? []).map((row) => [String(row.id), row] as const)
    );

    expect(rows.get("hauser_tatum")).toMatchObject({
      anchor_type: "second",
      external_board_scoreable: true,
      external_polymarket_board_available: true,
      external_kalshi_board_available: true,
      local_board_scoreable: true,
      local_board_eq_k3_lead_s: 95.5,
      local_board_vw_k3_lead_s: null,
    });

    expect(rows.get("barnes_castle")).toMatchObject({
      anchor_type: "second",
      external_board_scoreable: true,
      external_polymarket_board_available: true,
      external_kalshi_board_available: false,
      local_board_scoreable: false,
      local_market_count: 0,
    });

    expect(fixtures.get("reaves_hayes")).toMatchObject({
      external_polymarket_board_available: true,
      external_kalshi_board_available: true,
      local_board_scoreable: true,
      local_offprice_print_lead_s: 37.8,
    });
  });
});
