import { resolveOddsApiKey } from "@signal-console/shared";

type FetchLike = typeof fetch;

export const ODDS_API_IO_BASE_URL = "https://api.odds-api.io/v3";
export const ODDS_API_IO_WEBSOCKET_URL = "wss://api.odds-api.io/v3/ws";

export const ODDS_API_IO_SELECTED_BOOKMAKER_SPINE = [
  "Bet365",
  "DraftKings",
  "FanDuel",
  "Kalshi",
  "Polymarket",
] as const;

export const ODDS_API_IO_NBA_MARKETS = ["ML", "Spread", "Totals", "Player Props"] as const;

export type OddsApiIoBookmaker = (typeof ODDS_API_IO_SELECTED_BOOKMAKER_SPINE)[number];
export type OddsApiIoNbaMarket = (typeof ODDS_API_IO_NBA_MARKETS)[number];
export type OddsApiIoMarketFamily = "moneyline" | "player-prop" | "spread" | "total" | "other";

export type OddsApiIoLeague = {
  readonly eventsCount?: number | null;
  readonly name?: string | null;
  readonly slug?: string | null;
};

export type OddsApiIoEvent = {
  readonly away?: string | null;
  readonly date?: string | null;
  readonly home?: string | null;
  readonly id?: number | string | null;
  readonly league?: {
    readonly name?: string | null;
    readonly slug?: string | null;
  } | null;
  readonly sport?: {
    readonly name?: string | null;
    readonly slug?: string | null;
  } | null;
  readonly status?: string | null;
};

export type OddsApiIoMarket = {
  readonly name?: string | null;
  readonly odds?: ReadonlyArray<Record<string, unknown>> | null;
  readonly updatedAt?: string | null;
};

export type OddsApiIoEventOdds = OddsApiIoEvent & {
  readonly bookmakerIds?: Record<string, string | null> | null;
  readonly bookmakers?: Record<string, readonly OddsApiIoMarket[] | null> | null;
  readonly urls?: Record<string, string | null> | null;
};

export type OddsApiIoSnapshot = {
  readonly payload: readonly OddsApiIoEventOdds[];
  readonly seq: number | null;
};

export type OddsApiIoWebSocketMessage = {
  readonly bookie?: string | null;
  readonly id?: number | string | null;
  readonly markets?: readonly OddsApiIoMarket[] | null;
  readonly message?: string | null;
  readonly seq?: number | string | null;
  readonly type?: string | null;
  readonly warning?: string | null;
  readonly [key: string]: unknown;
};

export type OddsApiIoWebSocketState = {
  readonly connected: boolean;
  readonly createdCount: number;
  readonly deletedCount: number;
  readonly lastMessageAt: string | null;
  readonly lastSeq: number;
  readonly noMarketsCount: number;
  readonly replayGapCount: number;
  readonly resyncRequired: boolean;
  readonly staleSeqCount: number;
  readonly updatedCount: number;
  readonly warningMessages: readonly string[];
  readonly welcomeCount: number;
};

export type OddsApiIoCoverageSummary = {
  readonly eventsInspected: number;
  readonly familiesByBookmaker: Record<
    string,
    Partial<Record<OddsApiIoMarketFamily, number>> & {
      readonly marketNames: string[];
    }
  >;
  readonly marketFamiliesObserved: Partial<Record<OddsApiIoMarketFamily, number>>;
  readonly predictionMarketBooksObserved: string[];
  readonly playerPropBooksObserved: string[];
};

// Delegates to the canonical resolver (audit F-012) so this surface and every
// other odds-api reader share ONE ordered name list. Kept as a named wrapper
// because callers pass an explicit env in tests.
export function readOddsApiIoApiKey(env: NodeJS.ProcessEnv = process.env) {
  return resolveOddsApiKey(env);
}

export function redactOddsApiIoUrl(input: string) {
  const url = new URL(input);
  if (url.searchParams.has("apiKey")) {
    url.searchParams.set("apiKey", "REDACTED");
  }
  return url.toString();
}

export function buildOddsApiIoRestUrl(
  pathname: string,
  params: Record<string, string | number | readonly (string | number)[] | null | undefined>,
  baseUrl = ODDS_API_IO_BASE_URL,
) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(pathname.replace(/^\//, ""), normalizedBaseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value == null) {
      continue;
    }
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }

  return url;
}

