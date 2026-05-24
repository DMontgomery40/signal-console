import { createHash } from "node:crypto";

import type { MarketFamily, ResearchGameCard } from "@signal-console/domain";
import {
  appendHistoricalTick,
  getDatabase,
  listResearchGames,
  recordAdapterRun,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

type FetchLike = typeof fetch;

const KALSHI_DEFAULT_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_NBA_SERIES_TICKER = "KXNBAGAME";
const CANDLESTICK_MAX_WINDOW_SECONDS_BY_INTERVAL: Record<
  1 | 60 | 1440,
  number
> = {
  1: 60 * 60, // 1-minute candles: 1-hour windows (Kalshi caps tight)
  60: 60 * 60 * 24 * 7, // 1-hour candles: 7-day windows
  1440: 60 * 60 * 24 * 365, // 1-day candles: 1-year window
};
const DEFAULT_INTER_REQUEST_MS = 250;
const MAX_RETRIES_ON_429 = 5;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRateLimit(
  fetchImpl: FetchLike,
  url: string,
  options?: { interRequestMs?: number }
): Promise<Response> {
  const interRequestMs = options?.interRequestMs ?? DEFAULT_INTER_REQUEST_MS;
  let attempt = 0;
  let waitMs = 1000;

  while (attempt <= MAX_RETRIES_ON_429) {
    if (attempt === 0 && interRequestMs > 0) {
      await sleep(interRequestMs);
    }
    const response = await fetchImpl(url);
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

  return fetchImpl(url);
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

type KalshiCandlestick = {
  end_period_ts: number;
  open_interest_fp?: string | null;
  volume_fp?: string | null;
  price?: {
    close_dollars?: string | null;
    high_dollars?: string | null;
    low_dollars?: string | null;
    mean_dollars?: string | null;
    open_dollars?: string | null;
    previous_dollars?: string | null;
  } | null;
  yes_ask?: {
    close_dollars?: string | null;
    high_dollars?: string | null;
    low_dollars?: string | null;
    open_dollars?: string | null;
  } | null;
  yes_bid?: {
    close_dollars?: string | null;
    high_dollars?: string | null;
    low_dollars?: string | null;
    open_dollars?: string | null;
  } | null;
};

type KalshiMarket = {
  ticker: string;
  status: string;
  open_time?: string | null;
  close_time?: string | null;
  yes_sub_title?: string | null;
  no_sub_title?: string | null;
  result?: string | null;
};

type KalshiEvent = {
  event_ticker: string;
  title: string;
  sub_title?: string | null;
  series_ticker: string;
  markets?: KalshiMarket[];
};

type KalshiEventsResponse = {
  cursor?: string | null;
  events: KalshiEvent[];
};

export type KalshiHistoricalSyncSummary = {
  candlesFetched: number;
  eventsSeen: number;
  finishedAt: string;
  gamesMatched: number;
  marketErrors: Array<{ error: string; marketTicker: string }>;
  marketsConsidered: number;
  ok: true;
  rawPayloadsWritten: number;
  startedAt: string;
  ticksWritten: number;
};

type KalshiHistoricalTarget = {
  closeTime: string | null;
  displayLabel: string;
  eventTicker: string | null;
  family: MarketFamily | null;
  gameId: string;
  instrumentId: string | null;
  line: number | null;
  mappingStatus: string;
  marketTicker: string;
  openTime: string | null;
  participantKey: string | null;
  rawFamily: string | null;
  rawLabel: string | null;
  scheduledStart: string;
  selection: string | null;
  seriesTicker: string;
  sourceMarketId: string;
};

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildGameKey(date: string, teamKeys: string[]) {
  return `${date}::${teamKeys
    .map((key) => normalizeToken(key))
    .sort()
    .join("::")}`;
}

function parseKalshiEventDate(eventTicker: string): string | null {
  const match = eventTicker.match(
    /KXNBAGAME-(\d{2})([A-Z]{3})(\d{2})[A-Z]{3}[A-Z]{3}$/
  );
  if (!match) {
    return null;
  }

  const [, yy, monthAbbr, dd] = match;
  const monthIndex = MONTH_ABBREVIATIONS[monthAbbr];
  if (monthIndex == null) {
    return null;
  }

  const year = 2000 + Number(yy);
  const day = Number(dd);
  const utc = new Date(Date.UTC(year, monthIndex, day));
  return utc.toISOString().slice(0, 10);
}

function parseKalshiTeamAbbreviations(
  eventTicker: string
): { away: string; home: string } | null {
  const match = eventTicker.match(
    /KXNBAGAME-\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})$/
  );
  if (!match) {
    return null;
  }

  return { away: match[1], home: match[2] };
}

function toNumberFromDollars(value: string | null | undefined) {
  if (value == null || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function resolveKalshiGame(
  event: KalshiEvent,
  gameIndex: Map<string, ResearchGameCard>
) {
  const teams = parseKalshiTeamAbbreviations(event.event_ticker);
  const date = parseKalshiEventDate(event.event_ticker);
  if (!teams || !date) {
    return null;
  }

  const key = buildGameKey(date, [teams.away, teams.home]);
  return gameIndex.get(key) ?? null;
}

function resolveParticipantKey(market: KalshiMarket, game: ResearchGameCard) {
  const yesLabel = normalizeToken(market.yes_sub_title ?? "");
  const tickerSuffix = market.ticker.split("-").pop() ?? "";
  const tickerKey = normalizeToken(tickerSuffix);

  const candidates = [
    {
      labels: [
        normalizeToken(game.game.homeParticipant.abbreviation),
        normalizeToken(game.game.homeParticipant.key),
        normalizeToken(game.game.homeParticipant.shortName),
        normalizeToken(game.game.homeParticipant.name),
      ],
      key: game.game.homeParticipant.key,
    },
    {
      labels: [
        normalizeToken(game.game.awayParticipant.abbreviation),
        normalizeToken(game.game.awayParticipant.key),
        normalizeToken(game.game.awayParticipant.shortName),
        normalizeToken(game.game.awayParticipant.name),
      ],
      key: game.game.awayParticipant.key,
    },
  ];

  for (const candidate of candidates) {
    if (
      candidate.labels.some(
        (label) => label && (label === tickerKey || label === yesLabel)
      )
    ) {
      return candidate.key;
    }
  }

  return null;
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

function parseJsonObject(value: string | null | undefined) {
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

function chooseHistoricalWindow(target: KalshiHistoricalTarget) {
  const scheduledMs = Date.parse(target.scheduledStart);
  const openMs = Date.parse(target.openTime ?? "");
  const closeMs = Date.parse(target.closeTime ?? "");
  const fallbackStart = Number.isFinite(scheduledMs)
    ? scheduledMs - 24 * 60 * 60_000
    : Number.NaN;
  const fallbackEnd = Number.isFinite(scheduledMs)
    ? scheduledMs + 6 * 60 * 60_000
    : Number.NaN;

  const startMs = Number.isFinite(openMs)
    ? openMs
    : Number.isFinite(fallbackStart)
      ? fallbackStart
      : Number.NaN;
  const endMs = Number.isFinite(closeMs)
    ? closeMs
    : Number.isFinite(fallbackEnd)
      ? fallbackEnd
      : Number.NaN;

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return null;
  }

  return {
    endTs: Math.floor(endMs / 1000),
    startTs: Math.floor(startMs / 1000),
  };
}

function selectExistingKalshiHistoricalTargets(games: ResearchGameCard[]) {
  const gameIds = games.map((game) => game.game.id);
  if (gameIds.length === 0) return [] as KalshiHistoricalTarget[];

  const placeholders = Array.from(gameIds, () => "?").join(", ");
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
         sm.id AS sourceMarketId,
         sm.source_market_key AS marketTicker,
         sm.instrument_id AS instrumentId,
         sm.mapping_status AS mappingStatus,
         sm.raw_family AS rawFamily,
         sm.raw_label AS rawLabel,
         sm.raw_metadata_json AS rawMetadataJson,
         sm.game_id AS gameId,
         mi.family AS family,
         mi.line AS line,
         mi.participant_key AS participantKey,
         mi.selection AS selection,
         mi.display_label AS displayLabel,
         g.scheduled_start AS scheduledStart
       FROM source_markets sm
       JOIN games g ON g.id = sm.game_id
       LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id
       WHERE sm.source = 'kalshi'
         AND sm.game_id IN (${placeholders})`
    )
    .all(...gameIds) as Array<Record<string, unknown>>;

  return rows
    .map((row) => {
      const metadata = parseJsonObject(
        row.rawMetadataJson == null ? null : String(row.rawMetadataJson)
      );
      const seriesTicker =
        typeof metadata.seriesTicker === "string"
          ? metadata.seriesTicker
          : null;
      if (!seriesTicker) return null;

      return {
        closeTime:
          typeof metadata.closeTime === "string" ? metadata.closeTime : null,
        displayLabel:
          row.displayLabel == null
            ? String(row.rawLabel ?? row.marketTicker ?? "")
            : String(row.displayLabel),
        eventTicker:
          typeof metadata.eventTicker === "string"
            ? metadata.eventTicker
            : null,
        family:
          row.family == null ? null : (String(row.family) as MarketFamily),
        gameId: String(row.gameId),
        instrumentId:
          row.instrumentId == null ? null : String(row.instrumentId),
        line: row.line == null ? null : Number(row.line),
        mappingStatus: String(row.mappingStatus ?? "auto"),
        marketTicker: String(row.marketTicker),
        openTime:
          typeof metadata.openTime === "string" ? metadata.openTime : null,
        participantKey:
          row.participantKey == null ? null : String(row.participantKey),
        rawFamily: row.rawFamily == null ? null : String(row.rawFamily),
        rawLabel: row.rawLabel == null ? null : String(row.rawLabel),
        scheduledStart: String(row.scheduledStart),
        selection: row.selection == null ? null : String(row.selection),
        seriesTicker,
        sourceMarketId: String(row.sourceMarketId),
      } satisfies KalshiHistoricalTarget;
    })
    .filter((row): row is KalshiHistoricalTarget => row != null);
}

export async function fetchKalshiSettledNbaEvents(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  limit?: number;
  maxPages?: number;
}) {
  const baseUrl = options?.baseUrl ?? KALSHI_DEFAULT_BASE_URL;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const pageLimit = options?.limit ?? 200;
  const maxPages = options?.maxPages ?? 50;

  const collected: KalshiEvent[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("series_ticker", KALSHI_NBA_SERIES_TICKER);
    url.searchParams.set("status", "settled");
    url.searchParams.set("with_nested_markets", "true");
    url.searchParams.set("limit", String(pageLimit));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetchWithRateLimit(fetchImpl, url.toString());
    if (!response.ok) {
      throw new Error(
        `Kalshi events request failed with status ${response.status}.`
      );
    }

    const payload = (await response.json()) as KalshiEventsResponse;
    collected.push(...(payload.events ?? []));

    if (!payload.cursor || (payload.events ?? []).length === 0) {
      break;
    }

    cursor = payload.cursor;
  }

  return collected;
}

export async function fetchKalshiCandlesticks(options: {
  endTs: number;
  marketTicker: string;
  periodIntervalMinutes: 1 | 60 | 1440;
  startTs: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  seriesTicker?: string;
}) {
  const baseUrl = options.baseUrl ?? KALSHI_DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const seriesTicker = options.seriesTicker ?? KALSHI_NBA_SERIES_TICKER;

  const candles: KalshiCandlestick[] = [];
  let cursorStart = options.startTs;
  const maxWindowSeconds =
    CANDLESTICK_MAX_WINDOW_SECONDS_BY_INTERVAL[options.periodIntervalMinutes] ??
    60 * 60 * 24 * 7;

  while (cursorStart < options.endTs) {
    const windowEnd = Math.min(cursorStart + maxWindowSeconds, options.endTs);
    const url = new URL(
      `${baseUrl}/series/${seriesTicker}/markets/${options.marketTicker}/candlesticks`
    );
    url.searchParams.set("start_ts", String(cursorStart));
    url.searchParams.set("end_ts", String(windowEnd));
    url.searchParams.set(
      "period_interval",
      String(options.periodIntervalMinutes)
    );

    const response = await fetchWithRateLimit(fetchImpl, url.toString());
    if (response.status === 404) {
      break;
    }
    if (!response.ok) {
      throw new Error(
        `Kalshi candlestick request failed with status ${response.status} for ${options.marketTicker}.`
      );
    }

    const payload = (await response.json()) as {
      candlesticks?: KalshiCandlestick[];
    };
    candles.push(...(payload.candlesticks ?? []));

    if (windowEnd >= options.endTs) {
      break;
    }
    cursorStart = windowEnd;
  }

  return candles;
}

async function backfillExistingKalshiHistoricalTarget(options: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  periodIntervalMinutes: 1 | 60;
  startedAt: string;
  target: KalshiHistoricalTarget;
}) {
  const window = chooseHistoricalWindow(options.target);
  if (!window) {
    return {
      candlesFetched: 0,
      rawPayloadsWritten: 0,
      ticksWritten: 0,
    };
  }

  const candles = await fetchKalshiCandlesticks({
    baseUrl: options.baseUrl,
    endTs: window.endTs,
    fetchImpl: options.fetchImpl,
    marketTicker: options.target.marketTicker,
    periodIntervalMinutes: options.periodIntervalMinutes,
    seriesTicker: options.target.seriesTicker,
    startTs: window.startTs,
  });

  let ticksWritten = 0;
  for (const candle of candles) {
    const capturedAt = new Date(candle.end_period_ts * 1000).toISOString();

    const closePrice =
      toNumberFromDollars(candle.price?.close_dollars) ??
      (toNumberFromDollars(candle.yes_bid?.close_dollars) != null &&
      toNumberFromDollars(candle.yes_ask?.close_dollars) != null
        ? (Number(candle.yes_bid?.close_dollars ?? 0) +
            Number(candle.yes_ask?.close_dollars ?? 0)) /
          2
        : null);

    const bestBid = toNumberFromDollars(candle.yes_bid?.close_dollars);
    const bestAsk = toNumberFromDollars(candle.yes_ask?.close_dollars);
    const volume = toNumberFromDollars(candle.volume_fp);

    if (closePrice == null && bestBid == null && bestAsk == null) {
      continue;
    }

    const result = appendHistoricalTick({
      bestAsk,
      bestBid,
      capturedAt,
      depthScore: null,
      impliedProbability: closePrice,
      lineRaw: options.target.line,
      oddsRaw: null,
      priceRaw: closePrice,
      sourceMarketId: options.target.sourceMarketId,
      volume,
    });

    if (result.inserted) {
      ticksWritten += 1;
    }
  }

  const rawPayload = {
    market: {
      closeTime: options.target.closeTime,
      eventTicker: options.target.eventTicker,
      marketTicker: options.target.marketTicker,
      openTime: options.target.openTime,
      seriesTicker: options.target.seriesTicker,
      sourceMarketId: options.target.sourceMarketId,
    },
    candles: candles.slice(0, 5),
    candlesCount: candles.length,
  } satisfies Record<string, unknown>;

  recordRawPayload({
    capturedAt: options.startedAt,
    contentHash: buildRawPayloadHash(rawPayload),
    entityId: options.target.sourceMarketId,
    entityType: "source_market_historical",
    payloadJson: rawPayload,
    source: "kalshi",
  });

  return {
    candlesFetched: candles.length,
    rawPayloadsWritten: 1,
    ticksWritten,
  };
}

export async function syncKalshiNbaHistorical(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  maxEvents?: number;
  now?: () => Date;
  periodIntervalMinutes?: 1 | 60;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const periodIntervalMinutes = options?.periodIntervalMinutes ?? 60;

  try {
    const games =
      options?.games ??
      listResearchGames({
        league: "NBA",
        scope: "all",
        sport: "basketball",
      });
    const gameIndex = buildGameIndex(games);
    const events = await fetchKalshiSettledNbaEvents({
      baseUrl: options?.baseUrl,
      fetchImpl: options?.fetchImpl,
    });

    const maxEvents = options?.maxEvents ?? events.length;
    const limitedEvents = events.slice(0, maxEvents);

    const matchedGameIds = new Set<string>();
    const marketErrors: Array<{ error: string; marketTicker: string }> = [];
    const processedSourceMarketIds = new Set<string>();
    let marketsConsidered = 0;
    let candlesFetched = 0;
    let rawPayloadsWritten = 0;
    let ticksWritten = 0;

    for (const event of limitedEvents) {
      const game = resolveKalshiGame(event, gameIndex);
      if (!game) {
        continue;
      }

      matchedGameIds.add(game.game.id);

      for (const market of event.markets ?? []) {
        if (!market.open_time || !market.close_time) {
          continue;
        }

        marketsConsidered += 1;

        const participantKey = resolveParticipantKey(market, game);
        if (!participantKey) {
          continue;
        }

        const startTs = Math.floor(new Date(market.open_time).getTime() / 1000);
        const endTs = Math.floor(new Date(market.close_time).getTime() / 1000);
        if (
          !Number.isFinite(startTs) ||
          !Number.isFinite(endTs) ||
          endTs <= startTs
        ) {
          continue;
        }

        let candles: KalshiCandlestick[];
        try {
          candles = await fetchKalshiCandlesticks({
            baseUrl: options?.baseUrl,
            endTs,
            fetchImpl: options?.fetchImpl,
            marketTicker: market.ticker,
            periodIntervalMinutes,
            startTs,
          });
        } catch (error) {
          marketErrors.push({
            error: error instanceof Error ? error.message : String(error),
            marketTicker: market.ticker,
          });
          continue;
        }
        candlesFetched += candles.length;

        if (candles.length === 0) {
          continue;
        }

        const instrumentId = buildStableId([
          game.game.id,
          "moneyline",
          participantKey,
        ]);
        const sourceMarketId = `kalshi-${market.ticker.toLowerCase()}`;
        const displayLabel = `${market.yes_sub_title ?? participantKey} moneyline`;

        upsertMarketInstrument({
          displayLabel,
          family: "moneyline",
          gameId: game.game.id,
          id: instrumentId,
          inPlay: false,
          line: null,
          participantKey,
          selection: participantKey,
        });

        upsertSourceMarket({
          gameId: game.game.id,
          id: sourceMarketId,
          instrumentId,
          mappingStatus: "auto",
          rawFamily: "moneyline",
          rawLabel: market.yes_sub_title ?? participantKey,
          rawMetadata: {
            closeTime: market.close_time,
            eventTicker: event.event_ticker,
            marketTicker: market.ticker,
            openTime: market.open_time,
            result: market.result ?? null,
            seriesTicker: event.series_ticker,
          },
          source: "kalshi",
          sourceMarketKey: market.ticker,
          sourceSelectionKey: participantKey,
        });
        processedSourceMarketIds.add(sourceMarketId);

        for (const candle of candles) {
          const capturedAt = new Date(
            candle.end_period_ts * 1000
          ).toISOString();

          const closePrice =
            toNumberFromDollars(candle.price?.close_dollars) ??
            (toNumberFromDollars(candle.yes_bid?.close_dollars) != null &&
            toNumberFromDollars(candle.yes_ask?.close_dollars) != null
              ? (Number(candle.yes_bid?.close_dollars ?? 0) +
                  Number(candle.yes_ask?.close_dollars ?? 0)) /
                2
              : null);

          const bestBid = toNumberFromDollars(candle.yes_bid?.close_dollars);
          const bestAsk = toNumberFromDollars(candle.yes_ask?.close_dollars);
          const volume = toNumberFromDollars(candle.volume_fp);

          if (closePrice == null && bestBid == null && bestAsk == null) {
            continue;
          }

          const result = appendHistoricalTick({
            bestAsk,
            bestBid,
            capturedAt,
            depthScore: null,
            impliedProbability: closePrice,
            lineRaw: null,
            oddsRaw: null,
            priceRaw: closePrice,
            sourceMarketId,
            volume,
          });

          if (result.inserted) {
            ticksWritten += 1;
          }
        }

        const rawPayload = {
          event: {
            event_ticker: event.event_ticker,
            series_ticker: event.series_ticker,
            sub_title: event.sub_title ?? null,
            title: event.title,
          },
          market: {
            close_time: market.close_time,
            open_time: market.open_time,
            result: market.result ?? null,
            ticker: market.ticker,
            yes_sub_title: market.yes_sub_title ?? null,
          },
          candles: candles.slice(0, 5),
          candlesCount: candles.length,
        } satisfies Record<string, unknown>;

        recordRawPayload({
          capturedAt: startedAt,
          contentHash: buildRawPayloadHash(rawPayload),
          entityId: sourceMarketId,
          entityType: "source_market_historical",
          payloadJson: rawPayload,
          source: "kalshi",
        });
        rawPayloadsWritten += 1;
      }
    }

    const selectedGameIds = options?.games
      ? new Set(games.map((game) => game.game.id))
      : matchedGameIds;
    const selectedGames = games.filter((game) =>
      selectedGameIds.has(game.game.id)
    );
    const existingTargets = selectExistingKalshiHistoricalTargets(
      selectedGames
    ).filter((target) => !processedSourceMarketIds.has(target.sourceMarketId));

    for (const target of existingTargets) {
      marketsConsidered += 1;
      try {
        const result = await backfillExistingKalshiHistoricalTarget({
          baseUrl: options?.baseUrl,
          fetchImpl: options?.fetchImpl,
          periodIntervalMinutes,
          startedAt,
          target,
        });
        candlesFetched += result.candlesFetched;
        rawPayloadsWritten += result.rawPayloadsWritten;
        ticksWritten += result.ticksWritten;
      } catch (error) {
        marketErrors.push({
          error: error instanceof Error ? error.message : String(error),
          marketTicker: target.marketTicker,
        });
      }
    }

    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
      finishedAt,
      recordsSeen: marketsConsidered,
      recordsWritten: ticksWritten,
      source: "kalshi",
      startedAt,
      status: "ok",
    });

    return {
      candlesFetched,
      eventsSeen: events.length,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketErrors,
      marketsConsidered,
      ok: true as const,
      rawPayloadsWritten,
      startedAt,
      ticksWritten,
    } satisfies KalshiHistoricalSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
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
