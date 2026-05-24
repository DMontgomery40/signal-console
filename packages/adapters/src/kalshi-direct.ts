import { createHash } from "node:crypto";

import type { MarketFamily, ResearchGameCard } from "@signal-console/domain";
import {
  listResearchGames,
  recordAdapterRun,
  recordQuoteObservation,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

type FetchLike = typeof fetch;

const KALSHI_DEFAULT_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_NBA_COMPETITION = "NBA";
const KALSHI_DIRECT_SERIES_METRICS: Record<string, string> = {
  KXNBA2D: "double-double",
  KXNBA3D: "triple-double",
  KXNBA3PT: "threes",
  KXNBAAST: "assists",
  KXNBABLK: "blocks",
  KXNBAPTS: "points",
  KXNBAPTSLEADER: "points-leader",
  KXNBAREB: "rebounds",
  KXNBASTL: "steals",
};
const DEFAULT_INTER_REQUEST_MS = 250;
const MAX_RETRIES_ON_429 = 5;

type KalshiDirectMarket = {
  ticker: string;
  event_ticker?: string | null;
  title?: string | null;
  status?: string | null;
  yes_sub_title?: string | null;
  no_sub_title?: string | null;
  last_price_dollars?: string | null;
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  yes_bid_size_fp?: string | null;
  yes_ask_size_fp?: string | null;
  volume_fp?: string | null;
  volume_24h_fp?: string | null;
  open_interest_fp?: string | null;
  liquidity_dollars?: string | null;
  volume?: number | string | null;
  volume_24h?: number | string | null;
  liquidity?: number | string | null;
  open_interest?: number | string | null;
  functional_strike?: number | string | null;
  floor_strike?: number | string | null;
  cap_strike?: number | string | null;
  custom_strike?: Record<string, unknown> | null;
  primary_participant_key?: string | null;
  close_time?: string | null;
  open_time?: string | null;
  created_time?: string | null;
  expected_expiration_time?: string | null;
  result?: string | null;
};

type KalshiDirectEvent = {
  event_ticker: string;
  title: string;
  sub_title?: string | null;
  category?: string | null;
  series_ticker: string;
  markets?: KalshiDirectMarket[];
};

type KalshiDirectMilestone = {
  id: string;
  title: string;
  type?: string | null;
  start_date?: string | null;
  related_event_tickers?: string[];
  primary_event_tickers?: string[];
  details?: Record<string, unknown> | null;
};

type KalshiDirectMilestonesResponse = {
  cursor?: string | null;
  milestones?: KalshiDirectMilestone[];
};

export type KalshiDirectSyncSummary = {
  eventsFetched: number;
  eventsSeen: number;
  finishedAt: string;
  gamesMatched: number;
  marketErrors: Array<{
    error: string;
    eventTicker?: string;
    marketTicker?: string;
  }>;
  milestonesSeen: number;
  ok: true;
  quoteObservationsWritten: number;
  rawPayloadsWritten: number;
  sourceMarketsObserved: number;
  startedAt: string;
  unmatchedEventTickers: string[];
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildKalshiHeaders() {
  const headers: Record<string, string> = {};
  if (process.env.KALSHI_API_KEY) {
    headers["KALSHI-ACCESS-KEY"] = process.env.KALSHI_API_KEY;
  }
  return headers;
}

async function fetchWithRateLimit(
  fetchImpl: FetchLike,
  url: string,
  options?: { headers?: Record<string, string>; interRequestMs?: number }
) {
  const interRequestMs = options?.interRequestMs ?? DEFAULT_INTER_REQUEST_MS;
  let attempt = 0;
  let waitMs = 1000;

  while (attempt <= MAX_RETRIES_ON_429) {
    if (attempt === 0 && interRequestMs > 0) {
      await sleep(interRequestMs);
    }

    const response = await fetchImpl(url, { headers: options?.headers });
    if (response.status !== 429) {
      return response;
    }

    const retryAfterHeader = response.headers?.get?.("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delay = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : waitMs;

    await sleep(delay);
    waitMs = Math.min(waitMs * 2, 30_000);
    attempt += 1;
  }

  return fetchImpl(url, { headers: options?.headers });
}

const MONTH_ABBREVIATIONS: Record<string, number> = {
  APR: 3,
  AUG: 7,
  DEC: 11,
  FEB: 1,
  JAN: 0,
  JUL: 6,
  JUN: 5,
  MAR: 2,
  MAY: 4,
  NOV: 10,
  OCT: 9,
  SEP: 8,
};

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

function resolveKalshiQuoteVolume(market: KalshiDirectMarket) {
  const candidates = [
    {
      source: "volume_fp" as const,
      value: toNumber(market.volume_fp),
    },
    {
      source: "volume_24h_fp" as const,
      value: toNumber(market.volume_24h_fp),
    },
    {
      source: "volume_24h" as const,
      value: toNumber(market.volume_24h),
    },
    {
      source: "volume" as const,
      value: toNumber(market.volume),
    },
  ];

  for (const candidate of candidates) {
    if (candidate.value != null) {
      return candidate;
    }
  }

  return {
    source: null,
    value: null,
  } as const;
}

function resolveKalshiDepthScore(market: KalshiDirectMarket) {
  return (
    toNumber(market.liquidity_dollars) ?? toNumber(market.liquidity) ?? null
  );
}

function buildStableId(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) => normalizeToken(String(part ?? "")))
    .filter(Boolean)
    .join("-");
}

function buildRawPayloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildGameKey(date: string, teamKeys: string[]) {
  return `${date}::${teamKeys
    .map((key) => normalizeToken(key))
    .sort()
    .join("::")}`;
}

function shiftIsoDate(iso: string, deltaDays: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function buildGameIndex(games: ResearchGameCard[]) {
  const index = new Map<string, ResearchGameCard>();

  for (const gameCard of games) {
    const teamKeys = [
      gameCard.game.awayParticipant.abbreviation ??
        gameCard.game.awayParticipant.key,
      gameCard.game.homeParticipant.abbreviation ??
        gameCard.game.homeParticipant.key,
    ];
    const date = gameCard.game.scheduledStart.slice(0, 10);
    for (const delta of [0, -1, 1]) {
      const key = buildGameKey(shiftIsoDate(date, delta), teamKeys);
      if (!index.has(key)) {
        index.set(key, gameCard);
      }
    }
  }

  return index;
}

function parseKalshiEventParts(
  eventTicker: string
): { away: string; date: string; home: string; series: string } | null {
  const match = eventTicker.match(
    /^(KXNBA[A-Z0-9]*)-(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})(?:-|$)/
  );
  if (!match) return null;

  const [, series, yy, monthAbbr, dd, away, home] = match;
  const monthIndex = MONTH_ABBREVIATIONS[monthAbbr];
  if (monthIndex == null) return null;

  const date = new Date(Date.UTC(2000 + Number(yy), monthIndex, Number(dd)))
    .toISOString()
    .slice(0, 10);

  return { away, date, home, series };
}

function resolveGameByTicker(
  eventTicker: string,
  gameIndex: Map<string, ResearchGameCard>
) {
  const parts = parseKalshiEventParts(eventTicker);
  if (!parts) return null;
  return (
    gameIndex.get(buildGameKey(parts.date, [parts.away, parts.home])) ?? null
  );
}

function resolveTeamKeyFromMarket(
  market: KalshiDirectMarket,
  game: ResearchGameCard
) {
  const tickerSuffix = normalizeToken(market.ticker.split("-").pop() ?? "");
  const yesLabel = normalizeToken(market.yes_sub_title ?? market.title ?? "");

  const candidates = [
    {
      key: game.game.homeParticipant.key,
      labels: [
        game.game.homeParticipant.abbreviation,
        game.game.homeParticipant.key,
        game.game.homeParticipant.shortName,
        game.game.homeParticipant.name,
      ].map(normalizeToken),
    },
    {
      key: game.game.awayParticipant.key,
      labels: [
        game.game.awayParticipant.abbreviation,
        game.game.awayParticipant.key,
        game.game.awayParticipant.shortName,
        game.game.awayParticipant.name,
      ].map(normalizeToken),
    },
  ];

  for (const candidate of candidates) {
    if (
      candidate.labels.some(
        (label) =>
          label &&
          (tickerSuffix === label ||
            tickerSuffix.startsWith(label) ||
            yesLabel.includes(label))
      )
    ) {
      return candidate.key;
    }
  }

  return null;
}

function parsePlayerName(market: KalshiDirectMarket) {
  const title = market.title ?? market.yes_sub_title ?? "";
  const beforeColon = title.split(":")[0]?.trim();
  if (beforeColon && !/^will\b/i.test(beforeColon)) return beforeColon;

  const yesLabel = market.yes_sub_title ?? "";
  const labelBeforeColon = yesLabel.split(":")[0]?.trim();
  if (labelBeforeColon) return labelBeforeColon;

  return null;
}

function inferLine(market: KalshiDirectMarket) {
  return (
    toNumber(market.functional_strike) ??
    toNumber(market.floor_strike) ??
    toNumber(market.cap_strike) ??
    null
  );
}

function inferMarketShape(
  event: KalshiDirectEvent,
  market: KalshiDirectMarket,
  game: ResearchGameCard
): {
  displayLabel: string;
  family: MarketFamily;
  instrumentKeyParts: Array<string | number | null | undefined>;
  line: number | null;
  participantKey: string | null;
  rawFamily: string;
  selection: string;
} {
  const series =
    parseKalshiEventParts(event.event_ticker)?.series ?? event.series_ticker;
  const metric = KALSHI_DIRECT_SERIES_METRICS[series];
  const line = inferLine(market);
  const rawLabel = market.title ?? market.yes_sub_title ?? market.ticker;
  const teamKey = resolveTeamKeyFromMarket(market, game);

  if (metric) {
    const playerName = parsePlayerName(market);
    const participantKey = playerName ? normalizeToken(playerName) : null;
    const binaryMetric =
      metric === "double-double" ||
      metric === "triple-double" ||
      metric === "points-leader";
    const selection = binaryMetric ? "yes" : "over";
    return {
      displayLabel: playerName
        ? `${playerName} ${selection}${line == null ? "" : ` ${line}`} ${metric}`
        : rawLabel,
      family: "player-prop",
      instrumentKeyParts: [
        game.game.id,
        "player-prop",
        metric,
        participantKey,
        selection,
        line,
      ],
      line: binaryMetric ? null : line,
      participantKey,
      rawFamily: metric,
      selection,
    };
  }

  if (series === "KXNBAGAME") {
    return {
      displayLabel: `${market.yes_sub_title ?? teamKey ?? rawLabel} moneyline`,
      family: "moneyline",
      instrumentKeyParts: [game.game.id, "moneyline", teamKey],
      line: null,
      participantKey: teamKey,
      rawFamily: "moneyline",
      selection: teamKey ?? normalizeToken(market.yes_sub_title ?? rawLabel),
    };
  }

  if (series === "KXNBASPREAD") {
    return {
      displayLabel: rawLabel,
      family: "spread",
      instrumentKeyParts: [game.game.id, "spread", teamKey, line],
      line,
      participantKey: teamKey,
      rawFamily: "spread",
      selection: teamKey ?? "yes",
    };
  }

  if (series === "KXNBATOTAL") {
    return {
      displayLabel: rawLabel,
      family: "total",
      instrumentKeyParts: [game.game.id, "total", "over", line],
      line,
      participantKey: null,
      rawFamily: "total",
      selection: "over",
    };
  }

  if (series === "KXNBATEAMTOTAL") {
    return {
      displayLabel: rawLabel,
      family: "team-prop",
      instrumentKeyParts: [
        game.game.id,
        "team-prop",
        "team-total",
        teamKey,
        "over",
        line,
      ],
      line,
      participantKey: teamKey,
      rawFamily: "team-total",
      selection: "over",
    };
  }

  return {
    displayLabel: rawLabel,
    family: "other",
    instrumentKeyParts: [
      game.game.id,
      "other",
      series,
      teamKey ?? normalizeToken(market.yes_sub_title ?? rawLabel),
      line,
    ],
    line,
    participantKey: teamKey,
    rawFamily: series.toLowerCase(),
    selection: normalizeToken(market.yes_sub_title ?? "yes") || "yes",
  };
}

function snapshotProbability(market: KalshiDirectMarket) {
  const last = toNumber(market.last_price_dollars);
  const bid = toNumber(market.yes_bid_dollars);
  const ask = toNumber(market.yes_ask_dollars);
  if (last != null && last > 0) return last;
  if (bid != null && ask != null) return (bid + ask) / 2;
  return last ?? bid ?? ask ?? null;
}

export async function fetchKalshiNbaMilestones(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  limit?: number;
  maxPages?: number;
  minimumStartDate?: string;
}) {
  const baseUrl = options?.baseUrl ?? KALSHI_DEFAULT_BASE_URL;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const pageLimit = options?.limit ?? 100;
  const maxPages = options?.maxPages ?? 10;
  const headers = buildKalshiHeaders();
  const milestones: KalshiDirectMilestone[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${baseUrl}/milestones`);
    url.searchParams.set("category", "Sports");
    url.searchParams.set("competition", KALSHI_NBA_COMPETITION);
    url.searchParams.set("limit", String(pageLimit));
    if (options?.minimumStartDate) {
      url.searchParams.set("minimum_start_date", options.minimumStartDate);
    }
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetchWithRateLimit(fetchImpl, url.toString(), {
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `Kalshi milestones request failed with status ${response.status}.`
      );
    }
    const payload = (await response.json()) as KalshiDirectMilestonesResponse;
    milestones.push(...(payload.milestones ?? []));
    if (!payload.cursor || (payload.milestones ?? []).length === 0) break;
    cursor = payload.cursor;
  }

  return milestones;
}

export async function fetchKalshiDirectEvent(options: {
  eventTicker: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}) {
  const baseUrl = options.baseUrl ?? KALSHI_DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(`${baseUrl}/events/${options.eventTicker}`);
  url.searchParams.set("with_nested_markets", "true");
  const response = await fetchWithRateLimit(fetchImpl, url.toString(), {
    headers: buildKalshiHeaders(),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Kalshi event request failed with status ${response.status} for ${options.eventTicker}.`
    );
  }
  const payload = (await response.json()) as { event?: KalshiDirectEvent };
  return payload.event ?? null;
}