export function buildOddsApiIoWebSocketUrl(options: {
  readonly apiKey: string;
  readonly baseWebSocketUrl?: string;
  readonly eventIds?: readonly (number | string)[];
  readonly lastSeq?: number | null;
  readonly leagues?: readonly string[];
  readonly markets?: readonly string[];
  readonly sport?: readonly string[];
  readonly status?: "live" | "prematch";
}) {
  if ((options.eventIds?.length ?? 0) > 0 && (options.leagues?.length ?? 0) > 0) {
    throw new Error("Odds-API.io WebSocket filters cannot combine leagues and eventIds.");
  }

  const url = new URL(options.baseWebSocketUrl ?? ODDS_API_IO_WEBSOCKET_URL);
  const markets = options.markets ?? ODDS_API_IO_NBA_MARKETS;
  if (markets.length === 0) {
    throw new Error("Odds-API.io WebSocket requires at least one market.");
  }

  url.searchParams.set("apiKey", options.apiKey);
  url.searchParams.set("markets", markets.join(","));
  if (options.sport && options.sport.length > 0) {
    url.searchParams.set("sport", options.sport.join(","));
  }
  if (options.leagues && options.leagues.length > 0) {
    url.searchParams.set("leagues", options.leagues.join(","));
  }
  if (options.eventIds && options.eventIds.length > 0) {
    url.searchParams.set("eventIds", options.eventIds.map((id) => String(id)).join(","));
  }
  if (options.status) {
    url.searchParams.set("status", options.status);
  }
  if (options.lastSeq != null && options.lastSeq > 0) {
    url.searchParams.set("lastSeq", String(options.lastSeq));
  }

  return url;
}

export function createInitialOddsApiIoWebSocketState(): OddsApiIoWebSocketState {
  return {
    connected: false,
    createdCount: 0,
    deletedCount: 0,
    lastMessageAt: null,
    lastSeq: 0,
    noMarketsCount: 0,
    replayGapCount: 0,
    resyncRequired: false,
    staleSeqCount: 0,
    updatedCount: 0,
    warningMessages: [],
    welcomeCount: 0,
  };
}

function parseSeq(value: number | string | null | undefined) {
  if (value == null || value === "") {
    return null;
  }
  const seq = Number(value);
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}

export function applyOddsApiIoWebSocketMessage(
  state: OddsApiIoWebSocketState,
  message: OddsApiIoWebSocketMessage,
  receivedAt = new Date().toISOString(),
): OddsApiIoWebSocketState {
  const messageType = String(message.type ?? "").toLowerCase();
  const seq = parseSeq(message.seq);
  const staleSeqCount =
    seq != null && seq <= state.lastSeq && state.lastSeq > 0
      ? state.staleSeqCount + 1
      : state.staleSeqCount;
  const replayGapCount =
    seq != null && state.lastSeq > 0 && seq > state.lastSeq + 1
      ? state.replayGapCount + 1
      : state.replayGapCount;
  const warningMessages =
    message.warning == null || message.warning === ""
      ? state.warningMessages
      : [...state.warningMessages, String(message.warning)];

  return {
    connected: state.connected || messageType === "welcome",
    createdCount: state.createdCount + (messageType === "created" ? 1 : 0),
    deletedCount: state.deletedCount + (messageType === "deleted" ? 1 : 0),
    lastMessageAt: receivedAt,
    lastSeq: seq != null && seq > state.lastSeq ? seq : state.lastSeq,
    noMarketsCount: state.noMarketsCount + (messageType === "no_markets" ? 1 : 0),
    replayGapCount,
    resyncRequired: state.resyncRequired || messageType === "resync_required",
    staleSeqCount,
    updatedCount: state.updatedCount + (messageType === "updated" ? 1 : 0),
    warningMessages,
    welcomeCount: state.welcomeCount + (messageType === "welcome" ? 1 : 0),
  };
}

function assertResponseOk(response: Response, label: string) {
  if (!response.ok) {
    throw new Error(`${label} failed with status ${response.status}.`);
  }
}

export function extractOddsApiIoBookmakerNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => {
      if (typeof entry === "string") {
        return [entry];
      }
      if (entry && typeof entry === "object" && "name" in entry) {
        return [String((entry as { name?: unknown }).name ?? "")].filter(Boolean);
      }
      return [];
    });
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    return extractOddsApiIoBookmakerNames(
      record.bookmakers ?? record.selectedBookmakers ?? record.selected ?? record.data,
    );
  }

  return [];
}

export function verifyOddsApiIoSelectedBookmakers(
  actualBookmakers: readonly string[],
  expectedBookmakers: readonly string[] = ODDS_API_IO_SELECTED_BOOKMAKER_SPINE,
) {
  const actual = new Set(actualBookmakers);
  const expected = new Set(expectedBookmakers);

  return {
    extra: actualBookmakers.filter((bookmaker) => !expected.has(bookmaker)),
    missing: expectedBookmakers.filter((bookmaker) => !actual.has(bookmaker)),
    ok: expectedBookmakers.every((bookmaker) => actual.has(bookmaker)),
    selected: actualBookmakers,
  };
}

export async function fetchOddsApiIoSelectedBookmakers(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiIoRestUrl(
    "bookmakers/selected",
    {
      apiKey: options.apiKey,
    },
    options.baseUrl,
  );
  const response = await fetchImpl(url.toString());
  assertResponseOk(response, "Odds-API.io selected-bookmakers request");
  return (await response.json()) as unknown;
}

export async function fetchOddsApiIoBasketballLeagues(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiIoRestUrl(
    "leagues",
    {
      apiKey: options.apiKey,
      sport: "basketball",
    },
    options.baseUrl,
  );
  const response = await fetchImpl(url.toString());
  assertResponseOk(response, "Odds-API.io basketball leagues request");
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as OddsApiIoLeague[]) : [];
}

