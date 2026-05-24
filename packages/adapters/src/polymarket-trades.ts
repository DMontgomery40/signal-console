import { createHash } from "node:crypto";

import {
  getDatabase,
  recordAdapterRun,
  recordMarketMicrostructureEvent,
  recordRawPayload,
} from "@signal-console/shared";

type FetchLike = typeof fetch;

const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const POLYMARKET_DATA_API_BASE_URL = "https://data-api.polymarket.com";
const DEFAULT_INTER_REQUEST_MS = 75;
const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 25;

type PolymarketTeam = {
  abbreviation?: string | null;
  alias?: string | null;
  id?: number | string | null;
  name?: string | null;
};

type PolymarketGammaMarket = {
  active?: boolean | null;
  clobTokenIds?: string | string[] | null;
  closed?: boolean | null;
  conditionId?: string | null;
  id: string;
  line?: number | string | null;
  outcomes?: string | string[] | null;
  question?: string | null;
  slug?: string | null;
  sportsMarketType?: string | null;
  volume?: number | string | null;
};

type PolymarketGammaEvent = {
  active?: boolean | null;
  closed?: boolean | null;
  eventDate?: string | null;
  id: string;
  markets?: PolymarketGammaMarket[];
  slug: string;
  startTime?: string | null;
  teams?: PolymarketTeam[];
  title?: string | null;
};

type PolymarketTrade = {
  asset?: string | null;
  conditionId?: string | null;
  eventSlug?: string | null;
  outcome?: string | null;
  outcomeIndex?: number | string | null;
  price?: number | string | null;
  side?: string | null;
  size?: number | string | null;
  timestamp?: number | string | null;
  transactionHash?: string | null;
};

type SourceMarketTarget = {
  eventSlug: string;
  gameId: string;
  instrumentId: string | null;
  marketId: string;
  rawFamily: string | null;
  rawLabel: string | null;
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey: string | null;
};

