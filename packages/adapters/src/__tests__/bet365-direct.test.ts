import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabase,
  recordGameStateObservation,
  resetDatabase,
  upsertGame,
} from "@signal-console/shared";

import {
  captureBet365Snapshot,
  parseBet365HtmlSnapshot,
  persistBet365Snapshot,
} from "../bet365-direct";

let tempDir = "";

function seedLiveGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "LAL",
      key: "lal",
      name: "Los Angeles Lakers",
      shortName: "Lakers",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "HOU",
      key: "hou",
      name: "Houston Rockets",
      shortName: "Rockets",
      side: "home",
    },
    id: "nba-bet365-test-1",
    league: "NBA",
    scheduledStart: "2026-04-24T00:00:00.000Z",
    sourceGameKeyNba: "test1",
    sport: "basketball",
  });
  recordGameStateObservation({
    awayScore: 42,
    capturedAt: "2026-04-24T00:15:00.000Z",
    clock: "04:12",
    finalAt: null,
    gameId: "nba-bet365-test-1",
    homeScore: 38,
    isFinal: false,
    period: 2,
    startedAt: "2026-04-24T00:00:00.000Z",
    status: "in-play",
  });
}

const SAMPLE_BET365_HTML = `
  <html>
    <body>
      <div class="gl-odds-row" data-market="moneyline" data-team="Lakers" data-odds="1.65">
        Lakers -150
      </div>
      <div class="gl-odds-row" data-market="moneyline" data-team="Rockets" data-odds="2.40">
        Rockets +140
      </div>
      <div class="gl-odds-row" data-market="spread" data-team="Lakers" data-odds="1.91">
        Lakers -3.5
      </div>
    </body>
  </html>
`;

class FakePage {
  private currentUrl = "https://www.bet365.com/";
  constructor(public html: string) {}
  async goto(url: string) {
    this.currentUrl = url;
  }
  async waitForTimeout() {}
  async content() {
    return this.html;
  }
  url() {
    return this.currentUrl;
  }
  async close() {}
}

describe("parseBet365HtmlSnapshot", () => {
  it("extracts moneyline offerings by matching team abbreviation against data-team attributes", () => {
    const offerings = parseBet365HtmlSnapshot(SAMPLE_BET365_HTML, {
      awayParticipantKey: "lal",
      awayTeamShort: "Lakers",
      homeParticipantKey: "hou",
      homeTeamShort: "Rockets",
    });

    expect(offerings).toHaveLength(2);
    const lal = offerings.find((o) => o.participantKey === "lal");
    expect(lal?.family).toBe("moneyline");
    expect(lal?.priceDecimal).toBeCloseTo(1.65);
    expect(lal?.impliedProbability).toBeCloseTo(1 / 1.65, 3);
    const hou = offerings.find((o) => o.participantKey === "hou");
    expect(hou?.priceDecimal).toBeCloseTo(2.4);
  });

  it("returns no offerings when markers are absent rather than guessing", () => {
    const offerings = parseBet365HtmlSnapshot(
      "<html><body>no structured odds here</body></html>",
      {
        awayParticipantKey: "lal",
        awayTeamShort: "Lakers",
        homeParticipantKey: "hou",
        homeTeamShort: "Rockets",
      }
    );
    expect(offerings).toEqual([]);
  });
});

describe("captureBet365Snapshot + persistBet365Snapshot", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-bet365-direct-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  });

  it("turns a captured HTML snapshot into live quote_ticks on the canonical instrument", async () => {
    seedLiveGame();
    const page = new FakePage(SAMPLE_BET365_HTML) as unknown as Parameters<
      typeof captureBet365Snapshot
    >[0]["page"];

    const snapshot = await captureBet365Snapshot({
      awayParticipantKey: "lal",
      awayTeamShort: "Lakers",
      gameId: "nba-bet365-test-1",
      homeParticipantKey: "hou",
      homeTeamShort: "Rockets",
      now: () => new Date("2026-04-24T00:15:00.000Z"),
      page,
      pageUrl: "https://www.bet365.com/#/AC/fake",
    });

    expect(snapshot.offerings).toHaveLength(2);
    const stats = persistBet365Snapshot(snapshot);
    expect(stats.ticksWritten).toBe(2);

    const db = getDatabase();
    const rows = db
      .prepare(
        `
          SELECT sm.instrument_id AS instrumentId,
                 sm.source_selection_key AS selection,
                 q.implied_probability AS p
          FROM quote_ticks q
          JOIN source_markets sm ON sm.id = q.source_market_id
          WHERE sm.source = 'bet365'
          ORDER BY sm.source_selection_key
        `
      )
      .all() as Array<{ instrumentId: string; selection: string; p: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.selection).sort()).toEqual(["hou", "lal"]);
    const lal = rows.find((r) => r.selection === "lal");
    expect(lal?.p).toBeCloseTo(1 / 1.65, 3);
  });

  it("fails clearly when session state file is missing", async () => {
    // Just import the openBet365Browser to check the guard — no actual browser launch
    const { openBet365Browser } = await import("../bet365-direct");
    const fake = join(tempDir, "missing-storage.json");
    await expect(openBet365Browser({ storageStatePath: fake })).rejects.toThrow(
      /does not exist/
    );
  });

  it("reports missing BET365_SESSION_STATE_PATH", async () => {
    const { openBet365Browser } = await import("../bet365-direct");
    delete process.env.BET365_SESSION_STATE_PATH;
    await expect(openBet365Browser()).rejects.toThrow(
      /BET365_SESSION_STATE_PATH is not configured/
    );
  });
});

// These exports are re-declared here so vitest picks them up in coverage runs.
void writeFileSync;
