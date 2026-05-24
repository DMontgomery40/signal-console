import { createHash } from "node:crypto";

import type { ResearchGameCard } from "@signal-console/domain";
import {
  appendHistoricalTick,
  listResearchGames,
  recordAdapterRun,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

import { buildOddsApiSelectionRecords } from "./odds-api";

type FetchLike = typeof fetch;

type OddsApiHistoricalOddsPayload = Parameters<
  typeof buildOddsApiSelectionRecords
>[1];
type OddsApiHistoricalEvent = Pick<
  OddsApiHistoricalOddsPayload,
  "away" | "date" | "home" | "id" | "league" | "sport" | "status"
>;

export type Bet365HistoricalSyncSummary = {
  bookmaker: "Bet365";
  eventsFetched: number;
  finishedAt: string;
  gamesMatched: number;
  marketsSeen: number;
  ok: true;
  quoteObservationsWritten: number;
  rawPayloadsWritten: number;
  recordsSeen: number;
  recordsWritten: number;
  source: "bet365";
  sourceMarketsObserved: number;
  startedAt: string;
};

function buildRawPayloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildOddsApiUrl(baseUrl: string, pathname: string) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(pathname.replace(/^\//, ""), normalizedBaseUrl);
}

function getOddsApiKey(options?: { apiKey?: string }) {
  return (
    options?.apiKey ??
    process.env.ODDS_API_KEY ??
    process.env.ODDS_API_IO_KEY ??
    null
  );
}

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeWords(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function namesCompatible(
  left: string | null | undefined,
  right: string | null | undefined
) {
  const leftToken = normalizeToken(left);
  const rightToken = normalizeToken(right);
  if (!leftToken || !rightToken) {
    return false;
  }
  if (
    leftToken === rightToken ||
    leftToken.includes(rightToken) ||
    rightToken.includes(leftToken)
  ) {
    return true;
  }

  const leftWords = new Set(normalizeWords(left));
  const rightWords = new Set(normalizeWords(right));
  if (leftWords.size === 0 || rightWords.size === 0) {
    return false;
  }

  const [smaller, larger] =
    leftWords.size <= rightWords.size
      ? [leftWords, rightWords]
      : [rightWords, leftWords];

  return [...smaller].every((word) => larger.has(word));
}

function isRealGame(game: ResearchGameCard) {
  return Boolean(
    game.outcome ||
    game.gameState?.status !== "scheduled" ||
    game.activeInstrumentCount > 0 ||
    game.coverage.availableSources.length > 0
  );
}

function isWithinDateRange(
  game: ResearchGameCard,
  dateFrom?: string,
  dateTo?: string
) {
  const scheduledDate = game.game.scheduledStart.slice(0, 10);
  if (dateFrom && scheduledDate < dateFrom) {
    return false;
  }
  if (dateTo && scheduledDate > dateTo) {
    return false;
  }
  return true;
}

function enumerateIsoDates(dateFrom: string, dateTo: string) {
  const dates: string[] = [];
  const cursor = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime())) {
    return dates;
  }

  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function selectHistoricalGames(options: {
  dateFrom?: string;
  dateTo?: string;
  games?: ResearchGameCard[];
}) {
  const games =
    options.games ??
    (options.dateFrom && options.dateTo
      ? enumerateIsoDates(options.dateFrom, options.dateTo).flatMap((date) =>
          listResearchGames({
            date,
            league: "NBA",
            limit: 200,
            scope: "all",
            sport: "basketball",
          })
        )
      : listResearchGames({
          league: "NBA",
          limit: 500,
          scope: "all",
          sport: "basketball",
        }));

  return games
    .filter(isRealGame)
    .filter((game) =>
      isWithinDateRange(game, options.dateFrom, options.dateTo)
    );
}

function findMatchingHistoricalGame(
  games: ResearchGameCard[],
  event: OddsApiHistoricalEvent
) {
  const eventMs = Date.parse(event.date);
  if (!Number.isFinite(eventMs)) {
    return null;
  }

  const matches = games
    .filter((game) => {
      const scheduledMs = Date.parse(game.game.scheduledStart);
      if (!Number.isFinite(scheduledMs)) {
        return false;
      }

      if (Math.abs(scheduledMs - eventMs) > 36 * 60 * 60_000) {
        return false;
      }

      const awayCandidates = [
        game.game.awayParticipant.abbreviation,
        game.game.awayParticipant.shortName,
        game.game.awayParticipant.name,
      ];
      const homeCandidates = [
        game.game.homeParticipant.abbreviation,
        game.game.homeParticipant.shortName,
        game.game.homeParticipant.name,
      ];

      return (
        awayCandidates.some((candidate) =>
          namesCompatible(candidate, event.away)
        ) &&
        homeCandidates.some((candidate) =>
          namesCompatible(candidate, event.home)
        )
      );
    })
    .sort(
      (left, right) =>
        Math.abs(Date.parse(left.game.scheduledStart) - eventMs) -
        Math.abs(Date.parse(right.game.scheduledStart) - eventMs)
    );

  return matches[0] ?? null;
}

async function fetchOddsApiHistoricalEvents(options: {
  apiKey: string;
  baseUrl?: string;
  dateFrom?: string;
  dateTo?: string;
  fetchImpl?: FetchLike;
  maxEvents?: number;
}) {
  const baseUrl = options.baseUrl ?? "https://api.odds-api.io/v3";
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiUrl(baseUrl, "historical/events");
  url.searchParams.set("apiKey", options.apiKey);
  url.searchParams.set("sport", "basketball");
  url.searchParams.set("league", "usa-nba");
  url.searchParams.set("bookmaker", "Bet365");
  url.searchParams.set("limit", String(options.maxEvents ?? 200));
  if (options.dateFrom) {
    url.searchParams.set("from", `${options.dateFrom}T00:00:00Z`);
  }
  if (options.dateTo) {
    url.searchParams.set("to", `${options.dateTo}T23:59:59Z`);
  }

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Odds-API historical events request for Bet365 failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as OddsApiHistoricalEvent[]) : [];
}

async function fetchOddsApiHistoricalOdds(options: {
  apiKey: string;
  baseUrl?: string;
  eventId: number | string;
  fetchImpl?: FetchLike;
}) {
  const baseUrl = options.baseUrl ?? "https://api.odds-api.io/v3";
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiUrl(baseUrl, "historical/odds");
  url.searchParams.set("apiKey", options.apiKey);
  url.searchParams.set("eventId", String(options.eventId));
  url.searchParams.set("bookmakers", "Bet365");

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Odds-API historical odds request for Bet365 event ${options.eventId} failed with status ${response.status}.`
    );
  }

  return (await response.json()) as OddsApiHistoricalOddsPayload;
}

export async function syncBet365Historical(options?: {
  apiKey?: string;
  baseUrl?: string;
  dateFrom?: string;
  dateTo?: string;
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  maxEvents?: number;
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const apiKey = getOddsApiKey({ apiKey: options?.apiKey });

  if (!apiKey) {
    throw new Error("Missing ODDS_API_KEY for Bet365 historical ingestion.");
  }

  try {
    const games = selectHistoricalGames({
      dateFrom: options?.dateFrom,
      dateTo: options?.dateTo,
      games: options?.games,
    });

    if (games.length === 0) {
      const finishedAt = now().toISOString();
      recordAdapterRun({
        captureMode: "historical",
        finishedAt,
        recordsSeen: 0,
        recordsWritten: 0,
        source: "bet365",
        startedAt,
        status: "ok",
      });
      return {
        bookmaker: "Bet365" as const,
        eventsFetched: 0,
        finishedAt,
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        source: "bet365" as const,
        sourceMarketsObserved: 0,
        startedAt,
      } satisfies Bet365HistoricalSyncSummary;
    }

    const defaultDateFrom = games
      .map((game) => game.game.scheduledStart.slice(0, 10))
      .sort()[0];
    const defaultDateTo = games
      .map((game) => game.game.scheduledStart.slice(0, 10))
      .sort()
      .at(-1);

    const events = await fetchOddsApiHistoricalEvents({
      apiKey,
      baseUrl: options?.baseUrl,
      dateFrom: options?.dateFrom ?? defaultDateFrom,
      dateTo: options?.dateTo ?? defaultDateTo,
      fetchImpl: options?.fetchImpl,
      maxEvents: options?.maxEvents,
    });

    const matchedGameIds = new Set<string>();
    const processedEventIds = new Set<string>();
    let marketsSeen = 0;
    let quoteObservationsWritten = 0;
    let rawPayloadsWritten = 0;
    let sourceMarketsObserved = 0;

    for (const event of events) {
      if (processedEventIds.has(String(event.id))) {
        continue;
      }
      processedEventIds.add(String(event.id));

      const game = findMatchingHistoricalGame(games, event);
      if (!game) {
        continue;
      }

      const historicalOdds = await fetchOddsApiHistoricalOdds({
        apiKey,
        baseUrl: options?.baseUrl,
        eventId: event.id,
        fetchImpl: options?.fetchImpl,
      });
      const records = buildOddsApiSelectionRecords(
        "Bet365",
        historicalOdds,
        game
      );
      if (records.length === 0) {
        continue;
      }

      matchedGameIds.add(game.game.id);
      marketsSeen += new Set(records.map((record) => record.sourceMarketKey))
        .size;

      for (const record of records) {
        if (record.instrumentId) {
          upsertMarketInstrument({
            displayLabel: record.displayLabel,
            family: record.family,
            gameId: record.gameId,
            id: record.instrumentId,
            inPlay: record.inPlay,
            line: record.line,
            participantKey: record.participantKey,
            selection: record.selection,
          });
        }

        upsertSourceMarket({
          gameId: record.gameId,
          id: record.sourceMarketId,
          instrumentId: record.instrumentId,
          mappingStatus: record.instrumentId ? "auto" : "unmapped",
          rawFamily: record.rawFamily,
          rawLabel: record.rawLabel,
          rawMetadata: {
            bookmaker: "Bet365",
            bookmakerId: historicalOdds.bookmakerIds?.Bet365 ?? null,
            bookmakerUrl: historicalOdds.urls?.Bet365 ?? null,
            eventId: historicalOdds.id,
            eventStatus: historicalOdds.status ?? null,
            league: historicalOdds.league?.slug ?? null,
            provider: "odds-api.io",
          },
          source: "bet365",
          sourceMarketKey: record.sourceMarketKey,
          sourceSelectionKey: record.sourceSelectionKey,
        });
        sourceMarketsObserved += 1;

        const tickResult = appendHistoricalTick({
          bestAsk: record.bestAsk,
          bestBid: record.bestBid,
          capturedAt: record.capturedAt,
          depthScore: record.depthScore,
          impliedProbability: record.impliedProbability,
          lineRaw: record.lineRaw,
          oddsRaw: record.oddsRaw,
          priceRaw: record.priceRaw,
          sourceMarketId: record.sourceMarketId,
          volume: record.volume,
        });
        if (tickResult.inserted) {
          quoteObservationsWritten += 1;
        }

        recordRawPayload({
          capturedAt: record.capturedAt,
          contentHash: buildRawPayloadHash(record.rawPayloadJson),
          entityId: record.sourceMarketId,
          entityType: "source_market_historical",
          payloadJson: record.rawPayloadJson,
          source: "bet365",
        });
        rawPayloadsWritten += 1;
      }
    }

    const finishedAt = now().toISOString();
    const recordsSeen = sourceMarketsObserved;
    const recordsWritten =
      sourceMarketsObserved + quoteObservationsWritten + rawPayloadsWritten;

    recordAdapterRun({
      captureMode: "historical",
      finishedAt,
      recordsSeen,
      recordsWritten: quoteObservationsWritten,
      source: "bet365",
      startedAt,
      status: "ok",
    });

    return {
      bookmaker: "Bet365" as const,
      eventsFetched: events.length,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketsSeen,
      ok: true as const,
      quoteObservationsWritten,
      rawPayloadsWritten,
      recordsSeen,
      recordsWritten,
      source: "bet365" as const,
      sourceMarketsObserved,
      startedAt,
    } satisfies Bet365HistoricalSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "bet365",
      startedAt,
      status: "error",
    });
    throw error;
  }
}
