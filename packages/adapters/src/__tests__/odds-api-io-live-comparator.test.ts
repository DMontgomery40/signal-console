import { describe, expect, it } from "vitest";

import {
  ODDS_API_IO_NBA_MARKETS,
  ODDS_API_IO_SELECTED_BOOKMAKER_SPINE,
  applyOddsApiIoWebSocketMessage,
  buildOddsApiIoWebSocketUrl,
  classifyOddsApiIoMarketFamily,
  createInitialOddsApiIoWebSocketState,
  discoverOddsApiIoNbaLeagueSlugs,
  extractOddsApiIoBookmakerNames,
  fetchOddsApiIoBasketballLeagues,
  fetchOddsApiIoEventOddsSnapshot,
  fetchOddsApiIoNbaEvents,
  fetchOddsApiIoSelectedBookmakers,
  fetchOddsApiIoUpdatedDelta,
  redactOddsApiIoUrl,
  summarizeOddsApiIoCoverage,
  verifyOddsApiIoSelectedBookmakers,
} from "../odds-api-io-live-comparator";

function makeJsonResponse(
  payload: unknown,
  init?: { headers?: Record<string, string>; status?: number },
) {
  return {
    headers: {
      get: (name: string) => init?.headers?.[name] ?? init?.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => payload,
    ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
    status: init?.status ?? 200,
  } as Response;
}

describe("odds-api-io live comparator contract", () => {
  it("verifies the selected-bookmaker spine without leaking the API key", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return makeJsonResponse({
        bookmakers: ODDS_API_IO_SELECTED_BOOKMAKER_SPINE.map((name) => ({ name })),
      });
    }) as typeof fetch;

    const payload = await fetchOddsApiIoSelectedBookmakers({
      apiKey: "secret-key",
      baseUrl: "https://api.odds-api.io/v3",
      fetchImpl,
    });
    const selected = extractOddsApiIoBookmakerNames(payload);

    expect(verifyOddsApiIoSelectedBookmakers(selected)).toEqual({
      extra: [],
      missing: [],
      ok: true,
      selected: ["Bet365", "DraftKings", "FanDuel", "Kalshi", "Polymarket"],
    });
    expect(calls[0]).toContain("/v3/bookmakers/selected");
    expect(redactOddsApiIoUrl(calls[0])).toContain("apiKey=REDACTED");
    expect(redactOddsApiIoUrl(calls[0])).not.toContain("secret-key");
  });

  it("discovers NBA league slugs before fetching events", async () => {
    const requestedPaths: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requestedPaths.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/leagues")) {
        return makeJsonResponse([
          { eventsCount: 3, name: "NBA", slug: "usa-nba" },
          { eventsCount: 4, name: "WNBA", slug: "usa-wnba" },
          { eventsCount: 18, name: "EuroLeague", slug: "euroleague" },
        ]);
      }
      if (url.pathname.endsWith("/events")) {
        return makeJsonResponse([
          {
            away: "Oklahoma City Thunder",
            date: "2026-06-04T00:30:00Z",
            home: "New York Knicks",
            id: 88001,
            league: { name: "NBA", slug: "usa-nba" },
            sport: { name: "Basketball", slug: "basketball" },
            status: "pending",
          },
        ]);
      }

      return makeJsonResponse({ error: "not found" }, { status: 404 });
    }) as typeof fetch;

    const leagues = await fetchOddsApiIoBasketballLeagues({
      apiKey: "secret-key",
      fetchImpl,
    });
    const nbaSlugs = discoverOddsApiIoNbaLeagueSlugs(leagues);
    const events = await fetchOddsApiIoNbaEvents({
      apiKey: "secret-key",
      fetchImpl,
      from: "2026-06-01T00:00:00.000Z",
      league: nbaSlugs[0],
      to: "2026-06-15T00:00:00.000Z",
    });

    expect(nbaSlugs).toEqual(["usa-nba"]);
    expect(events).toHaveLength(1);
    expect(requestedPaths).toEqual([
      "/v3/leagues?apiKey=secret-key&sport=basketball",
      "/v3/events?apiKey=secret-key&from=2026-06-01T00%3A00%3A00.000Z&league=usa-nba&sport=basketball&status=pending%2Clive&to=2026-06-15T00%3A00%3A00.000Z",
    ]);
  });

  it("builds a WebSocket-first NBA feed URL with markets, event filters, and lastSeq replay", () => {
    const url = buildOddsApiIoWebSocketUrl({
      apiKey: "secret-key",
      eventIds: [88001, "88002"],
      lastSeq: 482917,
      markets: ODDS_API_IO_NBA_MARKETS,
      sport: ["basketball"],
    });

    expect(url.toString()).toContain("wss://api.odds-api.io/v3/ws?");
    expect(url.searchParams.get("markets")).toBe("ML,Spread,Totals,Player Props");
    expect(url.searchParams.get("eventIds")).toBe("88001,88002");
    expect(url.searchParams.get("lastSeq")).toBe("482917");
    expect(redactOddsApiIoUrl(url.toString())).not.toContain("secret-key");
  });

  it("rejects mutually exclusive WebSocket eventIds and league filters", () => {
    expect(() =>
      buildOddsApiIoWebSocketUrl({
        apiKey: "secret-key",
        eventIds: [88001],
        leagues: ["usa-nba"],
      }),
    ).toThrow("cannot combine leagues and eventIds");
  });

  it("tracks welcome, seq, stale replay, gaps, and resync_required messages", () => {
    let state = createInitialOddsApiIoWebSocketState();

    state = applyOddsApiIoWebSocketMessage(
      state,
      { message: "Connected", seq: 100, type: "welcome" },
      "2026-06-01T00:00:00.000Z",
    );
    state = applyOddsApiIoWebSocketMessage(
      state,
      { bookie: "Bet365", id: 88001, seq: 101, type: "created" },
      "2026-06-01T00:00:01.000Z",
    );
    state = applyOddsApiIoWebSocketMessage(
      state,
      { bookie: "Bet365", id: 88001, seq: 101, type: "updated" },
      "2026-06-01T00:00:02.000Z",
    );
    state = applyOddsApiIoWebSocketMessage(
      state,
      { bookie: "FanDuel", id: 88001, seq: 105, type: "updated" },
      "2026-06-01T00:00:03.000Z",
    );
    state = applyOddsApiIoWebSocketMessage(
      state,
      { message: "Replay unavailable", type: "resync_required" },
      "2026-06-01T00:00:04.000Z",
    );

    expect(state).toMatchObject({
      connected: true,
      createdCount: 1,
      lastSeq: 105,
      replayGapCount: 1,
      resyncRequired: true,
      staleSeqCount: 1,
      updatedCount: 2,
      welcomeCount: 1,
    });
  });

  it("fetches snapshot odds with includeSeq and summarizes ML, Spread, Totals, Player Props, and prediction markets", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v3/odds/multi");
      expect(url.searchParams.get("includeSeq")).toBe("true");
      expect(url.searchParams.get("bookmakers")).toBe(
        "Bet365,DraftKings,FanDuel,Kalshi,Polymarket",
      );

      return makeJsonResponse(
        [
          {
            bookmakers: {
              Bet365: [
                { name: "ML", odds: [{ away: "2.20", home: "1.71" }] },
                { name: "Spread", odds: [{ away: "1.91", hdp: 3.5, home: "1.91" }] },
                { name: "Totals", odds: [{ hdp: 219.5, over: "1.90", under: "1.90" }] },
              ],
              DraftKings: [
                {
                  name: "Player Props - Points",
                  odds: [{ hdp: 28.5, label: "Jalen Brunson", over: "1.87", under: "1.95" }],
                },
              ],
              Kalshi: [{ name: "ML", odds: [{ away: "2.30", home: "1.66" }] }],
              Polymarket: [{ name: "Totals", odds: [{ hdp: 219.5, over: "1.98" }] }],
            },
            id: 88001,
          },
        ],
        { headers: { "X-OddsAPI-Seq": "482900" } },
      );
    }) as typeof fetch;

    const snapshot = await fetchOddsApiIoEventOddsSnapshot({
      apiKey: "secret-key",
      eventIds: [88001],
      fetchImpl,
    });
    const summary = summarizeOddsApiIoCoverage(snapshot.payload);

    expect(snapshot.seq).toBe(482900);
    expect(summary.eventsInspected).toBe(1);
    expect(summary.marketFamiliesObserved).toMatchObject({
      moneyline: 2,
      "player-prop": 1,
      spread: 1,
      total: 2,
    });
    expect(summary.playerPropBooksObserved).toEqual(["DraftKings"]);
    expect(summary.predictionMarketBooksObserved).toEqual(["Kalshi", "Polymarket"]);
  });

  it("uses /odds/updated for REST deltas instead of a full odds snapshot", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return makeJsonResponse([{ id: 88001, type: "updated" }]);
    }) as typeof fetch;

    await fetchOddsApiIoUpdatedDelta({
      apiKey: "secret-key",
      bookmaker: "FanDuel",
      fetchImpl,
      sinceUnixSeconds: 1780454400,
    });

    const url = new URL(calls[0]);
    expect(url.pathname).toBe("/v3/odds/updated");
    expect(url.searchParams.get("bookmaker")).toBe("FanDuel");
    expect(url.searchParams.get("sport")).toBe("Basketball");
    expect(calls[0]).not.toContain("/odds/multi");
  });

  it("classifies documented player prop names as player-prop coverage", () => {
    expect(classifyOddsApiIoMarketFamily("Player Props - Points")).toBe("player-prop");
    expect(classifyOddsApiIoMarketFamily("Double Double")).toBe("player-prop");
    expect(classifyOddsApiIoMarketFamily("Totals")).toBe("total");
  });
});
