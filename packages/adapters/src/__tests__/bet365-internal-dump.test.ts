import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  parseBet365DumpLine,
  syncBet365InternalDump,
} from "../bet365-internal-dump";

let dbDir = "";
let dumpDir = "";

function seedGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "BOS",
      key: "bos",
      name: "Boston Celtics",
      shortName: "Celtics",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "PHI",
      key: "phi",
      name: "Philadelphia 76ers",
      shortName: "76ers",
      side: "home",
    },
    id: "nba-bos-phi-2026-04-21",
    league: "NBA",
    scheduledStart: "2026-04-21T23:00:00.000Z",
    sourceGameKeyNba: "0042500112",
    sport: "basketball",
  });
  recordGameStateObservation({
    awayScore: 97,
    capturedAt: "2026-04-22T02:00:00.000Z",
    clock: null,
    finalAt: "2026-04-22T02:00:00.000Z",
    gameId: "nba-bos-phi-2026-04-21",
    homeScore: 111,
    isFinal: true,
    period: 4,
    startedAt: "2026-04-21T23:00:00.000Z",
    status: "final",
  });
}

describe("parseBet365DumpLine", () => {
  it("parses a valid JSONL row with snake_case keys", () => {
    const result = parseBet365DumpLine(
      JSON.stringify({
        away_team: "BOS",
        game_date: "2026-04-21",
        home_team: "PHI",
        implied_probability: 0.62,
        in_play: false,
        market_family: "moneyline",
        observed_at: "2026-04-21T22:30:00.000Z",
        participant_key: "phi",
        selection: "phi",
      }),
      1,
      "test.jsonl"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.row.marketFamily).toBe("moneyline");
      expect(result.row.impliedProbability).toBe(0.62);
    }
  });

  it("rejects rows missing required fields", () => {
    const result = parseBet365DumpLine(
      JSON.stringify({ home_team: "PHI" }),
      1,
      "bad.jsonl"
    );
    expect(result.ok).toBe(false);
  });
});

describe("syncBet365InternalDump", () => {
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), "signal-console-bet365-dump-"));
    dumpDir = mkdtempSync(join(tmpdir(), "signal-console-bet365-dump-src-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(dbDir, "signal-console.sqlite");
    process.env.BET365_INTERNAL_DUMP_DIR = dumpDir;
    mkdirSync(join(dumpDir, "_processed"), { recursive: true });
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    delete process.env.BET365_INTERNAL_DUMP_DIR;
    if (dbDir) rmSync(dbDir, { force: true, recursive: true });
    if (dumpDir) rmSync(dumpDir, { force: true, recursive: true });
  });

  it("ingests a moneyline observation into historical ticks and archives the file", () => {
    seedGame();

    writeFileSync(
      join(dumpDir, "bet365-2026-04-21.jsonl"),
      [
        JSON.stringify({
          away_team: "BOS",
          game_date: "2026-04-21",
          home_team: "PHI",
          implied_probability: 0.12,
          market_family: "moneyline",
          observed_at: "2026-04-21T22:30:00.000Z",
          participant_key: "phi",
          selection: "phi",
        }),
        JSON.stringify({
          away_team: "BOS",
          game_date: "2026-04-21",
          home_team: "PHI",
          market_family: "moneyline",
          observed_at: "2026-04-21T22:30:05.000Z",
          odds_american: -200,
          participant_key: "bos",
          selection: "bos",
        }),
        "",
      ].join("\n")
    );

    const result = syncBet365InternalDump({
      now: () => new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    expect(result.rowsParsed).toBe(2);
    expect(result.ticksWritten).toBe(2);
    expect(result.gamesMatched).toBe(1);

    const db = getDatabase();
    const rows = db
      .prepare(
        `
          SELECT sm.instrument_id AS instrumentId,
                 sm.source_selection_key AS selection,
                 q.implied_probability AS p,
                 q.odds_raw AS oddsRaw
          FROM quote_ticks q
          JOIN source_markets sm ON sm.id = q.source_market_id
          WHERE sm.source = 'bet365'
          ORDER BY q.captured_at ASC
        `
      )
      .all() as Array<{
      instrumentId: string;
      selection: string;
      p: number | null;
      oddsRaw: string | null;
    }>;

    expect(rows).toHaveLength(2);
    const phi = rows.find((r) => r.selection === "phi");
    expect(phi?.instrumentId).toBe("nba-bos-phi-2026-04-21-moneyline-phi");
    expect(phi?.p).toBeCloseTo(0.12);
    const bos = rows.find((r) => r.selection === "bos");
    expect(bos?.p).toBeCloseTo(0.6667, 3);
    expect(bos?.oddsRaw).toBe("-200");

    // File should be moved to the processed dir
    const remaining = readdirSync(dumpDir).filter((name) =>
      name.endsWith(".jsonl")
    );
    expect(remaining).toHaveLength(0);
    const archived = readdirSync(join(dumpDir, "_processed"));
    expect(archived).toContain("bet365-2026-04-21.jsonl");
  });

  it("skips rows whose game cannot be matched", () => {
    writeFileSync(
      join(dumpDir, "stray.jsonl"),
      JSON.stringify({
        away_team: "ZZZ",
        game_date: "2026-04-21",
        home_team: "QQQ",
        market_family: "moneyline",
        observed_at: "2026-04-21T22:00:00.000Z",
        selection: "qqq",
      })
    );

    const result = syncBet365InternalDump({
      now: () => new Date("2026-04-22T12:00:00.000Z"),
    });

    expect(result.gamesMatched).toBe(0);
    expect(result.ticksWritten).toBe(0);
    expect(result.rowsSkipped).toBeGreaterThan(0);
  });
});