export function discoverOddsApiIoNbaLeagueSlugs(leagues: readonly OddsApiIoLeague[]) {
  const slugs = leagues
    .filter((league) => {
      const name = String(league.name ?? "").toLowerCase();
      const slug = String(league.slug ?? "").toLowerCase();
      return name === "nba" || slug === "nba" || slug === "usa-nba";
    })
    .map((league) => String(league.slug ?? "").trim())
    .filter(Boolean);

  return [...new Set(slugs)];
}

export async function fetchOddsApiIoNbaEvents(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly from?: string;
  readonly league?: string;
  readonly status?: string;
  readonly to?: string;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiIoRestUrl(
    "events",
    {
      apiKey: options.apiKey,
      from: options.from,
      league: options.league,
      sport: "basketball",
      status: options.status ?? "pending,live",
      to: options.to,
    },
    options.baseUrl,
  );
  const response = await fetchImpl(url.toString());
  assertResponseOk(response, "Odds-API.io NBA events request");
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as OddsApiIoEvent[]) : [];
}

export async function fetchOddsApiIoEventOddsSnapshot(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly bookmakers?: readonly string[];
  readonly eventIds: readonly (number | string)[];
  readonly fetchImpl?: FetchLike;
  readonly includeSeq?: boolean;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiIoRestUrl(
    "odds/multi",
    {
      apiKey: options.apiKey,
      bookmakers: options.bookmakers ?? ODDS_API_IO_SELECTED_BOOKMAKER_SPINE,
      eventIds: options.eventIds,
      includeSeq: options.includeSeq === false ? undefined : "true",
    },
    options.baseUrl,
  );
  const response = await fetchImpl(url.toString());
  assertResponseOk(response, "Odds-API.io odds snapshot request");
  const payload = (await response.json()) as unknown;
  return {
    payload: Array.isArray(payload) ? (payload as OddsApiIoEventOdds[]) : [],
    seq: parseSeq(response.headers.get("X-OddsAPI-Seq")),
  } satisfies OddsApiIoSnapshot;
}

export async function fetchOddsApiIoUpdatedDelta(options: {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly bookmaker: string;
  readonly fetchImpl?: FetchLike;
  readonly sinceUnixSeconds: number;
  readonly sport?: string;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiIoRestUrl(
    "odds/updated",
    {
      apiKey: options.apiKey,
      bookmaker: options.bookmaker,
      since: options.sinceUnixSeconds,
      sport: options.sport ?? "Basketball",
    },
    options.baseUrl,
  );
  const response = await fetchImpl(url.toString());
  assertResponseOk(response, `Odds-API.io updated-odds request for ${options.bookmaker}`);
  return (await response.json()) as unknown;
}

export function classifyOddsApiIoMarketFamily(name: string | null | undefined) {
  const normalized = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  if (normalized === "ml" || normalized.includes("moneyline")) {
    return "moneyline" as const;
  }
  if (normalized.includes("spread") || normalized.includes("handicap")) {
    return "spread" as const;
  }
  if (normalized.includes("total") || normalized.includes("over-under")) {
    return "total" as const;
  }
  if (normalized.includes("player") || normalized.includes("double-double")) {
    return "player-prop" as const;
  }
  return "other" as const;
}

function incrementFamily(
  counts: Partial<Record<OddsApiIoMarketFamily, number>>,
  family: OddsApiIoMarketFamily,
) {
  counts[family] = (counts[family] ?? 0) + 1;
}

export function summarizeOddsApiIoCoverage(
  snapshots: readonly OddsApiIoEventOdds[],
): OddsApiIoCoverageSummary {
  const marketFamiliesObserved: Partial<Record<OddsApiIoMarketFamily, number>> = {};
  const familiesByBookmaker: OddsApiIoCoverageSummary["familiesByBookmaker"] = {};

  for (const event of snapshots) {
    for (const [bookmaker, markets] of Object.entries(event.bookmakers ?? {})) {
      const byBookmaker = familiesByBookmaker[bookmaker] ?? {
        marketNames: [],
      };
      const marketNames = new Set(byBookmaker.marketNames);

      for (const market of markets ?? []) {
        const marketName = String(market.name ?? "");
        if (marketName) {
          marketNames.add(marketName);
        }
        const family = classifyOddsApiIoMarketFamily(market.name);
        incrementFamily(marketFamiliesObserved, family);
        incrementFamily(byBookmaker, family);
      }

      familiesByBookmaker[bookmaker] = {
        ...byBookmaker,
        marketNames: [...marketNames].sort((left, right) => left.localeCompare(right)),
      };
    }
  }

  return {
    eventsInspected: snapshots.length,
    familiesByBookmaker,
    marketFamiliesObserved,
    predictionMarketBooksObserved: ["Kalshi", "Polymarket"].filter(
      (bookmaker) => familiesByBookmaker[bookmaker] != null,
    ),
    playerPropBooksObserved: Object.entries(familiesByBookmaker)
      .filter(([, families]) => (families["player-prop"] ?? 0) > 0)
      .map(([bookmaker]) => bookmaker),
  };
}
