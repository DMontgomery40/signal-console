// Shared cdn.nba.com play-by-play fetch + mapping for the PBP scripts
// (backfill-pbp-attribution, capture-pbp-revisions). cdn liveData is the sidecar's
// own source; it carries the structured attribution (personId/playerNameI/subType)
// the gold DB now persists.

export interface CdnAction {
  actionNumber?: number;
  actionType?: string;
  subType?: string;
  personId?: number;
  playerNameI?: string;
  playerName?: string;
  clock?: string;
  description?: string;
  period?: number;
  scoreAway?: string | number;
  scoreHome?: string | number;
  teamTricode?: string;
  timeActual?: string;
}

/** Shape accepted by recordNbaPlayByPlayActions / recordNbaPlayByPlayRevisions. */
export interface MappedPbpAction {
  actionNumber: number;
  actionType: string | null;
  subType: string | null;
  personId: number | null;
  playerName: string | null;
  clock: string | null;
  description: string | null;
  period: number | null;
  scoreAway: string | null;
  scoreHome: string | null;
  teamTricode: string | null;
  timeActual: string | null;
}

export interface CdnTeam {
  teamId?: number;
  teamTricode?: string;
  teamCity?: string;
  teamName?: string;
}

// cdn responses are untyped JSON (res.json() is `unknown` under the scripts
// tsconfig). Narrow with type guards rather than `as` assertions, which the repo
// eslint config forbids (consistent-type-assertions: never).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toCdnTeam(value: unknown): CdnTeam {
  if (!isRecord(value)) return {};
  return {
    teamId: readNumber(value["teamId"]),
    teamTricode: readString(value["teamTricode"]),
    teamCity: readString(value["teamCity"]),
    teamName: readString(value["teamName"]),
  };
}

function toCdnAction(value: unknown): CdnAction {
  if (!isRecord(value)) return {};
  const scoreAway = value["scoreAway"];
  const scoreHome = value["scoreHome"];
  return {
    actionNumber: readNumber(value["actionNumber"]),
    actionType: readString(value["actionType"]),
    subType: readString(value["subType"]),
    personId: readNumber(value["personId"]),
    playerNameI: readString(value["playerNameI"]),
    playerName: readString(value["playerName"]),
    clock: readString(value["clock"]),
    description: readString(value["description"]),
    period: readNumber(value["period"]),
    scoreAway:
      typeof scoreAway === "string" || typeof scoreAway === "number" ? scoreAway : undefined,
    scoreHome:
      typeof scoreHome === "string" || typeof scoreHome === "number" ? scoreHome : undefined,
    teamTricode: readString(value["teamTricode"]),
    timeActual: readString(value["timeActual"]),
  };
}

/** Minimal cdn boxscore fetch for the team + scheduled-start needed to upsert a
 * games row before backfilling PBP (the FK target). */
export async function fetchCdnBoxscore(
  rawGameId: string,
): Promise<{ homeTeam: CdnTeam; awayTeam: CdnTeam; gameTimeUTC: string | null }> {
  const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${rawGameId}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.nba.com/" },
  });
  if (!res.ok) throw new Error(`cdn boxscore ${rawGameId}: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const game: Record<string, unknown> =
    isRecord(json) && isRecord(json["game"]) ? json["game"] : {};
  return {
    homeTeam: toCdnTeam(game["homeTeam"]),
    awayTeam: toCdnTeam(game["awayTeam"]),
    gameTimeUTC: readString(game["gameTimeUTC"]) ?? null,
  };
}

export async function fetchCdnPbp(
  rawGameId: string,
): Promise<{ actions: CdnAction[]; generatedAt: string }> {
  const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${rawGameId}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.nba.com/" },
  });
  if (!res.ok) throw new Error(`cdn ${rawGameId}: HTTP ${res.status}`);
  const json: unknown = await res.json();
  const game: Record<string, unknown> =
    isRecord(json) && isRecord(json["game"]) ? json["game"] : {};
  const meta: Record<string, unknown> =
    isRecord(json) && isRecord(json["meta"]) ? json["meta"] : {};
  const rawActions = Array.isArray(game["actions"]) ? game["actions"] : [];
  return {
    actions: rawActions.map(toCdnAction),
    generatedAt: readString(meta["time"]) ?? new Date().toISOString(),
  };
}

/** Map cdn actions to the repository input shape; drops actions without a numeric
 * actionNumber and normalizes personId (>0) + playerName (playerNameI || playerName). */
export function mapCdnPbpActions(actions: CdnAction[]): MappedPbpAction[] {
  return actions
    .filter(
      (a): a is CdnAction & { actionNumber: number } =>
        a.actionNumber != null && Number.isFinite(a.actionNumber),
    )
    .map((a) => ({
      actionNumber: a.actionNumber,
      actionType: a.actionType ?? null,
      subType: a.subType ?? null,
      personId: typeof a.personId === "number" && a.personId > 0 ? a.personId : null,
      playerName: a.playerNameI ?? a.playerName ?? null,
      clock: a.clock ?? null,
      description: a.description ?? null,
      period: a.period ?? null,
      scoreAway: a.scoreAway != null ? String(a.scoreAway) : null,
      scoreHome: a.scoreHome != null ? String(a.scoreHome) : null,
      teamTricode: a.teamTricode ?? null,
      timeActual: a.timeActual ?? null,
    }));
}
