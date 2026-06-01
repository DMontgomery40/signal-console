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

export async function fetchCdnPbp(
  rawGameId: string,
): Promise<{ actions: CdnAction[]; generatedAt: string }> {
  const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${rawGameId}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.nba.com/" },
  });
  if (!res.ok) throw new Error(`cdn ${rawGameId}: HTTP ${res.status}`);
  const json = (await res.json()) as {
    game?: { actions?: CdnAction[] };
    meta?: { time?: string };
  };
  return {
    actions: json.game?.actions ?? [],
    generatedAt: json.meta?.time ?? new Date().toISOString(),
  };
}

/** Map cdn actions to the repository input shape; drops actions without a numeric
 * actionNumber and normalizes personId (>0) + playerName (playerNameI || playerName). */
export function mapCdnPbpActions(actions: CdnAction[]): MappedPbpAction[] {
  return actions
    .filter((a) => a.actionNumber != null && Number.isFinite(a.actionNumber))
    .map((a) => ({
      actionNumber: a.actionNumber as number,
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
