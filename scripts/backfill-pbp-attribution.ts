// Backfill structured PBP attribution (personId/playerName/subType) into the gold
// DB for a set of games, via the canonical writer (recordNbaPlayByPlayActions),
// re-pulling final play-by-play from cdn.nba.com (the sidecar's own source).
//
// WHY: migration 15 added person_id/player_name/sub_type but existing rows are
// NULL (they were ingested before the normalizer carried attribution). This
// upserts the same actions WITH attribution so the credited<->rightful pairing
// is exact in the DB. Idempotent (ON CONFLICT upsert by game_id, action_number).
//
//   GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
//     pnpm tsx scripts/backfill-pbp-attribution.ts [--games 0042500312,0042500222 ...]
//
// Defaults to the incident-registry games already present in the gold DB.

import { GOLD_DB_PATH } from "../packages/db/src/open";
import { recordNbaPlayByPlayActions } from "../packages/shared/src/live-repository";

import { fetchCdnPbp, mapCdnPbpActions } from "./lib/cdn-pbp";

// Ensure the writable repository connection points at the gold DB (live-repository
// opens SIGNAL_CONSOLE_DB_PATH and runs migrations, incl. migration 15).
process.env.SIGNAL_CONSOLE_DB_PATH ??= process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;

// Incident games already in gold (playoffs). Regular-season incident games
// (0022500986, 0022500788) are absent and need a games row first — out of scope.
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
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_GAMES;
}

async function main(): Promise<void> {
  const games = parseArgGames();
  console.log(`backfilling PBP attribution for ${games.length} games -> ${process.env.SIGNAL_CONSOLE_DB_PATH}`);
  for (const raw of games) {
    try {
      const { actions, generatedAt } = await fetchCdnPbp(raw);
      const mapped = mapCdnPbpActions(actions);
      const withPerson = mapped.filter((a) => a.personId != null).length;
      const result = recordNbaPlayByPlayActions({
        gameId: `nba-${raw}`,
        capturedAt: generatedAt,
        actions: mapped,
      });
      console.log(
        `  nba-${raw}: seen=${result.actionsSeen} written=${result.actionsWritten} withPersonId=${withPerson}`,
      );
    } catch (err) {
      console.error(`  nba-${raw}: FAILED — ${(err as Error).message}`);
    }
  }
  console.log("done.");
}

void main();