export type PolymarketTradesSyncSummary = {
  errors: Array<{ conditionId: string; message: string }>;
  eventsFetched: number;
  finishedAt: string;
  marketsScanned: number;
  ok: boolean;
  source: "polymarket";
  startedAt: string;
  tradesSeen: number;
  tradesWritten: number;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toNumber(value: number | string | null | undefined) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toUnixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function parseStringArray(value: string | string[] | null | undefined) {
  if (!value) return [] as string[];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseObjectJson(value: string | null | undefined) {
  if (!value) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hashPayload(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hydrateSourceMarketsWithGammaMetadata(options: {
  event: PolymarketGammaEvent;
  market: PolymarketGammaMarket;
  targets: SourceMarketTarget[];
}) {
  if (!options.market.conditionId) return;
  const db = getDatabase();
  const read = db.prepare(
    `SELECT raw_metadata_json AS rawMetadataJson
     FROM source_markets
     WHERE id = ?`
  );
  const update = db.prepare(
    `UPDATE source_markets
     SET raw_metadata_json = ?
     WHERE id = ?`
  );
  const clobTokenIds = parseStringArray(options.market.clobTokenIds);
  const outcomes = parseStringArray(options.market.outcomes);
  for (const target of options.targets) {
    const row = read.get(target.sourceMarketId) as
      | { rawMetadataJson: string | null }
      | undefined;
    const existing = parseObjectJson(row?.rawMetadataJson);
    update.run(
      JSON.stringify({
        ...existing,
        clobTokenIds,
        conditionId: options.market.conditionId,
        eventActive: options.event.active ?? null,
        eventClosed: options.event.closed ?? null,
        eventId: options.event.id,
        eventSlug: options.event.slug,
        marketActive: options.market.active ?? null,
        marketClosed: options.market.closed ?? null,
        marketId: options.market.id,
        marketQuestion: options.market.question ?? target.rawLabel,
        marketVolume: toNumber(options.market.volume),
        outcomes,
        sportsMarketType: options.market.sportsMarketType ?? target.rawFamily,
      }),
      target.sourceMarketId
    );
  }
}

function selectTargets(filters: {
  gameId?: string;
  league?: string;
  maxMarkets?: number;
  midpointIso?: string;
}) {
  const db = getDatabase();
  const params: unknown[] = [];
  const clauses = [
    "sm.source = 'polymarket'",
    "json_extract(sm.raw_metadata_json, '$.eventSlug') IS NOT NULL",
    "json_extract(sm.raw_metadata_json, '$.marketId') IS NOT NULL",
  ];

  if (filters.gameId) {
    clauses.push("sm.game_id = ?");
    params.push(filters.gameId);
  } else if (filters.league) {
    clauses.push("g.league = ?");
    params.push(filters.league);
  } else {
    clauses.push("g.sport = 'basketball'");
  }

  const midpoint = filters.midpointIso ?? new Date().toISOString();
  const limit =
    filters.maxMarkets != null && filters.maxMarkets > 0
      ? filters.maxMarkets
      : 500;

  const rows = db
    .prepare(
      `WITH selected_markets AS (
         SELECT
           json_extract(sm.raw_metadata_json, '$.eventSlug') AS eventSlug,
           json_extract(sm.raw_metadata_json, '$.marketId') AS marketId,
           MIN(ABS(strftime('%s', g.scheduled_start) - strftime('%s', ?))) AS distanceSeconds,
           MIN(sm.source_market_key) AS sortKey
         FROM source_markets sm
         JOIN games g ON g.id = sm.game_id
         WHERE ${clauses.join(" AND ")}
         GROUP BY eventSlug, marketId
         ORDER BY distanceSeconds ASC, sortKey ASC
         LIMIT ?
       )
       SELECT
         sm.id AS sourceMarketId,
         sm.source_market_key AS sourceMarketKey,
         sm.source_selection_key AS sourceSelectionKey,
         sm.game_id AS gameId,
         sm.instrument_id AS instrumentId,
         sm.raw_family AS rawFamily,
         sm.raw_label AS rawLabel,
         selected.eventSlug AS eventSlug,
         selected.marketId AS marketId
       FROM source_markets sm
       JOIN selected_markets selected
         ON selected.eventSlug = json_extract(sm.raw_metadata_json, '$.eventSlug')
        AND selected.marketId = json_extract(sm.raw_metadata_json, '$.marketId')
       WHERE sm.source = 'polymarket'
       ORDER BY selected.distanceSeconds ASC,
                selected.sortKey ASC,
                sm.source_market_key ASC,
                sm.source_selection_key ASC`
    )
    .all(midpoint, ...params, limit) as Array<Record<string, unknown>>;

  return rows
    .map((row): SourceMarketTarget | null => {
      const eventSlug = row.eventSlug == null ? "" : String(row.eventSlug);
      const marketId = row.marketId == null ? "" : String(row.marketId);
      if (!eventSlug || !marketId) return null;
      return {
        eventSlug,
        gameId: String(row.gameId),
        instrumentId:
          row.instrumentId == null ? null : String(row.instrumentId),
        marketId,
        rawFamily: row.rawFamily == null ? null : String(row.rawFamily),
        rawLabel: row.rawLabel == null ? null : String(row.rawLabel),
        sourceMarketId: String(row.sourceMarketId),
        sourceMarketKey: String(row.sourceMarketKey),
        sourceSelectionKey:
          row.sourceSelectionKey == null
            ? null
            : String(row.sourceSelectionKey),
      };
    })
    .filter((target): target is SourceMarketTarget => target != null);
}

async function fetchGammaEvent(options: {
  eventSlug: string;
  fetchImpl: FetchLike;
  gammaBaseUrl: string;
}) {
  const url = new URL("/events", options.gammaBaseUrl);
  url.searchParams.set("slug", options.eventSlug);
  const response = await options.fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Polymarket Gamma event ${options.eventSlug} failed with status ${response.status}.`
    );
  }
  const payload = (await response.json()) as unknown;
  const events = Array.isArray(payload)
    ? (payload as PolymarketGammaEvent[])
    : [];
  return events[0] ?? null;
}

async function fetchTradesPage(options: {
  conditionId: string;
  dataApiBaseUrl: string;
  fetchImpl: FetchLike;
  limit: number;
  offset: number;
}) {
  const url = new URL("/trades", options.dataApiBaseUrl);
  url.searchParams.set("market", options.conditionId);
  url.searchParams.set("limit", String(options.limit));
  if (options.offset > 0) {
    url.searchParams.set("offset", String(options.offset));
  }
  const response = await options.fetchImpl(url.toString());
  if (!response.ok && response.status === 400 && options.offset > 0) {
    return [];
  }
  if (!response.ok) {
    throw new Error(
      `Polymarket Data API trades for ${options.conditionId} failed with status ${response.status}.`
    );
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as PolymarketTrade[]) : [];
}

function buildTeamOutcomeMap(event: PolymarketGammaEvent) {
  const byToken = new Map<string, string>();
  for (const team of event.teams ?? []) {
    const value = normalizeToken(
      team.abbreviation ?? team.alias ?? team.name ?? ""
    );
    if (!value) continue;
    for (const token of [team.abbreviation, team.alias, team.name].map(
      (entry) => normalizeToken(entry ?? "")
    )) {
      if (token) byToken.set(token, value);
    }
  }
  return byToken;
}

function selectionForOutcome(options: {
  event: PolymarketGammaEvent;
  market: PolymarketGammaMarket;
  outcome: string | null | undefined;
  outcomeIndex: number | null;
}) {
  const outcomeToken = normalizeToken(options.outcome ?? "");
  if (outcomeToken === "yes" || outcomeToken === "over") return "over";
  if (outcomeToken === "no" || outcomeToken === "under") return "under";

  const teamMap = buildTeamOutcomeMap(options.event);
  const teamSelection = teamMap.get(outcomeToken);
  if (teamSelection) return teamSelection;

  const outcomes = parseStringArray(options.market.outcomes);
  if (options.outcomeIndex != null && outcomes[options.outcomeIndex] != null) {
    const indexedOutcome = normalizeToken(outcomes[options.outcomeIndex]);
    if (indexedOutcome === "yes" || indexedOutcome === "over") return "over";
    if (indexedOutcome === "no" || indexedOutcome === "under") return "under";
    return teamMap.get(indexedOutcome) ?? indexedOutcome;
  }

  return outcomeToken;
}

function tradeTimestampIso(trade: PolymarketTrade) {
  const ts = toNumber(trade.timestamp);
  if (ts == null) return null;
  return new Date(ts * 1000).toISOString();
}

function tradeIdentity(trade: PolymarketTrade) {
  return [
    trade.transactionHash ?? "",
    trade.asset ?? "",
    trade.timestamp ?? "",
    trade.outcome ?? "",
    trade.side ?? "",
    trade.price ?? "",
    trade.size ?? "",
  ].join(":");
}

export async function syncPolymarketNbaTrades(options: {
  since: string;
  until: string;
  dataApiBaseUrl?: string;
  fetchImpl?: FetchLike;
  gameId?: string;
  gammaBaseUrl?: string;
  interRequestMs?: number;
  league?: string;
  maxMarkets?: number;
  maxPages?: number;
  pageLimit?: number;
}): Promise<PolymarketTradesSyncSummary> {
  const minTs = toUnixSeconds(options.since);
  const maxTs = toUnixSeconds(options.until);
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) {
    throw new Error(
      `Invalid window for syncPolymarketNbaTrades: since=${options.since} until=${options.until}`
    );
  }

  const startedAt = new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const gammaBaseUrl = options.gammaBaseUrl ?? POLYMARKET_GAMMA_BASE_URL;
  const dataApiBaseUrl = options.dataApiBaseUrl ?? POLYMARKET_DATA_API_BASE_URL;
  const interRequestMs = options.interRequestMs ?? DEFAULT_INTER_REQUEST_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const midpointIso = new Date(
    (Date.parse(options.since) + Date.parse(options.until)) / 2
  ).toISOString();
  const targets = selectTargets({
    gameId: options.gameId,
    league: options.league,
    maxMarkets: options.maxMarkets,
    midpointIso,
  });

  const byEvent = new Map<string, SourceMarketTarget[]>();
  for (const target of targets) {
    const bucket = byEvent.get(target.eventSlug) ?? [];
    bucket.push(target);
    byEvent.set(target.eventSlug, bucket);
  }

  let eventsFetched = 0;
  let marketsScanned = 0;
  let tradesSeen = 0;
  let tradesWritten = 0;
  const errors: Array<{ conditionId: string; message: string }> = [];

  for (const [eventSlug, eventTargets] of byEvent.entries()) {
    const event = await fetchGammaEvent({ eventSlug, fetchImpl, gammaBaseUrl });
    eventsFetched += event ? 1 : 0;
    if (!event) continue;

    const targetsByMarket = new Map<string, SourceMarketTarget[]>();
    for (const target of eventTargets) {
      const list = targetsByMarket.get(target.marketId) ?? [];
      list.push(target);
      targetsByMarket.set(target.marketId, list);
    }

    const marketsById = new Map(
      (event.markets ?? []).map((market) => [market.id, market])
    );

    for (const [marketId, marketTargets] of targetsByMarket.entries()) {
      const market = marketsById.get(marketId);
      if (!market?.conditionId) continue;
      hydrateSourceMarketsWithGammaMetadata({
        event,
        market,
        targets: marketTargets,
      });
      marketsScanned += 1;
      const marketVolume = toNumber(market.volume);
      const isClosed = Boolean(market.closed ?? event.closed);
      const bySelection = new Map<string, SourceMarketTarget>();
      for (const target of marketTargets) {
        if (target.sourceSelectionKey) {
          bySelection.set(normalizeToken(target.sourceSelectionKey), target);
        }
      }

      const seen = new Set<string>();
      try {
        for (let page = 0; page < maxPages; page += 1) {
          const trades = await fetchTradesPage({
            conditionId: market.conditionId,
            dataApiBaseUrl,
            fetchImpl,
            limit: pageLimit,
            offset: page * pageLimit,
          });
          if (trades.length === 0) break;

          let newRows = 0;
          let pageHasWindowRows = false;
          let pageHasNewerThanSince = false;
          for (const trade of trades) {
            const identity = tradeIdentity(trade);
            if (seen.has(identity)) continue;
            seen.add(identity);
            newRows += 1;

            const tradeTs = toNumber(trade.timestamp);
            if (tradeTs == null) continue;
            if (tradeTs >= minTs) pageHasNewerThanSince = true;
            if (tradeTs < minTs || tradeTs > maxTs) continue;
            pageHasWindowRows = true;
            tradesSeen += 1;

            const outcomeIndex = toNumber(trade.outcomeIndex);
            const selection = selectionForOutcome({
              event,
              market,
              outcome: trade.outcome,
              outcomeIndex,
            });
            const target = bySelection.get(selection);
            if (!target) continue;

            const price = toNumber(trade.price);
            const size = toNumber(trade.size);
            const notional =
              price != null && size != null
                ? Number((price * size).toFixed(8))
                : null;
            const eventTimestamp = tradeTimestampIso(trade);
            if (!eventTimestamp) continue;
            const volumeShare =
              marketVolume != null && marketVolume > 0 && size != null
                ? size / marketVolume
                : null;
            const rawPayload = trade as unknown as Record<string, unknown>;
            const raw = recordRawPayload({
              source: "polymarket",
              capturedAt: new Date().toISOString(),
              entityType: "polymarket-data-api-trade",
              entityId: `${market.conditionId}:${identity}`,
              payloadJson: rawPayload,
              contentHash: hashPayload(rawPayload),
            });
            const result = recordMarketMicrostructureEvent({
              apiSurface: "data-api/trades",
              bestAsk: null,
              bestBid: null,
              capturedAt: new Date().toISOString(),
              depthScore: null,
              eventTimestamp,
              eventType: "trade",
              finalMarketVolume: isClosed ? marketVolume : null,
              gameId: target.gameId,
              instrumentId: target.instrumentId,
              notional,
              previousPrice: null,
              price,
              rawMetadata: {
                conditionId: market.conditionId,
                eventActive: event.active ?? null,
                eventClosed: event.closed ?? null,
                eventSlug,
                marketClosed: market.closed ?? null,
                marketId,
                marketQuestion: market.question ?? target.rawLabel,
                marketVolume,
                outcome: trade.outcome ?? null,
                reportedVolumeBasis: isClosed ? "final" : "live-to-date",
                side: trade.side ?? null,
                sportsMarketType:
                  market.sportsMarketType ?? target.rawFamily ?? null,
                transactionHash: trade.transactionHash ?? null,
              },
              rawPayloadId: raw.id ?? null,
              size,
              source: "polymarket",
              sourceMarketId: target.sourceMarketId,
              spread: null,
              tradePrice: price,
              volume: marketVolume,
              volumeShare,
            });
            if (result.inserted) tradesWritten += 1;
          }

          if (
            trades.length < pageLimit ||
            newRows === 0 ||
            (!pageHasNewerThanSince && !pageHasWindowRows)
          ) {
            break;
          }
          if (interRequestMs > 0) await sleep(interRequestMs);
        }
      } catch (error) {
        errors.push({
          conditionId: market.conditionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (interRequestMs > 0) await sleep(interRequestMs);
    }
  }

  const finishedAt = new Date().toISOString();
  recordAdapterRun({
    captureMode: "historical",
    errorCode: errors.length > 0 ? "PARTIAL_FAILURES" : null,
    errorMessage:
      errors.length > 0
        ? `${errors.length} Polymarket trade markets failed`
        : null,
    finishedAt,
    recordsSeen: tradesSeen,
    recordsWritten: tradesWritten,
    source: "polymarket-trades",
    startedAt,
    status: errors.length === 0 ? "ok" : "error",
  });

  return {
    errors,
    eventsFetched,
    finishedAt,
    marketsScanned,
    ok: errors.length === 0,
    source: "polymarket",
    startedAt,
    tradesSeen,
    tradesWritten,
  };
}
