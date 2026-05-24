import {
  recordAdapterRun,
  recordGameStateObservation,
  recordNbaPlayByPlayActions,
  upsertGame,
  upsertGameOutcome,
} from "@signal-console/shared";

type SidecarParticipant = {
  abbreviation?: string | null;
  key: string;
  name: string;
  shortName: string;
  side?: "away" | "home" | null;
};

type SidecarGame = {
  awayParticipant: SidecarParticipant;
  homeParticipant: SidecarParticipant;
  id: string;
  league: string;
  scheduledStart: string;
  sourceGameKeyNba?: string | null;
  sport: string;
};

type SidecarGameState = {
  awayScore?: number | null;
  capturedAt: string;
  clock?: string | null;
  finalAt?: string | null;
  homeScore?: number | null;
  isFinal: boolean;
  period?: number | null;
  startedAt?: string | null;
  status: "cancelled" | "final" | "in-play" | "postponed" | "scheduled";
};

type SidecarGameOutcome = {
  capturedAt: string;
  finalAwayScore: number;
  finalHomeScore: number;
  winnerKey?: string | null;
};

type SidecarPlayByPlayAction = {
  actionNumber?: number | null;
  actionType?: string | null;
  clock?: string | null;
  description?: string | null;
  period?: number | null;
  scoreAway?: string | null;
  scoreHome?: string | null;
  teamTricode?: string | null;
  timeActual?: string | null;
};

export type NbaSidecarScoreboardPayload = {
  generatedAt: string;
  requestedDate?: string | null;
  games: Array<{
    game: SidecarGame;
    gameState: SidecarGameState;
    outcome?: SidecarGameOutcome | null;
    sourcePayloadMeta?: Record<string, unknown>;
  }>;
};

export type NbaSidecarPlayByPlayPayload = {
  actions: SidecarPlayByPlayAction[];
  gameId: string;
  generatedAt: string;
};

type FetchLike = typeof fetch;

