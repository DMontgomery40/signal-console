import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getInstrumentComparison,
  getDatabase,
  getInstrumentRawSource,
  getResearchGame,
  getResearchCoverage,
  getStorageCoverage,
  getInstrumentTimeline,
  getMarketAnomalyScoreConfig,
  listAdminSources,
  listGameMarkets,
  listMarketAnomalyAlerts,
  listResearchGames,
  listPlayerPropDisagreementAlerts,
  listResearchDivergence,
  listSignalMismatches,
  listPbpAttributionTransitions,
  listNbaPbpRevisionGameIds,
  harvestMiscreditLabels,
  recordGameStateObservation,
  recordMarketMicrostructureEvent,
  recordNbaPlayByPlayActions,
  recordNbaPlayByPlayRevisions,
  recordQuoteObservation,
  recordRawPayload,
  resetDatabase,
  upsertGame,
  upsertGameOutcome,
  upsertMarketInstrument,
  upsertMarketAnomalyScoreConfig,
  upsertSourceMarket,
} from "../db";

let tempDir = "";

function seedLiveRepositoryGame() {
  upsertGame({
    awayParticipant: {
      abbreviation: "NYK",
      key: "nyk",
      name: "New York Knicks",
      shortName: "Knicks",
      side: "away",
    },
    homeParticipant: {
      abbreviation: "BOS",
      key: "bos",
      name: "Boston Celtics",
      shortName: "Celtics",
      side: "home",
    },
    id: "nba-bos-nyk-2026-04-21",
    league: "NBA",
    scheduledStart: "2026-04-21T23:00:00.000Z",
    sourceGameKeyNba: "0022600001",
    sport: "basketball",
  });

  recordGameStateObservation({
    awayScore: 99,
    capturedAt: "2026-04-21T23:40:00.000Z",
    clock: "02:14",
    finalAt: null,
    gameId: "nba-bos-nyk-2026-04-21",
    homeScore: 104,
    isFinal: false,
    period: 4,
    startedAt: "2026-04-21T23:05:00.000Z",
    status: "in-play",
  });

  upsertMarketInstrument({
    displayLabel: "Boston moneyline",
    family: "moneyline",
    gameId: "nba-bos-nyk-2026-04-21",
    id: "bos-moneyline",
    inPlay: true,
    line: null,
    participantKey: "bos",
    selection: "bos",
  });

  upsertMarketInstrument({
    displayLabel: "Boston -4.5",
    family: "spread",
    gameId: "nba-bos-nyk-2026-04-21",
    id: "bos-spread-4_5",
    inPlay: true,
    line: -4.5,
    participantKey: "bos",
    selection: "bos",
  });

  upsertSourceMarket({
    gameId: "nba-bos-nyk-2026-04-21",
    id: "sm-bet365-bos-moneyline",
    instrumentId: "bos-moneyline",
    mappingStatus: "auto",
    rawFamily: "moneyline",
    rawLabel: "Boston Celtics",
    rawMetadata: { source: "bet365" },
    source: "bet365",
    sourceMarketKey: "b365-bos-ml",
    sourceSelectionKey: "bos",
  });

  upsertSourceMarket({
    gameId: "nba-bos-nyk-2026-04-21",
    id: "sm-kalshi-bos-moneyline",
    instrumentId: "bos-moneyline",
    mappingStatus: "auto",
    rawFamily: "moneyline",
    rawLabel: "BOS win",
    rawMetadata: { source: "kalshi" },
    source: "kalshi",
    sourceMarketKey: "kal-bos-ml",
    sourceSelectionKey: "bos",
  });

  upsertSourceMarket({
    gameId: "nba-bos-nyk-2026-04-21",
    id: "sm-bet365-bos-spread",
    instrumentId: "bos-spread-4_5",
    mappingStatus: "auto",
    rawFamily: "spread",
    rawLabel: "Boston -4.5",
    rawMetadata: { source: "bet365" },
    source: "bet365",
    sourceMarketKey: "b365-bos-spread",
    sourceSelectionKey: "bos",
  });

  upsertSourceMarket({
    gameId: "nba-bos-nyk-2026-04-21",
    id: "sm-kalshi-bos-spread",
    instrumentId: "bos-spread-4_5",
    mappingStatus: "auto",
    rawFamily: "spread",
    rawLabel: "Boston -5.5",
    rawMetadata: { source: "kalshi" },
    source: "kalshi",
    sourceMarketKey: "kal-bos-spread",
    sourceSelectionKey: "bos",
  });

  recordQuoteObservation({
    bestAsk: null,
    bestBid: null,
    capturedAt: "2026-04-21T23:40:00.000Z",
    depthScore: 97,
    heartbeatAfterMs: 60_000,
    impliedProbability: 0.61,
    lineRaw: null,
    oddsRaw: "-156",
    priceRaw: null,
    sourceMarketId: "sm-bet365-bos-moneyline",
    volume: 100,
  });

  recordQuoteObservation({
    bestAsk: 0.69,
    bestBid: 0.68,
    capturedAt: "2026-04-21T23:40:05.000Z",
    depthScore: 78,
    heartbeatAfterMs: 60_000,
    impliedProbability: 0.68,
    lineRaw: null,
    oddsRaw: null,
    priceRaw: 0.68,
    sourceMarketId: "sm-kalshi-bos-moneyline",
    volume: 42,
  });

  recordQuoteObservation({
    bestAsk: null,
    bestBid: null,
    capturedAt: "2026-04-21T23:40:10.000Z",
    depthScore: 95,
    heartbeatAfterMs: 60_000,
    impliedProbability: 0.54,
    lineRaw: -4.5,
    oddsRaw: "-118",
    priceRaw: null,
    sourceMarketId: "sm-bet365-bos-spread",
    volume: 100,
  });

  recordQuoteObservation({
    bestAsk: 0.57,
    bestBid: 0.56,
    capturedAt: "2026-04-21T23:40:12.000Z",
    depthScore: 65,
    heartbeatAfterMs: 60_000,
    impliedProbability: 0.56,
    lineRaw: -5.5,
    oddsRaw: null,
    priceRaw: 0.56,
    sourceMarketId: "sm-kalshi-bos-spread",
    volume: 28,
  });
}

