// Seed a tiny gold-shaped fixture DB for the hermetic pbp_actions exporter test
// (packages/research-truth/src/__tests__/pbp-actions-export.test.ts).
//
// Creates the DB at SIGNAL_CONSOLE_DB_PATH via the REAL shared migrations
// (getDatabase applies them), then seeds one game whose rebound was silently
// corrected: the actions table holds the CURRENT (post-correction) credit —
// exactly the state the live upsert leaves behind — while nba_pbp_revisions
// holds the earliest-observed (original) credit the exporter must prefer.
//
// Run (the test does this for you):
//   SIGNAL_CONSOLE_DB_PATH=/tmp/fixture.sqlite \
//     pnpm exec tsx scripts/dev/seed-pbp-fixture-gold-db.ts

import process from "node:process";

import { closeDatabase, getDatabase } from "../../packages/shared/src/index";

export const FIXTURE_GAME_ID = "nba-0049900001";
export const FIXTURE_ORIGINAL_PERSON = 101; // credited at capture time (pre-correction)
export const FIXTURE_CORRECTED_PERSON = 102; // silently corrected later (current actions row)

function main(): number {
  if (process.env.SIGNAL_CONSOLE_DB_PATH === undefined) {
    process.stderr.write("SIGNAL_CONSOLE_DB_PATH must point at the fixture DB to create\n");
    return 1;
  }
  const db = getDatabase(); // creates the file + applies the real migrations
  try {
    db.prepare(
      `INSERT INTO games (id, sport, league, home_participant_json, away_participant_json, scheduled_start)
       VALUES (?, 'basketball', 'NBA', '{"key":"aaa"}', '{"key":"bbb"}', '2026-01-01T00:00:00Z')`,
    ).run(FIXTURE_GAME_ID);

    const insertAction = db.prepare(
      `INSERT INTO nba_play_by_play_actions
         (game_id, action_number, action_type, sub_type, person_id, player_name,
          period, clock, team_tricode, time_actual, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    type ActionSpec = readonly [number, string, string | null, number, string, string, string];
    // Two AAA players act (establishes the PBP window), then the corrected
    // rebound (action 3) and an uncorrected control rebound (action 4).
    const actions: readonly ActionSpec[] = [
      [1, "2pt", null, FIXTURE_ORIGINAL_PERSON, "Original Player", "PT11M00S", "00:01"],
      [2, "2pt", null, FIXTURE_CORRECTED_PERSON, "Corrected Player", "PT10M30S", "00:02"],
      [
        3,
        "rebound",
        "defensive",
        FIXTURE_CORRECTED_PERSON,
        "Corrected Player",
        "PT10M00S",
        "00:03",
      ],
      [4, "rebound", "defensive", FIXTURE_ORIGINAL_PERSON, "Original Player", "PT09M00S", "00:04"],
    ];
    for (const [num, type, subType, personId, playerName, clock, minute] of actions) {
      insertAction.run(
        FIXTURE_GAME_ID,
        num,
        type,
        subType,
        personId,
        playerName,
        1,
        clock,
        "AAA",
        `2026-01-01T${minute}:00Z`,
        `2026-01-01T${minute}:05Z`,
      );
    }

    const insertRevision = db.prepare(
      `INSERT INTO nba_pbp_revisions
         (game_id, action_number, captured_at, action_type, sub_type, person_id,
          player_name, period, clock, team_tricode, time_actual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Earliest capture saw the ORIGINAL credit; a later capture saw the
    // corrected state. The exporter must take MIN(captured_at).
    insertRevision.run(
      FIXTURE_GAME_ID,
      3,
      "2026-01-01T00:03:10Z",
      "rebound",
      "defensive",
      FIXTURE_ORIGINAL_PERSON,
      "Original Player",
      1,
      "PT10M00S",
      "AAA",
      "2026-01-01T00:03:00Z",
    );
    insertRevision.run(
      FIXTURE_GAME_ID,
      3,
      "2026-01-02T00:00:00Z",
      "rebound",
      "defensive",
      FIXTURE_CORRECTED_PERSON,
      "Corrected Player",
      1,
      "PT10M00S",
      "AAA",
      "2026-01-01T00:03:00Z",
    );
  } finally {
    closeDatabase();
  }
  process.stdout.write(`seeded pbp fixture gold DB (game ${FIXTURE_GAME_ID})\n`);
  return 0;
}

process.exit(main());