export type NbaSidecarWindowSummary = {
  datesSynced: string[];
  dateErrors: Array<{ date: string; error: string }>;
  finishedAt: string;
  gamesSeen: number;
  ok: boolean;
  outcomesWritten: number;
  playByPlayActionsWritten: number;
  startedAt: string;
  statesWritten: number;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildNbaSidecarUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | undefined>
) {
  const url = new URL(`${trimTrailingSlash(baseUrl)}${pathname}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function formatDateUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseScore(value: string | null | undefined) {
  if (value == null || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveFinalSidecarResultFromPlayByPlay(input: {
  game: SidecarGame;
  gameState: SidecarGameState;
  outcome?: SidecarGameOutcome | null;
  payload: NbaSidecarPlayByPlayPayload;
}) {
  if (
    input.outcome ||
    input.gameState.isFinal ||
    input.gameState.status === "final"
  ) {
    return null;
  }

  const finalAction =
    input.payload.actions
      .slice()
      .reverse()
      .find(
        (action) =>
          action.actionType === "game" ||
          String(action.description ?? "")
            .toLowerCase()
            .includes("game end")
      ) ?? null;
  if (!finalAction) {
    return null;
  }

  const awayScore = parseScore(finalAction.scoreAway);
  const homeScore = parseScore(finalAction.scoreHome);
  if (awayScore == null || homeScore == null) {
    return null;
  }

  const finalAt = finalAction.timeActual ?? input.payload.generatedAt;
  const winnerKey =
    homeScore > awayScore
      ? input.game.homeParticipant.key
      : awayScore > homeScore
        ? input.game.awayParticipant.key
        : null;

  return {
    gameState: {
      awayScore,
      capturedAt: input.payload.generatedAt,
      clock: finalAction.clock ?? input.gameState.clock ?? null,
      finalAt,
      homeScore,
      isFinal: true,
      period: finalAction.period ?? input.gameState.period ?? null,
      startedAt: input.gameState.startedAt ?? input.game.scheduledStart,
      status: "final" as const,
    },
    outcome: {
      capturedAt: input.payload.generatedAt,
      finalAwayScore: awayScore,
      finalHomeScore: homeScore,
      winnerKey,
    },
  };
}

export function buildNbaSidecarDateWindow(options?: {
  lookaheadDays?: number;
  lookbackDays?: number;
  now?: () => Date;
}) {
  const lookbackDays = options?.lookbackDays ?? 1;
  const lookaheadDays = options?.lookaheadDays ?? 3;
  const anchorDate = options?.now?.() ?? new Date();
  const start = Date.UTC(
    anchorDate.getUTCFullYear(),
    anchorDate.getUTCMonth(),
    anchorDate.getUTCDate()
  );
  const dates: string[] = [];

  for (let offset = lookbackDays * -1; offset <= lookaheadDays; offset += 1) {
    dates.push(formatDateUtc(new Date(start + offset * 24 * 60 * 60 * 1000)));
  }

  return dates;
}

export async function fetchNbaSidecarScoreboard(options?: {
  baseUrl?: string;
  date?: string;
  fetchImpl?: FetchLike;
}) {
  const baseUrl = options?.baseUrl ?? process.env.NBA_SIDECAR_BASE_URL;
  if (!baseUrl) {
    throw new Error("NBA_SIDECAR_BASE_URL is not configured.");
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildNbaSidecarUrl(baseUrl, "/api/v1/scoreboard", {
      date: options?.date,
    })
  );

  if (!response.ok) {
    throw new Error(
      `NBA sidecar scoreboard request failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as {
    data: NbaSidecarScoreboardPayload;
    meta?: Record<string, unknown>;
  };

  return payload.data;
}

export async function fetchNbaSidecarPlayByPlay(options: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  nbaGameId: string;
}) {
  const baseUrl = options.baseUrl ?? process.env.NBA_SIDECAR_BASE_URL;
  if (!baseUrl) {
    throw new Error("NBA_SIDECAR_BASE_URL is not configured.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildNbaSidecarUrl(
      baseUrl,
      `/api/v1/games/${options.nbaGameId}/play-by-play`
    )
  );

  if (!response.ok) {
    throw new Error(
      `NBA sidecar play-by-play request failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as {
    data: NbaSidecarPlayByPlayPayload;
    meta?: Record<string, unknown>;
  };

  return payload.data;
}

export function ingestNbaSidecarScoreboard(
  payload: NbaSidecarScoreboardPayload
) {
  let statesWritten = 0;
  let outcomesWritten = 0;

  for (const entry of payload.games) {
    upsertGame(entry.game);
    const stateResult = recordGameStateObservation({
      ...entry.gameState,
      gameId: entry.game.id,
    });
    if (stateResult.wrote) {
      statesWritten += 1;
    }

    if (entry.outcome) {
      upsertGameOutcome({
        ...entry.outcome,
        gameId: entry.game.id,
      });
      outcomesWritten += 1;
    }
  }

  return {
    gamesSeen: payload.games.length,
    outcomesWritten,
    statesWritten,
  };
}

export function ingestNbaSidecarPlayByPlay(options: {
  canonicalGameId: string;
  payload: NbaSidecarPlayByPlayPayload;
}) {
  const result = recordNbaPlayByPlayActions({
    actions: options.payload.actions
      .filter(
        (
          action
        ): action is SidecarPlayByPlayAction & { actionNumber: number } =>
          action.actionNumber != null && Number.isFinite(action.actionNumber)
      )
      .map((action) => ({
        ...action,
        rawMetadata: action as unknown as Record<string, unknown>,
      })),
    capturedAt: options.payload.generatedAt,
    gameId: options.canonicalGameId,
  });

  return {
    actionsSeen: result.actionsSeen,
    actionsWritten: result.actionsWritten,
  };
}

export async function syncNbaSidecarScoreboard(options?: {
  baseUrl?: string;
  date?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  const startedAt = (options?.now ?? (() => new Date()))().toISOString();

  try {
    const payload = await fetchNbaSidecarScoreboard(options);
    const summary = ingestNbaSidecarScoreboard(payload);
    const finishedAt = (options?.now ?? (() => new Date()))().toISOString();
    recordAdapterRun({
      finishedAt,
      recordsSeen: summary.gamesSeen,
      recordsWritten: summary.statesWritten + summary.outcomesWritten,
      source: "nba",
      startedAt,
      status: "ok",
    });

    return {
      ...summary,
      finishedAt,
      generatedAt: payload.generatedAt,
      ok: true as const,
      playByPlayActionsWritten: 0,
      requestedDate: payload.requestedDate ?? null,
      startedAt,
    };
  } catch (error) {
    const finishedAt = (options?.now ?? (() => new Date()))().toISOString();
    recordAdapterRun({
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "nba",
      startedAt,
      status: "error",
    });
    throw error;
  }
}

export async function syncNbaSidecarWindow(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  lookaheadDays?: number;
  lookbackDays?: number;
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dates = buildNbaSidecarDateWindow({
    lookaheadDays: options?.lookaheadDays,
    lookbackDays: options?.lookbackDays,
    now,
  });

  try {
    let gamesSeen = 0;
    let outcomesWritten = 0;
    let playByPlayActionsWritten = 0;
    let statesWritten = 0;
    const dateErrors: Array<{ date: string; error: string }> = [];
    let datesSucceeded = 0;

    for (const date of dates) {
      try {
        const payload = await fetchNbaSidecarScoreboard({
          baseUrl: options?.baseUrl,
          date,
          fetchImpl: options?.fetchImpl,
        });
        datesSucceeded += 1;
        const summary = ingestNbaSidecarScoreboard(payload);
        gamesSeen += summary.gamesSeen;
        outcomesWritten += summary.outcomesWritten;
        statesWritten += summary.statesWritten;

        for (const entry of payload.games) {
          const nbaGameId = entry.game.sourceGameKeyNba;
          if (!nbaGameId) continue;
          try {
            const playByPlay = await fetchNbaSidecarPlayByPlay({
              baseUrl: options?.baseUrl,
              fetchImpl: options?.fetchImpl,
              nbaGameId,
            });
            const playByPlaySummary = ingestNbaSidecarPlayByPlay({
              canonicalGameId: entry.game.id,
              payload: playByPlay,
            });
            playByPlayActionsWritten += playByPlaySummary.actionsWritten;

            const derivedFinal = deriveFinalSidecarResultFromPlayByPlay({
              game: entry.game,
              gameState: entry.gameState,
              outcome: entry.outcome,
              payload: playByPlay,
            });
            if (derivedFinal) {
              const derivedState = recordGameStateObservation({
                ...derivedFinal.gameState,
                gameId: entry.game.id,
              });
              if (derivedState.wrote) {
                statesWritten += 1;
              }
              upsertGameOutcome({
                ...derivedFinal.outcome,
                gameId: entry.game.id,
              });
              outcomesWritten += 1;
            }
          } catch (playByPlayError) {
            dateErrors.push({
              date,
              error: `play-by-play ${nbaGameId}: ${
                playByPlayError instanceof Error
                  ? playByPlayError.message
                  : String(playByPlayError)
              }`,
            });
          }
        }
      } catch (dateError) {
        dateErrors.push({
          date,
          error:
            dateError instanceof Error ? dateError.message : String(dateError),
        });
      }
    }

    if (datesSucceeded === 0) {
      throw new Error(
        `NBA sidecar window failed for every requested date: ${dateErrors
          .map((entry) => `${entry.date}: ${entry.error}`)
          .join(" | ")}`
      );
    }

    const finishedAt = now().toISOString();
    const ok = dateErrors.length === 0;
    recordAdapterRun({
      errorMessage: ok
        ? undefined
        : dateErrors
            .map((entry) => `${entry.date}: ${entry.error}`)
            .join(" | "),
      finishedAt,
      recordsSeen: gamesSeen,
      recordsWritten:
        statesWritten + outcomesWritten + playByPlayActionsWritten,
      source: "nba",
      startedAt,
      status: ok ? "ok" : "error",
    });

    return {
      dateErrors,
      datesSynced: dates,
      finishedAt,
      gamesSeen,
      ok,
      outcomesWritten,
      playByPlayActionsWritten,
      startedAt,
      statesWritten,
    } satisfies NbaSidecarWindowSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "nba",
      startedAt,
      status: "error",
    });
    throw error;
  }
}