describe("live repository", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-live-db-"));
    process.env.SIGNAL_CONSOLE_DB_PATH = join(tempDir, "signal-console.sqlite");
    resetDatabase();
  });

  afterEach(() => {
    resetDatabase();
    delete process.env.SIGNAL_CONSOLE_DB_PATH;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists structured PBP attribution (personId/playerName/subType) through migration 15", () => {
    seedLiveRepositoryGame();
    recordNbaPlayByPlayActions({
      gameId: "nba-bos-nyk-2026-04-21",
      capturedAt: "2026-04-21T23:41:00.000Z",
      actions: [
        {
          actionNumber: 416,
          actionType: "rebound",
          subType: "offensive",
          personId: 1641705,
          playerName: "V. Wembanyama",
          description: "V. Wembanyama REBOUND",
        },
        { actionNumber: 417, actionType: "timeout" },
      ],
    });
    const db = getDatabase();
    const row = db
      .prepare(
        "SELECT person_id, player_name, sub_type FROM nba_play_by_play_actions WHERE game_id = ? AND action_number = 416",
      )
      .get("nba-bos-nyk-2026-04-21") as {
      person_id: number | null;
      player_name: string | null;
      sub_type: string | null;
    };
    expect(row.person_id).toBe(1641705);
    expect(row.player_name).toBe("V. Wembanyama");
    expect(row.sub_type).toBe("offensive");
    // unattributed action -> null attribution, not an error
    const bare = db
      .prepare("SELECT person_id, player_name, sub_type FROM nba_play_by_play_actions WHERE action_number = 417")
      .get() as { person_id: number | null; player_name: string | null; sub_type: string | null };
    expect(bare.person_id).toBeNull();
    expect(bare.player_name).toBeNull();
    expect(bare.sub_type).toBeNull();
  });

  it("recovers a credited->rightful correction by diffing versioned PBP revisions", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    // snapshot 1: action 416 live-credited to Merrill (personId 100)
    const snap1 = recordNbaPlayByPlayRevisions({
      gameId,
      capturedAt: "2026-04-21T23:41:00.000Z",
      actions: [
        { actionNumber: 416, actionType: "rebound", subType: "offensive", personId: 100, playerName: "S. Merrill" },
        { actionNumber: 417, actionType: "rebound", personId: 300, playerName: "J. Tatum" },
      ],
    });
    expect(snap1.revisionsWritten).toBe(2);
    // re-running the SAME snapshot is idempotent (no new revisions)
    expect(
      recordNbaPlayByPlayRevisions({
        gameId,
        capturedAt: "2026-04-21T23:41:00.000Z",
        actions: [
          { actionNumber: 416, actionType: "rebound", subType: "offensive", personId: 100, playerName: "S. Merrill" },
        ],
      }).revisionsWritten,
    ).toBe(0);
    // snapshot 2 (later): action 416 corrected to Allen (personId 200); 417 unchanged
    recordNbaPlayByPlayRevisions({
      gameId,
      capturedAt: "2026-04-21T23:55:00.000Z",
      actions: [
        {
          actionNumber: 416,
          actionType: "rebound",
          subType: "offensive",
          personId: 200,
          playerName: "J. Allen",
          timeActual: "2026-04-21T23:40:30.000Z",
        },
        { actionNumber: 417, actionType: "rebound", personId: 300, playerName: "J. Tatum" },
      ],
    });

    const transitions = listPbpAttributionTransitions(gameId);
    // exactly one transition: action 416 Merrill->Allen; 417 never changed
    expect(transitions).toHaveLength(1);
    const t = transitions[0];
    expect(t.actionNumber).toBe(416);
    expect(t.fromPersonId).toBe(100);
    expect(t.toPersonId).toBe(200);
    expect(t.fromPlayer).toBe("S. Merrill");
    expect(t.toPlayer).toBe("J. Allen");
    expect(t.firstSeenAt).toBe("2026-04-21T23:41:00.000Z");
    expect(t.changedAt).toBe("2026-04-21T23:55:00.000Z");
    // event context carried for the label bridge: rebound type + event time
    expect(t.actionType).toBe("rebound");
    expect(t.timeActual).toBe("2026-04-21T23:40:30.000Z");
  });

  it("harvestMiscreditLabels turns a rebound correction into an eval-ready label", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    // a rebound credited to Merrill, later corrected to Allen (the label) ...
    recordNbaPlayByPlayRevisions({
      gameId,
      capturedAt: "2026-04-21T23:41:00.000Z",
      actions: [
        { actionNumber: 416, actionType: "rebound", personId: 100, playerName: "S. Merrill", timeActual: "2026-04-21T23:40:30.000Z" },
        // ... and a non-rebound correction (a foul re-credit) that must be EXCLUDED for stat='rebound'
        { actionNumber: 500, actionType: "foul", personId: 700, playerName: "X. Foulguy" },
      ],
    });
    recordNbaPlayByPlayRevisions({
      gameId,
      capturedAt: "2026-04-21T23:55:00.000Z",
      actions: [
        { actionNumber: 416, actionType: "rebound", personId: 200, playerName: "J. Allen", timeActual: "2026-04-21T23:40:30.000Z" },
        { actionNumber: 500, actionType: "foul", personId: 701, playerName: "Y. Otherguy" },
      ],
    });

    expect(listNbaPbpRevisionGameIds()).toContain(gameId);
    const result = harvestMiscreditLabels({ gameIds: [gameId], stat: "rebound" });
    expect(result.netTransitions).toBe(2); // rebound 416 + foul 500
    expect(result.nonStatTransitions).toBe(1); // the foul is counted but not emitted
    expect(result.incidents).toHaveLength(1);
    const label = result.incidents[0]!;
    expect(label.creditedPlayer).toBe("S. Merrill");
    expect(label.rightfulPlayer).toBe("J. Allen");
    expect(label.stat).toBe("rebound");
    expect(label.utcTime).toBe("2026-04-21T23:40:30.000Z");
    expect(label.correctionLatencySec).toBe(14 * 60); // 23:41 -> 23:55
    expect(label.id).toBe("harvested-nba-bos-nyk-2026-04-21-416");
  });

  it("harvestMiscreditLabels drops a flip that cancels back to the original credit", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    // Merrill -> Allen -> Merrill: net credit unchanged, so NOT a label
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:41:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 100, playerName: "S. Merrill" }] });
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:50:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 200, playerName: "J. Allen" }] });
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:55:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 100, playerName: "S. Merrill" }] });
    const result = harvestMiscreditLabels({ gameIds: [gameId], stat: "rebound" });
    expect(result.incidents).toHaveLength(0);
  });

  it("harvestMiscreditLabels never emits a self-label when only the person_id disappears", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    // a feed glitch: same player NAME, person_id dropped to null. NOT a real
    // correction — must not become creditedPlayer === rightfulPlayer.
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:41:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 100, playerName: "S. Merrill" }] });
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:55:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: null, playerName: "S. Merrill" }] });
    const result = harvestMiscreditLabels({ gameIds: [gameId], stat: "rebound" });
    expect(result.incidents).toHaveLength(0);
  });

  it("harvestMiscreditLabels emits a TEAM->player correction with credited=TEAM", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    // live-credited to the TEAM (no person_id, no player_name), later corrected to a player.
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:41:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: null, playerName: null, timeActual: "2026-04-21T23:40:30.000Z" }] });
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:55:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 200, playerName: "J. Allen", timeActual: "2026-04-21T23:40:30.000Z" }] });
    const result = harvestMiscreditLabels({ gameIds: [gameId], stat: "rebound" });
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]!.creditedPlayer).toBe("TEAM");
    expect(result.incidents[0]!.rightfulPlayer).toBe("J. Allen");
  });

  it("harvestMiscreditLabels drops a player->TEAM correction (no named rightful to score)", () => {
    seedLiveRepositoryGame();
    const gameId = "nba-bos-nyk-2026-04-21";
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:41:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: 200, playerName: "J. Allen" }] });
    recordNbaPlayByPlayRevisions({ gameId, capturedAt: "2026-04-21T23:55:00.000Z", actions: [{ actionNumber: 416, actionType: "rebound", personId: null, playerName: null }] });
    const result = harvestMiscreditLabels({ gameIds: [gameId], stat: "rebound" });
    expect(result.incidents).toHaveLength(0);
  });

  it("ignores scheduled regressions after a game has started or finished", () => {
    seedLiveRepositoryGame();
    const db = getDatabase();
    const initialCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_states WHERE game_id = 'nba-bos-nyk-2026-04-21'",
          )
          .get() as { count: number }
      ).count,
    );

    const regressedInPlay = recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-04-22T12:00:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-bos-nyk-2026-04-21",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });

    expect(regressedInPlay.wrote).toBe(false);
    expect(regressedInPlay.reason).toBe("regressed");
    expect(getResearchGame("nba-bos-nyk-2026-04-21")?.gameState?.status).toBe("in-play");

    recordGameStateObservation({
      awayScore: 101,
      capturedAt: "2026-04-22T02:10:00.000Z",
      clock: null,
      finalAt: "2026-04-22T02:10:00.000Z",
      gameId: "nba-bos-nyk-2026-04-21",
      homeScore: 108,
      isFinal: true,
      period: 4,
      startedAt: "2026-04-21T23:05:00.000Z",
      status: "final",
    });

    const regressedFinal = recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-04-22T12:30:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-bos-nyk-2026-04-21",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });

    const finalCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_states WHERE game_id = 'nba-bos-nyk-2026-04-21'",
          )
          .get() as { count: number }
      ).count,
    );

    expect(regressedFinal.wrote).toBe(false);
    expect(regressedFinal.reason).toBe("regressed");
    expect(getResearchGame("nba-bos-nyk-2026-04-21")?.gameState?.status).toBe("final");
    expect(finalCount).toBe(initialCount + 1);
  });

  it("prefers stronger game states over later stale scheduled rows already in storage", () => {
    seedLiveRepositoryGame();
    upsertGameOutcome({
      capturedAt: "2026-04-22T02:10:00.000Z",
      finalAwayScore: 101,
      finalHomeScore: 108,
      gameId: "nba-bos-nyk-2026-04-21",
      winnerKey: "bos",
    });
    recordGameStateObservation({
      awayScore: 101,
      capturedAt: "2026-04-22T02:10:00.000Z",
      clock: null,
      finalAt: "2026-04-22T02:10:00.000Z",
      gameId: "nba-bos-nyk-2026-04-21",
      homeScore: 108,
      isFinal: true,
      period: 4,
      startedAt: "2026-04-21T23:05:00.000Z",
      status: "final",
    });

    getDatabase()
      .prepare(
        `
          INSERT INTO game_states (
            game_id,
            captured_at,
            status,
            period,
            clock,
            home_score,
            away_score,
            is_final,
            started_at,
            final_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "nba-bos-nyk-2026-04-21",
        "2026-04-22T12:30:00.000Z",
        "scheduled",
        0,
        null,
        null,
        null,
        0,
        null,
        null,
      );

    const game = getResearchGame("nba-bos-nyk-2026-04-21");

    expect(game?.gameState?.status).toBe("final");
    expect(game?.gameState?.homeScore).toBe(108);
    expect(game?.outcome?.winnerKey).toBe("bos");
  });

  it("filters stale past-scheduled ghost games out of tracked game listings", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "GHO",
        key: "ghost-away",
        name: "Ghost Away",
        shortName: "Ghost Away",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "GST",
        key: "ghost-home",
        name: "Ghost Home",
        shortName: "Ghost Home",
        side: "home",
      },
      id: "nba-ghost-scheduled-game",
      league: "NBA",
      scheduledStart: "2026-04-20T00:00:00.000Z",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-04-19T12:00:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-ghost-scheduled-game",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });

    seedLiveRepositoryGame();

    const gameIds = listResearchGames({
      date: "2026-04-20",
      league: "NBA",
      referenceNow: "2026-04-22T12:00:00.000Z",
      scope: "all",
      sport: "basketball",
    }).map((card) => card.game.id);

    expect(gameIds).not.toContain("nba-ghost-scheduled-game");
  });

  it("keeps past scheduled games visible when they already have real market coverage", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "DET",
        key: "det",
        name: "Detroit Pistons",
        shortName: "Pistons",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "ORL",
        key: "orl",
        name: "Orlando Magic",
        shortName: "Magic",
        side: "home",
      },
      id: "nba-covered-scheduled-game",
      league: "NBA",
      scheduledStart: "2026-04-20T00:00:00.000Z",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-04-21T12:00:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-covered-scheduled-game",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });
    upsertMarketInstrument({
      displayLabel: "Magic moneyline",
      family: "moneyline",
      gameId: "nba-covered-scheduled-game",
      id: "magic-moneyline-covered",
      inPlay: false,
      line: null,
      participantKey: "orl",
      selection: "orl",
    });
    upsertSourceMarket({
      gameId: "nba-covered-scheduled-game",
      id: "sm-covered-magic-moneyline",
      instrumentId: "magic-moneyline-covered",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Magic moneyline",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "covered-magic-moneyline",
      sourceSelectionKey: "orl",
    });

    const gameIds = listResearchGames({
      date: "2026-04-20",
      league: "NBA",
      referenceNow: "2026-04-22T12:00:00.000Z",
      scope: "all",
      sport: "basketball",
    }).map((card) => card.game.id);

    expect(gameIds).toContain("nba-covered-scheduled-game");
  });

  it("filters past scheduled polymarket-only placeholders out of tracked game listings", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "MIN",
        key: "min",
        name: "Minnesota Timberwolves",
        shortName: "Timberwolves",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "SAS",
        key: "sas",
        name: "San Antonio Spurs",
        shortName: "Spurs",
        side: "home",
      },
      id: "nba-polymarket-placeholder-game",
      league: "NBA",
      scheduledStart: "2026-05-17T00:00:00.000Z",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-05-17T00:05:00.000Z",
      clock: null,
      finalAt: null,
      gameId: "nba-polymarket-placeholder-game",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });
    upsertMarketInstrument({
      displayLabel: "Timberwolves moneyline",
      family: "moneyline",
      gameId: "nba-polymarket-placeholder-game",
      id: "timberwolves-moneyline-placeholder",
      inPlay: false,
      line: null,
      participantKey: "min",
      selection: "min",
    });
    upsertSourceMarket({
      gameId: "nba-polymarket-placeholder-game",
      id: "sm-polymarket-placeholder-game",
      instrumentId: "timberwolves-moneyline-placeholder",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Timberwolves moneyline",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-placeholder-game",
      sourceSelectionKey: "min",
    });
    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-05-17T00:10:00.000Z",
      depthScore: null,
      impliedProbability: 0.61,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.61,
      sourceMarketId: "sm-polymarket-placeholder-game",
      volume: null,
    });

    const gameIds = listResearchGames({
      date: "2026-05-17",
      league: "NBA",
      referenceNow: "2026-05-20T12:00:00.000Z",
      scope: "all",
      sport: "basketball",
    }).map((card) => card.game.id);

    expect(gameIds).not.toContain("nba-polymarket-placeholder-game");
  });

  it("filters past scheduled games that only have orphaned instruments but no real source coverage", () => {
    upsertGame({
      awayParticipant: {
        abbreviation: "OKC",
        key: "okc",
        name: "Oklahoma City Thunder",
        shortName: "Thunder",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "PHX",
        key: "phx",
        name: "Phoenix Suns",
        shortName: "Suns",
        side: "home",
      },
      id: "nba-instrument-only-placeholder-game",
      league: "NBA",
      scheduledStart: "2026-04-29T00:00:00.000Z",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: null,
      capturedAt: "2026-05-10T18:21:17.506042+00:00",
      clock: null,
      finalAt: null,
      gameId: "nba-instrument-only-placeholder-game",
      homeScore: null,
      isFinal: false,
      period: 0,
      startedAt: null,
      status: "scheduled",
    });
    upsertMarketInstrument({
      displayLabel: "Thunder moneyline",
      family: "moneyline",
      gameId: "nba-instrument-only-placeholder-game",
      id: "thunder-moneyline-placeholder",
      inPlay: false,
      line: null,
      participantKey: "okc",
      selection: "okc",
    });

    const gameIds = listResearchGames({
      date: "2026-04-29",
      league: "NBA",
      referenceNow: "2026-05-20T12:00:00.000Z",
      scope: "all",
      sport: "basketball",
    }).map((card) => card.game.id);

    expect(gameIds).not.toContain("nba-instrument-only-placeholder-game");
  });

  it("dedupes unchanged quote captures and writes explicit heartbeats", () => {
    seedLiveRepositoryGame();

    const duplicateSameTimestamp = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:40:00.000Z",
      depthScore: 97,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.61,
      lineRaw: null,
      oddsRaw: "-156",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 100,
    });

    const duplicateSameTimestampDifferentShape = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:40:00.000Z",
      depthScore: 92,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.72,
      lineRaw: null,
      oddsRaw: "-257",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 180,
    });

    const deduped = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:40:30.000Z",
      depthScore: 97,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.61,
      lineRaw: null,
      oddsRaw: "-156",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 100,
    });

    const heartbeat = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:42:10.000Z",
      depthScore: 97,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.61,
      lineRaw: null,
      oddsRaw: "-156",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 100,
    });

    const changed = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:43:10.000Z",
      depthScore: 98,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.64,
      lineRaw: null,
      oddsRaw: "-178",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 100,
    });

    expect(duplicateSameTimestamp).toMatchObject({
      reason: "deduped",
      tick: {
        capturedAt: "2026-04-21T23:40:00.000Z",
        impliedProbability: 0.61,
      },
      wrote: false,
    });
    expect(duplicateSameTimestampDifferentShape).toMatchObject({
      reason: "deduped",
      tick: {
        capturedAt: "2026-04-21T23:40:00.000Z",
        impliedProbability: 0.61,
      },
      wrote: false,
    });
    expect(deduped).toMatchObject({
      reason: "deduped",
      wrote: false,
    });
    expect(heartbeat).toMatchObject({
      reason: "heartbeat",
      tick: {
        isHeartbeat: true,
      },
      wrote: true,
    });
    expect(changed).toMatchObject({
      reason: "changed",
      tick: {
        impliedProbability: 0.64,
        isHeartbeat: false,
      },
      wrote: true,
    });

    const timeline = getInstrumentTimeline("nba-bos-nyk-2026-04-21", "bos-moneyline");

    expect(timeline?.quoteSeriesBySource.bet365).toHaveLength(3);
    expect(timeline?.quoteSeriesBySource.bet365).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ isHeartbeat: true }),
        expect.objectContaining({
          impliedProbability: 0.64,
          isHeartbeat: false,
        }),
      ]),
    );
  });

  it("orders the default games list by live/current slate before old persisted history", () => {
    const liveSlateStart = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const currentSlateStart = new Date(Date.now() + 45 * 60_000).toISOString();

    upsertGame({
      awayParticipant: {
        key: "old-away",
        name: "Old Away",
        shortName: "Old Away",
        side: "away",
      },
      homeParticipant: {
        key: "old-home",
        name: "Old Home",
        shortName: "Old Home",
        side: "home",
      },
      id: "nba-old-history-game",
      league: "NBA",
      scheduledStart: "2025-10-25T00:00:00.000Z",
      sport: "basketball",
    });

    upsertGame({
      awayParticipant: {
        key: "live-away",
        name: "Live Away",
        shortName: "Live Away",
        side: "away",
      },
      homeParticipant: {
        key: "live-home",
        name: "Live Home",
        shortName: "Live Home",
        side: "home",
      },
      id: "nba-live-slate-game",
      league: "NBA",
      scheduledStart: liveSlateStart,
      sport: "basketball",
    });

    recordGameStateObservation({
      awayScore: 88,
      capturedAt: new Date().toISOString(),
      clock: "04:12",
      finalAt: null,
      gameId: "nba-live-slate-game",
      homeScore: 91,
      isFinal: false,
      period: 4,
      startedAt: liveSlateStart,
      status: "in-play",
    });

    recordGameStateObservation({
      awayScore: 1,
      capturedAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
      clock: "12:00",
      finalAt: null,
      gameId: "nba-live-slate-game",
      homeScore: 1,
      isFinal: false,
      period: 1,
      startedAt: liveSlateStart,
      status: "in-play",
    });

    upsertGame({
      awayParticipant: {
        key: "slate-away",
        name: "Slate Away",
        shortName: "Slate Away",
        side: "away",
      },
      homeParticipant: {
        key: "slate-home",
        name: "Slate Home",
        shortName: "Slate Home",
        side: "home",
      },
      id: "nba-current-slate-game",
      league: "NBA",
      scheduledStart: currentSlateStart,
      sport: "basketball",
    });

    expect(listResearchGames({ limit: 1 })[0]?.game.id).toBe("nba-live-slate-game");
    expect(listResearchGames({ limit: 1 })[0]?.gameState).toMatchObject({
      awayScore: 88,
      homeScore: 91,
    });
    expect(listResearchGames({ limit: 2 }).map((card) => card.game.id)).toEqual([
      "nba-live-slate-game",
      "nba-current-slate-game",
    ]);
    expect(listResearchGames({ date: "2025-10-25", limit: 1 })[0]?.game.id).toBe(
      "nba-old-history-game",
    );
  });

  it("does not let stale historical in-play state outrank an imminent game", () => {
    upsertGame({
      awayParticipant: {
        key: "old-away",
        name: "Old Away",
        shortName: "Old Away",
        side: "away",
      },
      homeParticipant: {
        key: "old-home",
        name: "Old Home",
        shortName: "Old Home",
        side: "home",
      },
      id: "nba-stale-in-play-history",
      league: "NBA",
      scheduledStart: "2026-04-21T23:00:00.000Z",
      sport: "basketball",
    });
    recordGameStateObservation({
      awayScore: 102,
      capturedAt: "2026-04-22T00:01:00.000Z",
      clock: "00:42",
      finalAt: null,
      gameId: "nba-stale-in-play-history",
      homeScore: 108,
      isFinal: false,
      period: 4,
      startedAt: "2026-04-21T23:05:00.000Z",
      status: "in-play",
    });

    upsertGame({
      awayParticipant: {
        key: "min",
        name: "Minnesota Timberwolves",
        shortName: "Timberwolves",
        side: "away",
      },
      homeParticipant: {
        key: "okc",
        name: "Oklahoma City Thunder",
        shortName: "Thunder",
        side: "home",
      },
      id: "nba-imminent-real-game",
      league: "NBA",
      scheduledStart: "2026-05-23T00:30:00.000Z",
      sport: "basketball",
    });

    const cards = listResearchGames({
      league: "NBA",
      limit: 3,
      referenceNow: "2026-05-23T00:26:00.000Z",
      sport: "basketball",
    });

    expect(cards.map((card) => card.game.id)).toEqual([
      "nba-imminent-real-game",
      "nba-stale-in-play-history",
    ]);
  });

  it("does not manufacture a top signal when no Bet365-vs-market comparison exists", () => {
    upsertGame({
      awayParticipant: {
        key: "phi",
        name: "Philadelphia 76ers",
        shortName: "76ers",
        side: "away",
      },
      homeParticipant: {
        key: "nyk",
        name: "New York Knicks",
        shortName: "Knicks",
        side: "home",
      },
      id: "nba-single-source-game",
      league: "NBA",
      scheduledStart: "2026-04-21T23:00:00.000Z",
      sport: "basketball",
    });

    upsertMarketInstrument({
      displayLabel: "76ers moneyline",
      family: "moneyline",
      gameId: "nba-single-source-game",
      id: "single-source-moneyline",
      inPlay: false,
      line: null,
      participantKey: "phi",
      selection: "phi",
    });
    upsertSourceMarket({
      gameId: "nba-single-source-game",
      id: "sm-polymarket-phi-moneyline",
      instrumentId: "single-source-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Philadelphia",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-phi-ml",
      sourceSelectionKey: "phi",
    });
    recordQuoteObservation({
      bestAsk: 0.44,
      bestBid: 0.43,
      capturedAt: "2026-04-21T23:40:00.000Z",
      depthScore: 80,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.44,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.44,
      sourceMarketId: "sm-polymarket-phi-moneyline",
      volume: 12,
    });

    const singleSourceCard = listResearchGames({ date: "2026-04-21" }).find(
      (card) => card.game.id === "nba-single-source-game",
    );

    expect(singleSourceCard).toMatchObject({
      activeInstrumentCount: 1,
    });
    expect(singleSourceCard?.topDivergences).toEqual([]);
  });

  it("counts storage coverage without multiplying quote ticks by raw payloads", () => {
    seedLiveRepositoryGame();

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:41:00.000Z",
      depthScore: 98,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.63,
      lineRaw: null,
      oddsRaw: "-170",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline",
      volume: 101,
    });
    recordRawPayload({
      capturedAt: "2026-04-21T23:40:00.000Z",
      contentHash: "raw-bet365-moneyline-1",
      entityId: "sm-bet365-bos-moneyline",
      entityType: "source_market",
      payloadJson: { price: "-156" },
      source: "bet365",
    });
    recordRawPayload({
      capturedAt: "2026-04-21T23:41:00.000Z",
      contentHash: "raw-bet365-moneyline-2",
      entityId: "sm-bet365-bos-moneyline",
      entityType: "source_market",
      payloadJson: { price: "-170" },
      source: "bet365",
    });

    expect(
      getStorageCoverage().find(
        (row) =>
          row.source === "bet365" &&
          row.gameId === "nba-bos-nyk-2026-04-21" &&
          row.family === "moneyline",
      ),
    ).toMatchObject({
      quoteTickCount: 2,
      rawPayloadCount: 2,
      sourceMarketCount: 1,
    });
  });

  it("classifies spread line mismatches separately from like-for-like comparable markets", () => {
    seedLiveRepositoryGame();

    const markets = listGameMarkets("nba-bos-nyk-2026-04-21");
    const moneyline = markets.find((market) => market.instrument.id === "bos-moneyline");
    const spread = markets.find((market) => market.instrument.id === "bos-spread-4_5");

    expect(moneyline).toMatchObject({
      comparableState: "comparable",
      lineMismatch: false,
    });
    expect(spread).toMatchObject({
      comparableState: "line-mismatch",
      lineMismatch: true,
    });
  });

  it("canonicalizes team source labels when provider selection keys are display text", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston Celtics",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "b365-bos-ml",
      sourceSelectionKey: null,
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kal-bos-ml",
      sourceSelectionKey: null,
    });

    const moneyline = listGameMarkets("nba-bos-nyk-2026-04-21").find(
      (market) => market.instrument.id === "bos-moneyline",
    );

    expect(moneyline).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: expect.closeTo(0.07, 5),
      lineMismatch: false,
    });
    expect(listResearchDivergence({ date: "2026-04-21" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Boston moneyline",
          impliedProbabilityGap: expect.closeTo(0.07, 5),
        }),
      ]),
    );
  });

  it("fails closed when source mappings point at different selections on the same instrument", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "NYK win",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kal-nyk-ml",
      sourceSelectionKey: "nyk",
    });

    const markets = listGameMarkets("nba-bos-nyk-2026-04-21");
    const moneyline = markets.find((market) => market.instrument.id === "bos-moneyline");

    expect(moneyline).toMatchObject({
      comparableState: "selection-mismatch",
      impliedProbabilityGap: null,
      lineMismatch: false,
    });
    expect(
      getInstrumentComparison("nba-bos-nyk-2026-04-21", "bos-moneyline")?.derivedComparison,
    ).toMatchObject({
      comparableState: "selection-mismatch",
      impliedProbabilityGap: null,
    });
    expect(
      listResearchDivergence({ date: "2026-04-21" }).some(
        (row) => row.instrumentId === "bos-moneyline",
      ),
    ).toBe(false);
  });

  it("anchors latest divergence on Bet365 versus exchange sources", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bos-ml",
      sourceSelectionKey: "bos",
    });
    recordQuoteObservation({
      bestAsk: 0.11,
      bestBid: 0.1,
      capturedAt: "2026-04-21T23:40:06.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.1,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.1,
      sourceMarketId: "sm-polymarket-bos-moneyline",
      volume: 40,
    });

    const moneyline = listGameMarkets("nba-bos-nyk-2026-04-21").find(
      (market) => market.instrument.id === "bos-moneyline",
    );

    expect(moneyline).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: expect.closeTo(0.51, 5),
    });
    expect(moneyline?.impliedProbabilityGap).not.toBeCloseTo(0.58, 5);

    upsertMarketInstrument({
      displayLabel: "New York moneyline external only",
      family: "moneyline",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "nyk-moneyline-external-only",
      inPlay: true,
      line: null,
      participantKey: "nyk",
      selection: "nyk",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-nyk-moneyline",
      instrumentId: "nyk-moneyline-external-only",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "NYK wins",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kal-nyk-ml",
      sourceSelectionKey: "nyk",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-nyk-moneyline",
      instrumentId: "nyk-moneyline-external-only",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "NYK wins",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-nyk-ml",
      sourceSelectionKey: "nyk",
    });
    recordQuoteObservation({
      bestAsk: 0.9,
      bestBid: 0.89,
      capturedAt: "2026-04-21T23:40:06.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.9,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.9,
      sourceMarketId: "sm-kalshi-nyk-moneyline",
      volume: 40,
    });
    recordQuoteObservation({
      bestAsk: 0.1,
      bestBid: 0.09,
      capturedAt: "2026-04-21T23:40:07.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.1,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.1,
      sourceMarketId: "sm-polymarket-nyk-moneyline",
      volume: 40,
    });

    expect(
      listGameMarkets("nba-bos-nyk-2026-04-21").find(
        (market) => market.instrument.id === "nyk-moneyline-external-only",
      ),
    ).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: null,
    });
    expect(
      listResearchDivergence({}).some((row) => row.instrumentId === "nyk-moneyline-external-only"),
    ).toBe(false);
  });

  it("requires player-prop source labels to match the canonical player and outcome", () => {
    seedLiveRepositoryGame();

    upsertMarketInstrument({
      displayLabel: "Victor Wembanyama over 0.5 steals",
      family: "player-prop",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "wemby-steals-over",
      inPlay: true,
      line: 0.5,
      participantKey: "victor-wembanyama",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-wemby-steals",
      instrumentId: "wemby-steals-over",
      mappingStatus: "auto",
      rawFamily: "steals",
      rawLabel: "Victor Wembanyama (1) (0.5)",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "bet365-wemby-steals",
      sourceSelectionKey: "victor-wembanyama-over",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-wemby-steals",
      instrumentId: "wemby-steals-over",
      mappingStatus: "auto",
      rawFamily: "steals",
      rawLabel: "Victor Wembanyama: 1+ steals",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kalshi-wemby-steals",
      sourceSelectionKey: "over",
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:41:00.000Z",
      depthScore: 90,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.71,
      lineRaw: 0.5,
      oddsRaw: "1.40",
      priceRaw: 1.4,
      sourceMarketId: "sm-bet365-wemby-steals",
      volume: 100,
    });
    recordQuoteObservation({
      bestAsk: 0.73,
      bestBid: 0.72,
      capturedAt: "2026-04-21T23:41:05.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.73,
      lineRaw: 0.5,
      oddsRaw: null,
      priceRaw: 0.73,
      sourceMarketId: "sm-kalshi-wemby-steals",
      volume: 40,
    });

    expect(
      listGameMarkets("nba-bos-nyk-2026-04-21").find(
        (market) => market.instrument.id === "wemby-steals-over",
      ),
    ).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: expect.closeTo(0.02, 5),
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-lebron-steals",
      instrumentId: "wemby-steals-over",
      mappingStatus: "auto",
      rawFamily: "steals",
      rawLabel: "LeBron James: 1+ steals",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kalshi-lebron-steals",
      sourceSelectionKey: "over",
    });
    recordQuoteObservation({
      bestAsk: 0.55,
      bestBid: 0.54,
      capturedAt: "2026-04-21T23:41:10.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.55,
      lineRaw: 0.5,
      oddsRaw: null,
      priceRaw: 0.55,
      sourceMarketId: "sm-kalshi-lebron-steals",
      volume: 40,
    });

    expect(
      listGameMarkets("nba-bos-nyk-2026-04-21").find(
        (market) => market.instrument.id === "wemby-steals-over",
      ),
    ).toMatchObject({
      comparableState: "selection-mismatch",
      impliedProbabilityGap: null,
    });
  });

  it("treats accented and punctuation-bearing player labels as the same canonical player in live comparisons", () => {
    seedLiveRepositoryGame();

    upsertMarketInstrument({
      displayLabel: "Nikola Jokic over 9.5 assists",
      family: "player-prop",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "jokic-assists-over",
      inPlay: true,
      line: 9.5,
      participantKey: "nikola-jokic",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-jokic-assists",
      instrumentId: "jokic-assists-over",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Nikola Jokić: Assists O/U 9.5",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "bet365-jokic-assists",
      sourceSelectionKey: "nikola-jokic-over",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-jokic-assists",
      instrumentId: "jokic-assists-over",
      mappingStatus: "auto",
      rawFamily: "assists",
      rawLabel: "Nikola Jokic over 9.5 assists",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-jokic-assists",
      sourceSelectionKey: "over",
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:41:00.000Z",
      depthScore: 90,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.68,
      lineRaw: 9.5,
      oddsRaw: "1.47",
      priceRaw: 1.47,
      sourceMarketId: "sm-bet365-jokic-assists",
      volume: 100,
    });
    recordQuoteObservation({
      bestAsk: 0.71,
      bestBid: 0.7,
      capturedAt: "2026-04-21T23:41:05.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.71,
      lineRaw: 9.5,
      oddsRaw: null,
      priceRaw: 0.71,
      sourceMarketId: "sm-polymarket-jokic-assists",
      volume: 40,
    });

    expect(
      listGameMarkets("nba-bos-nyk-2026-04-21").find(
        (market) => market.instrument.id === "jokic-assists-over",
      ),
    ).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: expect.closeTo(0.03, 5),
    });

    upsertMarketInstrument({
      displayLabel: "Royce ONeale over 3.5 rebounds",
      family: "player-prop",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "oneale-rebounds-over",
      inPlay: true,
      line: 3.5,
      participantKey: "royce-oneale",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-oneale-rebounds",
      instrumentId: "oneale-rebounds-over",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Royce O'Neale: Rebounds O/U 3.5",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "bet365-oneale-rebounds",
      sourceSelectionKey: "royce-oneale-over",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-kalshi-oneale-rebounds",
      instrumentId: "oneale-rebounds-over",
      mappingStatus: "auto",
      rawFamily: "rebounds",
      rawLabel: "Royce ONeale: 4+ rebounds",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kalshi-oneale-rebounds",
      sourceSelectionKey: "over",
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:42:00.000Z",
      depthScore: 90,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.55,
      lineRaw: 3.5,
      oddsRaw: "1.82",
      priceRaw: 1.82,
      sourceMarketId: "sm-bet365-oneale-rebounds",
      volume: 100,
    });
    recordQuoteObservation({
      bestAsk: 0.58,
      bestBid: 0.57,
      capturedAt: "2026-04-21T23:42:05.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.58,
      lineRaw: 3.5,
      oddsRaw: null,
      priceRaw: 0.58,
      sourceMarketId: "sm-kalshi-oneale-rebounds",
      volume: 40,
    });

    expect(
      listGameMarkets("nba-bos-nyk-2026-04-21").find(
        (market) => market.instrument.id === "oneale-rebounds-over",
      ),
    ).toMatchObject({
      comparableState: "comparable",
      impliedProbabilityGap: expect.closeTo(0.03, 5),
    });
  });

  it("dedupes duplicate source markets down to one latest source view and raw source selection", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-bos-moneyline-alt",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "Alternative Moneyline",
      rawLabel: "Boston Celtics",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "b365-bos-ml-alt",
      sourceSelectionKey: "bos",
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:41:30.000Z",
      depthScore: 99,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.64,
      lineRaw: null,
      oddsRaw: "-178",
      priceRaw: null,
      sourceMarketId: "sm-bet365-bos-moneyline-alt",
      volume: 104,
    });

    const comparison = getInstrumentComparison("nba-bos-nyk-2026-04-21", "bos-moneyline");

    expect(
      comparison?.latestQuotesBySource.filter((quote) => quote.source === "bet365"),
    ).toHaveLength(1);
    expect(comparison?.latestQuotesBySource).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          impliedProbability: 0.64,
          source: "bet365",
          sourceMarketId: "sm-bet365-bos-moneyline-alt",
        }),
        expect.objectContaining({
          impliedProbability: 0.68,
          source: "kalshi",
        }),
      ]),
    );

    expect(
      getInstrumentRawSource("nba-bos-nyk-2026-04-21", "bos-moneyline", "bet365"),
    ).toMatchObject({
      parserOutput: {
        impliedProbability: 0.64,
        odds: "-178",
      },
      sourceMarket: {
        id: "sm-bet365-bos-moneyline-alt",
      },
    });
  });

  it("surfaces unmapped orphan source markets in research coverage", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-poly-brunson-points",
      instrumentId: null,
      mappingStatus: "unmapped",
      rawFamily: "player-prop",
      rawLabel: "Jalen Brunson over 29.5 points",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-brunson-points",
      sourceSelectionKey: "over",
    });

    const coverage = getResearchCoverage().filter((row) => row.gameId === "nba-bos-nyk-2026-04-21");

    expect(coverage.find((row) => row.instrumentId == null && row.family == null)).toMatchObject({
      unmappedSources: ["polymarket"],
    });
    expect(
      coverage.find((row) => row.instrumentId == null && row.family === "player-prop"),
    ).toMatchObject({
      availableSources: ["polymarket"],
      missingSources: ["bet365", "fanduel", "draftkings", "kalshi"],
      unmappedSources: ["polymarket"],
    });
  });

  it("builds historical signal mismatches with game context from latest source views", () => {
    seedLiveRepositoryGame();

    upsertGameOutcome({
      capturedAt: "2026-04-22T00:05:00.000Z",
      finalAwayScore: 110,
      finalHomeScore: 118,
      gameId: "nba-bos-nyk-2026-04-21",
      winnerKey: "bos",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bos-ml",
      sourceSelectionKey: "bos",
    });

    recordQuoteObservation({
      bestAsk: 0.5,
      bestBid: 0.49,
      capturedAt: "2026-04-21T23:40:20.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.48,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.48,
      sourceMarketId: "sm-polymarket-bos-moneyline",
      volume: 31,
    });

    recordQuoteObservation({
      bestAsk: 0.5,
      bestBid: 0.49,
      capturedAt: "2026-04-21T23:40:25.000Z",
      depthScore: 81,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.49,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.49,
      sourceMarketId: "sm-kalshi-bos-moneyline",
      volume: 40,
    });

    recordQuoteObservation({
      bestAsk: 0.02,
      bestBid: 0.01,
      capturedAt: "2026-04-22T04:30:25.000Z",
      depthScore: 81,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.01,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.01,
      sourceMarketId: "sm-kalshi-bos-moneyline",
      volume: 40,
    });

    expect(listSignalMismatches()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bet365ImpliedProbability: 0.61,
          directionalDisagreement: true,
          displayLabel: "Boston moneyline",
          finalAwayScore: 110,
          finalHomeScore: 118,
          gameLabel: "Knicks at Celtics",
          gameStatus: "final",
          kalshiImpliedProbability: 0.49,
          polymarketImpliedProbability: 0.48,
          scheduledStart: "2026-04-21T23:00:00.000Z",
        }),
      ]),
    );
    expect(listSignalMismatches({ date: "2026-04-21" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Boston moneyline",
          scheduledStart: "2026-04-21T23:00:00.000Z",
        }),
      ]),
    );
    expect(listSignalMismatches({ date: "2026-04-22" })).toEqual([]);

    upsertGame({
      awayParticipant: {
        abbreviation: "LAL",
        key: "lal",
        name: "Los Angeles Lakers",
        shortName: "Lakers",
        side: "away",
      },
      homeParticipant: {
        abbreviation: "DEN",
        key: "den",
        name: "Denver Nuggets",
        shortName: "Nuggets",
        side: "home",
      },
      id: "nba-lal-den-2026-04-21",
      league: "NBA",
      scheduledStart: "2026-04-21T21:00:00.000Z",
      sourceGameKeyNba: "0022600003",
      sport: "basketball",
    });
    upsertMarketInstrument({
      displayLabel: "Denver moneyline",
      family: "moneyline",
      gameId: "nba-lal-den-2026-04-21",
      id: "den-moneyline",
      inPlay: true,
      line: null,
      participantKey: "den",
      selection: "den",
    });
    upsertSourceMarket({
      gameId: "nba-lal-den-2026-04-21",
      id: "sm-bet365-den-moneyline",
      instrumentId: "den-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Denver Nuggets",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "b365-den-ml",
      sourceSelectionKey: "den",
    });
    upsertSourceMarket({
      gameId: "nba-lal-den-2026-04-21",
      id: "sm-kalshi-den-moneyline",
      instrumentId: "den-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "DEN win",
      rawMetadata: { source: "kalshi" },
      source: "kalshi",
      sourceMarketKey: "kal-den-ml",
      sourceSelectionKey: "den",
    });
    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T21:40:00.000Z",
      depthScore: 92,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.72,
      lineRaw: null,
      oddsRaw: "-257",
      priceRaw: null,
      sourceMarketId: "sm-bet365-den-moneyline",
      volume: 55,
    });
    recordQuoteObservation({
      bestAsk: 0.43,
      bestBid: 0.42,
      capturedAt: "2026-04-21T21:40:05.000Z",
      depthScore: 73,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.42,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.42,
      sourceMarketId: "sm-kalshi-den-moneyline",
      volume: 33,
    });

    const denOnlyRows = listSignalMismatches({
      date: "2026-04-21",
      gameId: "nba-lal-den-2026-04-21",
    });
    expect(denOnlyRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Denver moneyline",
          gameId: "nba-lal-den-2026-04-21",
        }),
      ]),
    );
    expect(denOnlyRows.every((row) => row.gameId === "nba-lal-den-2026-04-21")).toBe(true);
  });

  it("applies signal mismatch limits after filtering non-mismatches", () => {
    seedLiveRepositoryGame();

    recordQuoteObservation({
      bestAsk: 0.5,
      bestBid: 0.49,
      capturedAt: "2026-04-21T23:40:30.000Z",
      depthScore: 66,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.49,
      lineRaw: -5.5,
      oddsRaw: null,
      priceRaw: 0.49,
      sourceMarketId: "sm-kalshi-bos-spread",
      volume: 29,
    });

    expect(listSignalMismatches({ limit: 1 })).toEqual([
      expect.objectContaining({
        directionalDisagreement: true,
        displayLabel: "Boston -4.5",
      }),
    ]);
  });

  it("scores off-price prediction-market prints by volume share instead of raw notional alone", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { conditionId: "condition-bos", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bos-moneyline",
      sourceSelectionKey: "bos",
    });

    recordQuoteObservation({
      bestAsk: 0.51,
      bestBid: 0.49,
      capturedAt: "2026-04-21T23:39:50.000Z",
      depthScore: 70,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.5,
      lineRaw: null,
      oddsRaw: null,
      priceRaw: 0.5,
      sourceMarketId: "sm-polymarket-bos-moneyline",
      volume: 25,
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:40:38.000Z",
      eventType: "trade" as const,
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      notional: 105.66,
      previousPrice: 0.51,
      price: 0.51,
      rawMetadata: {
        outcome: "Yes",
        transactionHash: "0xtrade",
        wallet: "0xwallet",
      },
      size: 106.7913,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-bos-moneyline",
      tradePrice: 0.99,
      volumeShare: 106.7913 / 410.166918,
    });

    const alerts = listMarketAnomalyAlerts({
      includeUnmapped: true,
      minScore: 40,
      now: "2026-04-21T23:45:00.000Z",
      requireBet365: false,
    });

    expect(alerts[0]).toMatchObject({
      apiSurface: "data-api/trades",
      displayLabel: "Boston moneyline",
      labels: expect.arrayContaining(["isolated off-price print", "volume-share anomaly"]),
      metrics: expect.objectContaining({
        notional: 105.66,
        tradeDistance: expect.closeTo(0.48, 6),
        tradePrice: 0.99,
        volumeShare: expect.closeTo(0.26036, 4),
      }),
      source: "polymarket",
    });
    expect(alerts[0]?.score).toBeGreaterThanOrEqual(60);
  });

  it("keeps same-second same-size trades separate when transaction hashes differ", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { conditionId: "condition-bos", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bos-moneyline",
      sourceSelectionKey: "bos",
    });

    const base = {
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:40:38.000Z",
      eventType: "trade" as const,
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      notional: 10,
      price: 0.99,
      size: 10,
      source: "polymarket" as const,
      sourceMarketId: "sm-polymarket-bos-moneyline",
      tradePrice: 0.99,
      volumeShare: 10 / 410.166918,
    };
    recordMarketMicrostructureEvent({
      ...base,
      rawMetadata: { transactionHash: "0xtrade-a" },
    });
    recordMarketMicrostructureEvent({
      ...base,
      rawMetadata: { transactionHash: "0xtrade-b" },
    });

    expect(
      getDatabase().prepare("SELECT COUNT(*) AS count FROM market_microstructure_events").get(),
    ).toEqual({ count: 2 });
  });

  it("ignores impossible volume-share ratios instead of letting bad denominators dominate alerts", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bad-volume-share",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { conditionId: "condition-bos", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bad-volume-share",
      sourceSelectionKey: "bos",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:40:38.000Z",
      eventType: "trade",
      finalMarketVolume: 10,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      notional: 500,
      size: 909.09,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-bad-volume-share",
      tradePrice: 0.55,
      volumeShare: 90.9,
    });

    expect(
      listMarketAnomalyAlerts({
        includeUnmapped: true,
        minScore: 10,
        now: "2026-04-21T23:45:00.000Z",
        requireBet365: false,
      }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceMarketId: "sm-polymarket-bad-volume-share",
        }),
      ]),
    );
  });

  it("keeps candle-only evidence lower confidence than trade-level anomaly rows", () => {
    seedLiveRepositoryGame();

    recordMarketMicrostructureEvent({
      apiSurface: "candlestick",
      eventTimestamp: "2026-04-21T23:41:00.000Z",
      eventType: "candlestick",
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      previousPrice: 0.44,
      price: 0.99,
      source: "kalshi",
      sourceMarketId: "sm-kalshi-bos-moneyline",
      volume: 1000,
    });

    const alerts = listMarketAnomalyAlerts({
      includeUnmapped: true,
      minConfidence: 0.5,
      minScore: 10,
      now: "2026-04-21T23:45:00.000Z",
    });

    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          apiSurface: "candlestick",
          confidence: expect.closeTo(0.57, 1),
          eventType: "candlestick",
          labels: expect.arrayContaining(["sustained repricing"]),
        }),
      ]),
    );
  });

  it("keeps unmapped market weirdness visible unless the operator filters it out", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-unmapped-reaves",
      instrumentId: null,
      mappingStatus: "unmapped",
      rawFamily: "player-prop",
      rawLabel: "Austin Reaves rebounds O/U 4.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-reaves-rebounds",
      sourceSelectionKey: "over",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:40:38.000Z",
      eventType: "trade",
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: null,
      previousPrice: 0.51,
      size: 106.7913,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-unmapped-reaves",
      tradePrice: 0.99,
      volumeShare: 0.26,
    });

    expect(
      listMarketAnomalyAlerts({
        includeUnmapped: true,
        minConfidence: 0.4,
        minScore: 40,
        now: "2026-04-21T23:45:00.000Z",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Austin Reaves rebounds O/U 4.5",
          labels: expect.arrayContaining(["coverage gap"]),
          mappingStatus: "unmapped",
        }),
      ]),
    );

    expect(
      listMarketAnomalyAlerts({
        includeUnmapped: false,
        minConfidence: 0.4,
        minScore: 40,
        now: "2026-04-21T23:45:00.000Z",
      }),
    ).toEqual([]);
  });

  it("keeps stale active-game anomaly prints out of the live queue", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-stale-bos-moneyline",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { conditionId: "condition-bos", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-stale-bos-moneyline",
      sourceSelectionKey: "bos",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:40:38.000Z",
      eventType: "trade",
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      notional: 105.66,
      previousPrice: 0.51,
      price: 0.51,
      size: 106.7913,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-stale-bos-moneyline",
      tradePrice: 0.99,
      volumeShare: 106.7913 / 410.166918,
    });

    expect(
      listMarketAnomalyAlerts({
        includeUnmapped: true,
        minConfidence: 0.4,
        minScore: 40,
        now: "2026-04-22T00:15:00.000Z",
      }),
    ).toEqual([]);

    expect(
      listMarketAnomalyAlerts({
        includeHistorical: true,
        includeUnmapped: true,
        minConfidence: 0.4,
        minScore: 40,
        now: "2026-04-22T00:15:00.000Z",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Boston moneyline",
          source: "polymarket",
        }),
      ]),
    );
  });

  it("preserves requireBet365 filtering while scoring live anomaly candidates", () => {
    seedLiveRepositoryGame();

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-bos-moneyline-require-bet365",
      instrumentId: "bos-moneyline",
      mappingStatus: "auto",
      rawFamily: "moneyline",
      rawLabel: "Boston wins",
      rawMetadata: { conditionId: "condition-bos", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-bos-moneyline-require-bet365",
      sourceSelectionKey: "bos",
    });
    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-polymarket-unmapped-require-bet365",
      instrumentId: null,
      mappingStatus: "unmapped",
      rawFamily: "player-prop",
      rawLabel: "Unmapped scorer prop",
      rawMetadata: { conditionId: "condition-unmapped", source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-unmapped-require-bet365",
      sourceSelectionKey: "over",
    });

    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:41:38.000Z",
      eventType: "trade",
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: "bos-moneyline",
      notional: 105.66,
      previousPrice: 0.51,
      price: 0.51,
      size: 106.7913,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-bos-moneyline-require-bet365",
      tradePrice: 0.99,
      volumeShare: 106.7913 / 410.166918,
    });
    recordMarketMicrostructureEvent({
      apiSurface: "data-api/trades",
      eventTimestamp: "2026-04-21T23:41:39.000Z",
      eventType: "trade",
      finalMarketVolume: 410.166918,
      gameId: "nba-bos-nyk-2026-04-21",
      instrumentId: null,
      notional: 105.66,
      previousPrice: 0.51,
      price: 0.51,
      size: 106.7913,
      source: "polymarket",
      sourceMarketId: "sm-polymarket-unmapped-require-bet365",
      tradePrice: 0.99,
      volumeShare: 106.7913 / 410.166918,
    });

    const withoutBet365Requirement = listMarketAnomalyAlerts({
      includeUnmapped: true,
      minConfidence: 0.4,
      minScore: 40,
      now: "2026-04-21T23:45:00.000Z",
      requireBet365: false,
    });
    expect(withoutBet365Requirement).toEqual(
      expect.arrayContaining([expect.objectContaining({ displayLabel: "Unmapped scorer prop" })]),
    );

    const requiringBet365 = listMarketAnomalyAlerts({
      includeUnmapped: true,
      minConfidence: 0.4,
      minScore: 40,
      now: "2026-04-21T23:45:00.000Z",
      requireBet365: true,
    });
    expect(requiringBet365).toEqual(
      expect.arrayContaining([expect.objectContaining({ displayLabel: "Boston moneyline" })]),
    );
    expect(requiringBet365).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ displayLabel: "Unmapped scorer prop" })]),
    );
  });

  it("persists tunable market anomaly scoring knobs", () => {
    expect(getMarketAnomalyScoreConfig()).toMatchObject({
      minScore: 45,
      toggles: {
        includeUnmapped: true,
        requireBet365: false,
      },
    });

    upsertMarketAnomalyScoreConfig({
      minScore: 70,
      profileId: "default",
      toggles: {
        includeHistorical: true,
        includeUnmapped: false,
        requireBet365: true,
      },
    });

    expect(getMarketAnomalyScoreConfig()).toMatchObject({
      minScore: 70,
      toggles: {
        includeHistorical: true,
        includeUnmapped: false,
        requireBet365: true,
      },
      updatedBy: "operator",
    });
  });

  it("surfaces fresh player-prop attribution alerts without using stale or non-prop mismatches", () => {
    seedLiveRepositoryGame();

    upsertMarketInstrument({
      displayLabel: "Jalen Brunson points over 29.5",
      family: "player-prop",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "brunson-points-over-29_5",
      inPlay: true,
      line: 29.5,
      participantKey: "jalen-brunson",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-brunson-points",
      instrumentId: "brunson-points-over-29_5",
      mappingStatus: "auto",
      rawFamily: "player-prop",
      rawLabel: "Jalen Brunson (29.5)",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "b365-brunson-points",
      sourceSelectionKey: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-poly-brunson-points",
      instrumentId: "brunson-points-over-29_5",
      mappingStatus: "auto",
      rawFamily: "player-prop",
      rawLabel: "Jalen Brunson: Points O/U 29.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-brunson-points",
      sourceSelectionKey: "over",
    });

    upsertMarketInstrument({
      displayLabel: "Tyrese Maxey points over 27.5",
      family: "player-prop",
      gameId: "nba-bos-nyk-2026-04-21",
      id: "maxey-points-over-27_5",
      inPlay: true,
      line: 27.5,
      participantKey: "tyrese-maxey",
      selection: "over",
    });

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-bet365-maxey-points",
      instrumentId: "maxey-points-over-27_5",
      mappingStatus: "auto",
      rawFamily: "player-prop",
      rawLabel: "Tyrese Maxey (27.5)",
      rawMetadata: { source: "bet365" },
      source: "bet365",
      sourceMarketKey: "b365-maxey-points",
      sourceSelectionKey: "over",
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:40:15.000Z",
      depthScore: 91,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.68,
      lineRaw: 29.5,
      oddsRaw: "-213",
      priceRaw: null,
      sourceMarketId: "sm-bet365-brunson-points",
      volume: 100,
    });

    recordQuoteObservation({
      bestAsk: 0.43,
      bestBid: 0.42,
      capturedAt: "2026-04-21T23:40:20.000Z",
      depthScore: 44,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.42,
      lineRaw: 29.5,
      oddsRaw: null,
      priceRaw: 0.42,
      sourceMarketId: "sm-poly-brunson-points",
      volume: 19,
    });

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:40:30.000Z",
      depthScore: 88,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.61,
      lineRaw: 27.5,
      oddsRaw: "-156",
      priceRaw: null,
      sourceMarketId: "sm-bet365-maxey-points",
      volume: 100,
    });

    const initialAlerts = listPlayerPropDisagreementAlerts({
      now: "2026-04-21T23:41:00.000Z",
    });
    const playerPropDivergence = listResearchDivergence({
      family: "player-prop",
      limit: 10,
      sort: "divergence",
    });
    expect(playerPropDivergence).toEqual([
      expect.objectContaining({
        displayLabel: "Jalen Brunson points over 29.5",
        family: "player-prop",
        impliedProbabilityGap: expect.closeTo(0.26, 6),
        sources: ["bet365", "polymarket"],
      }),
    ]);
    expect(playerPropDivergence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Tyrese Maxey points over 27.5",
        }),
      ]),
    );
    expect(initialAlerts).toEqual([
      expect.objectContaining({
        absoluteDelta: expect.closeTo(0.26, 6),
        action: "manual-review",
        bet365: expect.objectContaining({
          rawLabel: "Jalen Brunson (29.5)",
          source: "bet365",
        }),
        displayLabel: "Jalen Brunson points over 29.5",
        direction: "bet365-higher",
        predictionMarket: expect.objectContaining({
          rawLabel: "Jalen Brunson: Points O/U 29.5",
          source: "polymarket",
        }),
      }),
    ]);

    const initialAlertId = initialAlerts[0]?.id;

    recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: "2026-04-21T23:42:15.000Z",
      depthScore: 91,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.68,
      lineRaw: 29.5,
      oddsRaw: "-213",
      priceRaw: null,
      sourceMarketId: "sm-bet365-brunson-points",
      volume: 100,
    });

    recordQuoteObservation({
      bestAsk: 0.43,
      bestBid: 0.42,
      capturedAt: "2026-04-21T23:42:20.000Z",
      depthScore: 44,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.42,
      lineRaw: 29.5,
      oddsRaw: null,
      priceRaw: 0.42,
      sourceMarketId: "sm-poly-brunson-points",
      volume: 19,
    });

    const refreshedAlerts = listPlayerPropDisagreementAlerts({
      now: "2026-04-21T23:42:30.000Z",
    });
    expect(refreshedAlerts[0]).toMatchObject({
      detectedAt: "2026-04-21T23:42:20.000Z",
      id: initialAlertId,
    });

    expect(
      listPlayerPropDisagreementAlerts({
        now: "2026-04-22T00:30:00.000Z",
      }),
    ).toEqual([]);

    expect(
      listPlayerPropDisagreementAlerts({
        includeStale: true,
        now: "2026-04-22T00:30:00.000Z",
      }),
    ).toHaveLength(1);

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-poly-lebron-points-miswired",
      instrumentId: "brunson-points-over-29_5",
      mappingStatus: "auto",
      rawFamily: "player-prop",
      rawLabel: "LeBron James: Points O/U 29.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-lebron-points-miswired",
      sourceSelectionKey: "over",
    });
    recordQuoteObservation({
      bestAsk: 0.06,
      bestBid: 0.05,
      capturedAt: "2026-04-21T23:43:20.000Z",
      depthScore: 44,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.05,
      lineRaw: 29.5,
      oddsRaw: null,
      priceRaw: 0.05,
      sourceMarketId: "sm-poly-lebron-points-miswired",
      volume: 19,
    });

    expect(
      listPlayerPropDisagreementAlerts({
        now: "2026-04-21T23:43:30.000Z",
      }),
    ).toEqual([]);

    upsertSourceMarket({
      gameId: "nba-bos-nyk-2026-04-21",
      id: "sm-poly-brunson-points-wrong-line",
      instrumentId: "brunson-points-over-29_5",
      mappingStatus: "auto",
      rawFamily: "player-prop",
      rawLabel: "Jalen Brunson: Points O/U 30.5",
      rawMetadata: { source: "polymarket" },
      source: "polymarket",
      sourceMarketKey: "poly-brunson-points-wrong-line",
      sourceSelectionKey: "over",
    });
    recordQuoteObservation({
      bestAsk: 0.43,
      bestBid: 0.42,
      capturedAt: "2026-04-21T23:44:20.000Z",
      depthScore: 44,
      heartbeatAfterMs: 60_000,
      impliedProbability: 0.42,
      lineRaw: 30.5,
      oddsRaw: null,
      priceRaw: 0.42,
      sourceMarketId: "sm-poly-brunson-points-wrong-line",
      volume: 19,
    });

    expect(
      listPlayerPropDisagreementAlerts({
        now: "2026-04-21T23:44:30.000Z",
      }),
    ).toEqual([]);

    expect(
      listPlayerPropDisagreementAlerts({
        minDelta: 0.3,
        now: "2026-04-21T23:41:00.000Z",
      }),
    ).toEqual([]);
  });

  it("marks bet365 session exports invalid until the configured file exists", () => {
    const sessionStatePath = join(tempDir, "bet365-session-state.json");
    process.env.BET365_SESSION_STATE_PATH = sessionStatePath;

    expect(listAdminSources().find((source) => source.source === "bet365")).toMatchObject({
      authState: "invalid",
      bootstrapState: "invalid",
      configured: false,
      status: "error",
    });

    writeFileSync(sessionStatePath, JSON.stringify({ cookies: [] }));

    expect(listAdminSources().find((source) => source.source === "bet365")).toMatchObject({
      authState: "configured",
      bootstrapState: "ready",
      configured: true,
      status: "ok",
    });

    delete process.env.BET365_SESSION_STATE_PATH;
  });
});