export async function syncKalshiNbaDirect(options?: {
  baseUrl?: string;
  captureMode?: "historical" | "live";
  eventTickers?: string[];
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  maxEvents?: number;
  minimumStartDate?: string;
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const captureMode = options?.captureMode ?? "live";

  try {
    const games =
      options?.games ??
      listResearchGames({
        league: "NBA",
        referenceNow: now().toISOString(),
        sport: "basketball",
      });
    const gameIndex = buildGameIndex(games);
    const milestones = options?.eventTickers
      ? []
      : await fetchKalshiNbaMilestones({
          baseUrl: options?.baseUrl,
          fetchImpl: options?.fetchImpl,
          minimumStartDate: options?.minimumStartDate,
        });

    const eventTickers = new Set(options?.eventTickers ?? []);
    for (const milestone of milestones) {
      for (const ticker of [
        ...(milestone.primary_event_tickers ?? []),
        ...(milestone.related_event_tickers ?? []),
      ]) {
        eventTickers.add(ticker);
      }
    }

    const limitedEventTickers = [...eventTickers].slice(
      0,
      options?.maxEvents ?? eventTickers.size
    );
    const matchedGameIds = new Set<string>();
    const unmatchedEventTickers: string[] = [];
    const marketErrors: KalshiDirectSyncSummary["marketErrors"] = [];
    let eventsFetched = 0;
    let sourceMarketsObserved = 0;
    let quoteObservationsWritten = 0;
    let rawPayloadsWritten = 0;

    for (const eventTicker of limitedEventTickers) {
      let event: KalshiDirectEvent | null;
      try {
        event = await fetchKalshiDirectEvent({
          baseUrl: options?.baseUrl,
          eventTicker,
          fetchImpl: options?.fetchImpl,
        });
      } catch (error) {
        marketErrors.push({
          error: error instanceof Error ? error.message : String(error),
          eventTicker,
        });
        continue;
      }
      if (!event) continue;
      eventsFetched += 1;

      const game = resolveGameByTicker(event.event_ticker, gameIndex);
      if (!game) {
        unmatchedEventTickers.push(event.event_ticker);
        continue;
      }
      matchedGameIds.add(game.game.id);

      for (const market of event.markets ?? []) {
        try {
          const shape = inferMarketShape(event, market, game);
          const instrumentId = buildStableId(shape.instrumentKeyParts);
          const sourceMarketId = `kalshi-${market.ticker.toLowerCase()}`;

          upsertMarketInstrument({
            displayLabel: shape.displayLabel,
            family: shape.family,
            gameId: game.game.id,
            id: instrumentId,
            inPlay: market.status === "active",
            line: shape.line,
            participantKey: shape.participantKey,
            selection: shape.selection,
          });

          const quoteVolume = resolveKalshiQuoteVolume(market);
          upsertSourceMarket({
            gameId: game.game.id,
            id: sourceMarketId,
            instrumentId,
            mappingStatus: "auto",
            rawFamily: shape.rawFamily,
            rawLabel: market.title ?? market.yes_sub_title ?? market.ticker,
            rawMetadata: {
              customStrike: market.custom_strike ?? null,
              eventTicker: event.event_ticker,
              expectedExpirationTime: market.expected_expiration_time ?? null,
              liquidityDollars: market.liquidity_dollars ?? null,
              marketStatus: market.status ?? null,
              marketTicker: market.ticker,
              noSubTitle: market.no_sub_title ?? null,
              result: market.result ?? null,
              seriesTicker: event.series_ticker,
              quoteVolumeSource: quoteVolume.source,
              volume24hFp: market.volume_24h_fp ?? null,
              volumeFp: market.volume_fp ?? null,
              yesAskSizeFp: market.yes_ask_size_fp ?? null,
              yesBidSizeFp: market.yes_bid_size_fp ?? null,
              yesSubTitle: market.yes_sub_title ?? null,
            },
            source: "kalshi",
            sourceMarketKey: market.ticker,
            sourceSelectionKey: shape.selection,
          });
          sourceMarketsObserved += 1;

          const bestBid = toNumber(market.yes_bid_dollars);
          const bestAsk = toNumber(market.yes_ask_dollars);
          const impliedProbability = snapshotProbability(market);
          const quote = recordQuoteObservation({
            bestAsk,
            bestBid,
            capturedAt: startedAt,
            depthScore: resolveKalshiDepthScore(market),
            heartbeatAfterMs: 60_000,
            impliedProbability,
            lineRaw: shape.line,
            oddsRaw: null,
            priceRaw: toNumber(market.last_price_dollars),
            sourceMarketId,
            volume: quoteVolume.value,
          });
          if (quote.wrote) quoteObservationsWritten += 1;

          const rawPayload = {
            event: {
              category: event.category ?? null,
              event_ticker: event.event_ticker,
              series_ticker: event.series_ticker,
              sub_title: event.sub_title ?? null,
              title: event.title,
            },
            market,
          } satisfies Record<string, unknown>;
          recordRawPayload({
            capturedAt: startedAt,
            contentHash: buildRawPayloadHash(rawPayload),
            entityId: sourceMarketId,
            entityType: "source_market",
            payloadJson: rawPayload,
            source: "kalshi",
          });
          rawPayloadsWritten += 1;
        } catch (error) {
          marketErrors.push({
            error: error instanceof Error ? error.message : String(error),
            eventTicker: event.event_ticker,
            marketTicker: market.ticker,
          });
        }
      }
    }

    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode,
      finishedAt,
      recordsSeen: sourceMarketsObserved,
      recordsWritten: quoteObservationsWritten,
      source: "kalshi",
      startedAt,
      status: "ok",
    });

    return {
      eventsFetched,
      eventsSeen: limitedEventTickers.length,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketErrors,
      milestonesSeen: milestones.length,
      ok: true as const,
      quoteObservationsWritten,
      rawPayloadsWritten,
      sourceMarketsObserved,
      startedAt,
      unmatchedEventTickers,
    } satisfies KalshiDirectSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode,
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "kalshi",
      startedAt,
      status: "error",
    });
    throw error;
  }
}
