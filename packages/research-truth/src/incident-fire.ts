import { CATCH_WINDOW_AFTER_SECONDS, CATCH_WINDOW_BEFORE_SECONDS } from "./constants";
import { normalizeGameId, parseIsoSeconds, rounded } from "./stats";
import type { AlgoSpec, Fire, GameData, IncidentAlgoResult, RawIncident } from "./types";

export function incidentGameIds(incident: RawIncident): readonly string[] {
  const local = incident.localBoardGameIds.map(normalizeGameId).filter((value) => value !== "");
  if (local.length > 0) return local;
  const normalized = normalizeGameId(incident.gameId);
  return normalized === "" ? [] : [normalized];
}

export function hasCoverageForAlgo(game: GameData, algo: AlgoSpec): boolean {
  if (algo.scoreKind === "offprice") return game.micro.length > 0;
  if (algo.scoreKind === "hybrid") return game.pairs.length > 0 || game.micro.length > 0;
  return game.pairs.length > 0;
}

export function missedResult(incidentId: string, algoId: string): IncidentAlgoResult {
  return {
    incidentId,
    algoId,
    scoreable: true,
    caught: false,
    leadSeconds: null,
    fireIso: null,
    skipReason: null,
  };
}

export function skippedResult(
  incidentId: string,
  algoId: string,
  reason: string,
): IncidentAlgoResult {
  return {
    incidentId,
    algoId,
    scoreable: false,
    caught: false,
    leadSeconds: null,
    fireIso: null,
    skipReason: reason,
  };
}

export function findIncidentFire(
  incident: RawIncident,
  algorithms: readonly AlgoSpec[],
  firesByAlgoGame: ReadonlyMap<string, readonly Fire[]>,
  games: ReadonlyMap<string, GameData>,
): IncidentAlgoResult[] {
  const eventSec = parseIsoSeconds(incident.utcTime);
  return algorithms.map((algo): IncidentAlgoResult => {
    if (eventSec === null) {
      return skippedResult(incident.id, algo.id, "No exact UTC/PBP anchor.");
    }
    const gameIds = incidentGameIds(incident);
    if (gameIds.length === 0) {
      return skippedResult(incident.id, algo.id, "No local or normalized game id.");
    }
    const localGames = gameIds.flatMap((gameId): readonly GameData[] => {
      const game = games.get(gameId);
      return game === undefined ? [] : [game];
    });
    if (localGames.length === 0) {
      return skippedResult(incident.id, algo.id, "No local PBP window for this game id.");
    }
    const coveredGames = localGames.filter((game) => hasCoverageForAlgo(game, algo));
    if (coveredGames.length === 0) {
      return skippedResult(
        incident.id,
        algo.id,
        "No local quote or microstructure coverage for this algorithm.",
      );
    }
    const candidates = coveredGames.flatMap((game): readonly Fire[] => {
      const gameId = game.gameId;
      const fires = firesByAlgoGame.get(`${algo.id}:${gameId}`);
      return fires === undefined ? [] : fires;
    });
    if (candidates.length === 0) {
      return missedResult(incident.id, algo.id);
    }
    const inWindow = candidates
      .map((fire) => ({ fire, lead: fire.observedAtSec - eventSec }))
      .filter(
        ({ lead }) => lead >= CATCH_WINDOW_BEFORE_SECONDS && lead <= CATCH_WINDOW_AFTER_SECONDS,
      )
      .sort((a, b) => a.lead - b.lead);
    const first = inWindow[0];
    return {
      incidentId: incident.id,
      algoId: algo.id,
      scoreable: true,
      caught: first !== undefined,
      leadSeconds: first === undefined ? null : rounded(first.lead, 1),
      fireIso: first?.fire.observedAtIso ?? null,
      skipReason: null,
    };
  });
}
