// Capture cdn.nba.com play-by-play snapshots into the VERSIONED revision shadow
// (nba_pbp_revisions) so silent stat corrections are recovered by diffing.
//
// The worker already appends a revision on every live PBP poll; this is the
// manual / scheduled entrypoint to re-snapshot a set of games on a cadence after
// the game (NBA corrections land minutes-to-days later — re-run periodically for
// ~7 days post-game; VERIFY that horizon before hard-coding a cron).
//
//   GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
//     pnpm tsx scripts/capture-pbp-revisions.ts [--games 0042500312,0042500222 ...]
//
// Append-only + idempotent per snapshot (INSERT OR IGNORE on
// (game_id, action_number, captured_at)); a new captured_at preserves history, so
// re-running later accumulates revisions. Use listPbpAttributionTransitions(gameId)
// to read recovered credited->rightful corrections.

import { GOLD_DB_PATH } from "../packages/db/src/open";
import { recordNbaPlayByPlayRevisions } from "../packages/shared/src/live-repository";

import { fetchCdnPbp, mapCdnPbpActions } from "./lib/cdn-pbp";

process.env.SIGNAL_CONSOLE_DB_PATH ??= process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;

// Incident games (playoffs) to seed/track by default.
const DEFAULT_GAMES = [
  "0042500312",
  "0042500222",
  "0042500137",
  "0042500224",
  "0042500207",
  "0042500311",
  "0042500301",
  "0042500303",
  "0042500314",
];

function parseArgGames(): string[] {
  const i = process.argv.indexOf("--games");
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  if (raw !== undefined && raw !== "") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_GAMES;
}

async function main(): Promise<void> {
  const games = parseArgGames();
  console.log(
    `capturing PBP revisions for ${games.length} games -> ${process.env.SIGNAL_CONSOLE_DB_PATH}`,
  );
  let failed = 0;
  for (const raw of games) {
    try {
      const { actions, generatedAt } = await fetchCdnPbp(raw);
      const result = recordNbaPlayByPlayRevisions({
        gameId: `nba-${raw}`,
        capturedAt: generatedAt,
        actions: mapCdnPbpActions(actions),
      });
      console.log(
        `  nba-${raw}: seen=${result.actionsSeen} revisionsWritten=${result.revisionsWritten} @ ${generatedAt}`,
      );
    } catch (err) {
      console.error(`  nba-${raw}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }
  console.log(
    `done (${games.length - failed}/${games.length} ok, ${failed} failed). ` +
      "Re-run on a cadence; diff with listPbpAttributionTransitions(gameId).",
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
