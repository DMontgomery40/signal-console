// Ingest absent incident games into the gold DB so they become recoverable as
// matched-recall incidents (FAR gap #2). Two regular-season miscredit incidents
// (0022500986 Hauser->Tatum, 0022500788 Barnes->Castle) had registry entries but
// NO games row, so their PBP could not be recorded (FK to games(id)) and the
// re-ranker eval silently dropped them. This creates the games row from the cdn
// boxscore (teams + scheduled start) via the canonical upsertGame, then backfills
// PBP attribution via recordNbaPlayByPlayActions — "add it to the db".
//
//   GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
//     pnpm tsx scripts/ingest-incident-games.ts [--games 0022500986,0022500788]
//
// Idempotent: upsertGame is ON CONFLICT(id) DO UPDATE; PBP upserts by
// (game_id, action_number). These are settled games — the correction is already
// baked into the final PBP, so the revision harvester is NOT used here; the label
// comes from the curated incident registry.

import { GOLD_DB_PATH } from "../packages/db/src/open";
import type { CanonicalGame, GameParticipant } from "../packages/domain/src/live-types";
import { recordNbaPlayByPlayActions, upsertGame } from "../packages/shared/src/live-repository";

import { fetchCdnBoxscore, fetchCdnPbp, mapCdnPbpActions, type CdnTeam } from "./lib/cdn-pbp";

process.env.SIGNAL_CONSOLE_DB_PATH ??= process.env.GOLD_DB_PATH ?? GOLD_DB_PATH;

const DEFAULT_GAMES = ["0022500986", "0022500788"];

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

function participant(team: CdnTeam, side: "home" | "away"): GameParticipant {
  const tri = (team.teamTricode ?? "").toUpperCase();
  const city = (team.teamCity ?? "").trim();
  const name = (team.teamName ?? "").trim();
  return {
    key: tri.toLowerCase(),
    name: [city, name].filter(Boolean).join(" ") || tri,
    shortName: name || tri,
    abbreviation: tri || null,
    side,
  };
}

async function main(): Promise<void> {
  const games = parseArgGames();
  console.log(
    `ingesting ${games.length} incident game(s) -> ${process.env.SIGNAL_CONSOLE_DB_PATH}`,
  );
  for (const raw of games) {
    try {
      const box = await fetchCdnBoxscore(raw);
      const game: CanonicalGame = {
        id: `nba-${raw}`,
        sport: "basketball",
        league: "NBA",
        sourceGameKeyNba: raw,
        homeParticipant: participant(box.homeTeam, "home"),
        awayParticipant: participant(box.awayTeam, "away"),
        scheduledStart: box.gameTimeUTC ?? new Date().toISOString(),
      };
      upsertGame(game);
      const { actions, generatedAt } = await fetchCdnPbp(raw);
      const mapped = mapCdnPbpActions(actions);
      const withPerson = mapped.filter((a) => a.personId != null).length;
      const result = recordNbaPlayByPlayActions({
        gameId: `nba-${raw}`,
        capturedAt: generatedAt,
        actions: mapped,
      });
      console.log(
        `  nba-${raw}: ${game.awayParticipant.abbreviation}@${game.homeParticipant.abbreviation} ` +
          `${game.scheduledStart} | pbp seen=${result.actionsSeen} written=${result.actionsWritten} ` +
          `withPersonId=${withPerson}`,
      );
    } catch (err) {
      console.error(`  nba-${raw}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("done.");
}

void main();
