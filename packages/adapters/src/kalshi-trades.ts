import { createHash } from "node:crypto";

import {
  getDatabase,
  recordAdapterRun,
  recordMarketMicrostructureEvent,
  recordRawPayload,
} from "@signal-console/shared";

type FetchLike = typeof fetch;

const KALSHI_DEFAULT_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const DEFAULT_INTER_REQUEST_MS = 250;

type KalshiTradesPayload = {
  trades?: Array<{
    trade_id?: string;
    ticker?: string;
    count?: number;
    yes_price?: number;
    no_price?: number;
    taker_side?: string;
    created_time?: string;
  }>;
  cursor?: string | null;
};

function buildKalshiHeaders() {
  const headers: Record<string, string> = {};
  if (process.env.KALSHI_API_KEY) {
    headers["KALSHI-ACCESS-KEY"] = process.env.KALSHI_API_KEY;
  }
  return headers;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function toUnixSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function toIso(value: number | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }
  return value;
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function fetchTradesPage(
  fetchImpl: FetchLike,
  baseUrl: string,
  ticker: string,
  minTs: number,
  maxTs: number,
  cursor: string | null
): Promise<KalshiTradesPayload> {
  const url = new URL("/trade-api/v2/markets/trades", baseUrl);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("min_ts", String(minTs));
  url.searchParams.set("max_ts", String(maxTs));
  url.searchParams.set("limit", "1000");
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetchImpl(url.toString(), {
    headers: buildKalshiHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `Kalshi trades request for ${ticker} failed with status ${response.status}.`
    );
  }
  return (await response.json()) as KalshiTradesPayload;
}

type KalshiTickerRow = {
  sourceMarketId: string;
  ticker: string;
  gameId: string;
  instrumentId: string | null;
};

function selectKalshiTickers(filters: {
  gameId?: string;
  league?: string;
}): KalshiTickerRow[] {
  const db = getDatabase();
  const params: unknown[] = [];
  const clauses: string[] = ["sm.source = 'kalshi'"];
  if (filters.gameId) {
    clauses.push("sm.game_id = ?");
    params.push(filters.gameId);
  } else if (filters.league) {
    clauses.push("g.league = ?");
    params.push(filters.league);
  } else {
    clauses.push("g.sport = 'basketball'");
  }
  const rows = db
    .prepare(
      `SELECT
         sm.id AS sourceMarketId,
         sm.source_market_key AS ticker,
         sm.game_id AS gameId,
         sm.instrument_id AS instrumentId
       FROM source_markets sm
       JOIN games g ON g.id = sm.game_id
       WHERE ${clauses.join(" AND ")}`
    )
    .all(...params) as KalshiTickerRow[];
  return rows;
}

export type KalshiTradesSyncSummary = {
  source: "kalshi";
  startedAt: string;
  finishedAt: string;
  tickersScanned: number;
  tradesSeen: number;
  tradesWritten: number;
  errors: Array<{ ticker: string; message: string }>;
};

export async function syncKalshiNbaTrades(options: {
  since: string;
  until: string;
  gameId?: string;
  league?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  interRequestMs?: number;
  maxTickers?: number;
}): Promise<KalshiTradesSyncSummary> {
  const baseUrl = options.baseUrl ?? KALSHI_DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const interRequestMs = options.interRequestMs ?? DEFAULT_INTER_REQUEST_MS;
  const minTs = toUnixSeconds(options.since);
  const maxTs = toUnixSeconds(options.until);
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) {
    throw new Error(
      `Invalid window for syncKalshiNbaTrades: since=${options.since} until=${options.until}`
    );
  }

  const tickers = selectKalshiTickers({
    gameId: options.gameId,
    league: options.league,
  });
  const cap = options.maxTickers ?? tickers.length;
  const targets = tickers.slice(0, cap);

  const startedAt = new Date().toISOString();
  let tradesSeen = 0;
  let tradesWritten = 0;
  const errors: Array<{ ticker: string; message: string }> = [];

  for (const target of targets) {
    try {
      let cursor: string | null = null;
      let pageCount = 0;
      const maxPages = 50;
      while (pageCount < maxPages) {
        pageCount += 1;
        const payload: KalshiTradesPayload = await fetchTradesPage(
          fetchImpl,
          baseUrl,
          target.ticker,
          minTs,
          maxTs,
          cursor
        );
        const trades = payload.trades ?? [];
        for (const trade of trades) {
          tradesSeen += 1;
          const createdIso = toIso(trade.created_time);
          if (!createdIso) continue;
          const yesPriceCents = trade.yes_price;
          const size = trade.count;
          if (yesPriceCents == null || size == null) continue;
          const tradePrice = yesPriceCents / 100;
          const notional = tradePrice * size;
          const tradeJson = trade as unknown as Record<string, unknown>;
          const raw = recordRawPayload({
            source: "kalshi",
            capturedAt: new Date().toISOString(),
            entityType: "kalshi-trade",
            entityId: `${target.ticker}:${trade.trade_id ?? `${trade.created_time ?? ""}-${trade.count ?? ""}`}`,
            payloadJson: tradeJson,
            contentHash: hashPayload(tradeJson),
          });
          const result = recordMarketMicrostructureEvent({
            source: "kalshi",
            sourceMarketId: target.sourceMarketId,
            gameId: target.gameId,
            instrumentId: target.instrumentId ?? null,
            eventType: "trade",
            apiSurface: "trade-api/v2/markets/trades",
            eventTimestamp: createdIso,
            capturedAt: new Date().toISOString(),
            price: tradePrice,
            tradePrice,
            size,
            notional,
            volume: null,
            finalMarketVolume: null,
            volumeShare: null,
            previousPrice: null,
            bestBid: null,
            bestAsk: null,
            spread: null,
            depthScore: null,
            rawPayloadId: raw.id ?? null,
            rawMetadata: { takerSide: trade.taker_side ?? null },
          });
          if (result.inserted) {
            tradesWritten += 1;
          }
        }
        if (!payload.cursor || trades.length === 0) break;
        cursor = payload.cursor;
        if (interRequestMs > 0) {
          await sleep(interRequestMs);
        }
      }
    } catch (error) {
      errors.push({
        ticker: target.ticker,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finishedAt = new Date().toISOString();
  recordAdapterRun({
    source: "kalshi-trades",
    startedAt,
    finishedAt,
    status: errors.length === 0 ? "ok" : "error",
    captureMode: "historical",
    recordsSeen: tradesSeen,
    recordsWritten: tradesWritten,
    errorCode: errors.length > 0 ? "PARTIAL_FAILURES" : null,
    errorMessage:
      errors.length > 0
        ? `${errors.length} tickers failed: ${errors
            .slice(0, 3)
            .map((e) => e.ticker)
            .join(", ")}`
        : null,
  });

  return {
    source: "kalshi",
    startedAt,
    finishedAt,
    tickersScanned: targets.length,
    tradesSeen,
    tradesWritten,
    errors,
  };
}
