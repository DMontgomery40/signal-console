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

type FetchLike = typeof fetch;

const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_FIDELITY_MINUTES = 1;
const DEFAULT_WINDOW_SECONDS_BEFORE_GAME = 60 * 60 * 24; // 24h pre
const DEFAULT_WINDOW_SECONDS_AFTER_GAME = 60 * 60 * 6; // 6h post

type PolymarketTeam = {
  abbreviation?: string | null;
  alias?: string | null;
  id: number | string;
  name: string;
};

type PolymarketMarket = {
  clobTokenIds?: string | string[] | null;
  description?: string | null;
  id: string;
  line?: number | null;
  outcomes: string;
  outcomePrices?: string | null;
  question: string;
  slug: string;
  sportsMarketType?: string | null;
  volume?: number | string | null;
};

type PolymarketEvent = {
  eventDate?: string | null;
  id: string;
  liquidity?: number | string | null;
  markets?: PolymarketMarket[];
  slug: string;
  startTime?: string | null;
  teams?: PolymarketTeam[];
  title: string;
};

type PolymarketPricePoint = {
  t: number;
  p: number;
};

type HistoricalMarketType =
  | "assists"
  | "moneyline"
  | "points"
  | "rebounds"
  | "threes";

export type PolymarketHistoricalSyncSummary = {
  eventsSeen: number;
  finishedAt: string;
  gamesMatched: number;
  marketsConsidered: number;
  ok: true;
  pointsFetched: number;
  rawPayloadsWritten: number;
  startedAt: string;
  ticksWritten: number;
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

function buildEventDateCandidates(event: {
  eventDate?: string | null;
  startTime?: string | null;
}) {
  const candidates = new Set<string>();
  const eventDate = event.eventDate?.slice(0, 10);
  const startDate = event.startTime?.slice(0, 10);
  if (eventDate) candidates.add(eventDate);
  if (startDate) candidates.add(startDate);
  return [...candidates];
}

function shiftIsoDate(iso: string, deltaDays: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function parseJsonArray(
  value: string | null | undefined
): Array<number | string> {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<number | string>) : [];
  } catch {
    return [];
  }
}

function parseClobTokenIds(
  raw: string | string[] | null | undefined
): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as unknown[]).map(String) : [];
  } catch {
    return [];
  }
}

function toNumber(value: number | string | null | undefined) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

function isHistoricalMarketType(
  value: string | null | undefined
): value is HistoricalMarketType {
  return ["assists", "moneyline", "points", "rebounds", "threes"].includes(
    value ?? ""
  );
}

function describePlayerPropMetric(
  marketType: Exclude<HistoricalMarketType, "moneyline">
) {
  switch (marketType) {
    case "assists":
      return "assists";
    case "points":
      return "points";
    case "rebounds":
      return "rebounds";
    case "threes":
      return "threes";
  }
}

function parsePlayerPropQuestion(question: string) {
  if (!question.includes(" O/U ")) {
    return null;
  }

  const [subject] = question.split(":");
  const subjectKey = normalizeToken(subject);
  if (!subject || !subjectKey) {
    return null;
  }

  return {
    subject,
    subjectKey,
  };
}

function normalizePlayerPropSelection(outcomeLabel: string, index: number) {
  const normalized = normalizeToken(outcomeLabel);
  if (normalized === "yes" || normalized === "over") return "over";
  if (normalized === "no" || normalized === "under") return "under";
  return index === 0 ? "over" : "under";
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

function resolveEventGame(
  event: PolymarketEvent,
  gameIndex: Map<string, ResearchGameCard>
) {
  if (!event.teams || event.teams.length !== 2) {
    return null;
  }

  const teamKeys = event.teams.map(
    (team) => team.abbreviation ?? team.alias ?? team.name
  );
  for (const date of buildEventDateCandidates(event)) {
    const key = buildGameKey(date, teamKeys);
    const game = gameIndex.get(key);
    if (game) {
      return game;
    }
  }
  return null;
}

function resolveOutcomeParticipantKey(
  event: PolymarketEvent,
  outcomeLabel: string,
  game: ResearchGameCard
) {
  const normalized = normalizeToken(outcomeLabel);

  const candidates = [
    {
      abbreviations: [
        normalizeToken(game.game.awayParticipant.abbreviation),
        normalizeToken(game.game.awayParticipant.key),
        normalizeToken(game.game.awayParticipant.shortName),
        normalizeToken(game.game.awayParticipant.name),
      ],
      key: game.game.awayParticipant.key,
    },
    {
      abbreviations: [
        normalizeToken(game.game.homeParticipant.abbreviation),
        normalizeToken(game.game.homeParticipant.key),
        normalizeToken(game.game.homeParticipant.shortName),
        normalizeToken(game.game.homeParticipant.name),
      ],
      key: game.game.homeParticipant.key,
    },
  ];

  for (const team of event.teams ?? []) {
    const teamTokens = [
      normalizeToken(team.abbreviation),
      normalizeToken(team.alias),
      normalizeToken(team.name),
    ].filter(Boolean);

    if (!teamTokens.includes(normalized)) {
      continue;
    }

    const match = candidates.find((candidate) =>
      candidate.abbreviations.some((token) => teamTokens.includes(token))
    );
    if (match) {
      return match.key;
    }
  }

  return null;
}

export async function fetchPolymarketClosedNbaEvents(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  maxPages?: number;
  pageLimit?: number;
  since?: string;
}) {
  const baseUrl = options?.baseUrl ?? POLYMARKET_GAMMA_BASE_URL;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const pageLimit = options?.pageLimit ?? 100;
  const maxPages = options?.maxPages ?? 30;

  const collected: PolymarketEvent[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("tag_slug", "nba");
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(page * pageLimit));
    url.searchParams.set("order", "startDate");
    url.searchParams.set("ascending", "false");

    const response = await fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(
        `Polymarket events request failed with status ${response.status}.`
      );
    }

    const payload = (await response.json()) as unknown;
    const events = Array.isArray(payload) ? (payload as PolymarketEvent[]) : [];

    if (events.length === 0) {
      break;
    }

    const filtered = options?.since
      ? events.filter((event) =>
          buildEventDateCandidates(event).some((date) => date >= options.since!)
        )
      : events;

    collected.push(...filtered);

    if (events.length < pageLimit) {
      break;
    }

    if (
      options?.since &&
      events.every((event) =>
        buildEventDateCandidates(event).every((date) => date < options.since!)
      )
    ) {
      break;
    }
  }

  return collected;
}

export async function fetchPolymarketPricesHistory(options: {
  endTs: number;
  market: string;
  startTs: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  fidelityMinutes?: number;
}) {
  const baseUrl = options.baseUrl ?? POLYMARKET_CLOB_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const fidelity = options.fidelityMinutes ?? DEFAULT_FIDELITY_MINUTES;

  const url = new URL(`${baseUrl}/prices-history`);
  url.searchParams.set("market", options.market);
  url.searchParams.set("startTs", String(options.startTs));
  url.searchParams.set("endTs", String(options.endTs));
  url.searchParams.set("fidelity", String(fidelity));

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Polymarket prices-history failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as {
    history?: PolymarketPricePoint[];
  };
  return payload.history ?? [];
}

export async function syncPolymarketNbaHistorical(options?: {
  baseUrls?: { clob?: string; gamma?: string };
  fetchImpl?: FetchLike;
  fidelityMinutes?: number;
  games?: ResearchGameCard[];
  maxEvents?: number;
  now?: () => Date;
  since?: string;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const fidelityMinutes = options?.fidelityMinutes ?? DEFAULT_FIDELITY_MINUTES;

  try {
    const games =
      options?.games ??
      listResearchGames({
        league: "NBA",
        scope: "all",
        sport: "basketball",
      });
    const gameIndex = buildGameIndex(games);

    const events = await fetchPolymarketClosedNbaEvents({
      baseUrl: options?.baseUrls?.gamma,
      fetchImpl: options?.fetchImpl,
      since: options?.since,
    });

    const maxEvents = options?.maxEvents ?? events.length;
    const limited = events.slice(0, maxEvents);

    const matchedGameIds = new Set<string>();
    let marketsConsidered = 0;
    let pointsFetched = 0;
    let rawPayloadsWritten = 0;
    let ticksWritten = 0;

    for (const event of limited) {
      const game = resolveEventGame(event, gameIndex);
      if (!game) continue;

      matchedGameIds.add(game.game.id);

      const gameStartSource =
        event.startTime ??
        (event.eventDate ? `${event.eventDate}T23:30:00Z` : null) ??
        game.game.scheduledStart;
      const gameStartMs = new Date(gameStartSource).getTime();
      if (!Number.isFinite(gameStartMs)) continue;

      const windowStartTs = Math.floor(
        (gameStartMs - DEFAULT_WINDOW_SECONDS_BEFORE_GAME * 1000) / 1000
      );
      const windowEndTs = Math.floor(
        (gameStartMs + DEFAULT_WINDOW_SECONDS_AFTER_GAME * 1000) / 1000
      );

      for (const market of event.markets ?? []) {
        if (!isHistoricalMarketType(market.sportsMarketType)) continue;
        marketsConsidered += 1;

        const tokens = parseClobTokenIds(market.clobTokenIds);
        const outcomes = parseJsonArray(market.outcomes).map(String);
        if (tokens.length !== outcomes.length || tokens.length < 2) continue;

        for (let idx = 0; idx < tokens.length; idx += 1) {
          const tokenId = tokens[idx];
          const outcomeLabel = outcomes[idx];
          let displayLabel = "";
          let instrumentId = "";
          let line: number | null = null;
          let participantKey: string | null = null;
          let rawFamily: string = market.sportsMarketType;
          let rawLabel = outcomeLabel;
          let selection = "";
          let sourceSelectionKey = "";

          if (market.sportsMarketType === "moneyline") {
            participantKey = resolveOutcomeParticipantKey(
              event,
              outcomeLabel,
              game
            );
            if (!participantKey) continue;

            instrumentId = buildStableId([
              game.game.id,
              "moneyline",
              participantKey,
            ]);
            displayLabel = `${outcomeLabel} moneyline`;
            rawFamily = "moneyline";
            selection = participantKey;
            sourceSelectionKey = participantKey;
          } else {
            const playerProp = parsePlayerPropQuestion(market.question);
            line = toNumber(market.line);
            if (!playerProp || line == null) continue;

            participantKey = playerProp.subjectKey;
            selection = normalizePlayerPropSelection(outcomeLabel, idx);
            sourceSelectionKey = selection;
            const metric = describePlayerPropMetric(market.sportsMarketType);
            instrumentId = buildStableId([
              game.game.id,
              "player-prop",
              market.sportsMarketType,
              playerProp.subjectKey,
              selection,
              line,
            ]);
            displayLabel = `${playerProp.subject} ${metric} ${selection} ${line}`;
            rawLabel = market.question;
          }

          const points = await fetchPolymarketPricesHistory({
            baseUrl: options?.baseUrls?.clob,
            endTs: windowEndTs,
            fetchImpl: options?.fetchImpl,
            fidelityMinutes,
            market: tokenId,
            startTs: windowStartTs,
          });
          pointsFetched += points.length;

          if (points.length === 0) continue;

          const sourceMarketId = `pm-${market.id}-${normalizeToken(sourceSelectionKey)}`;

          upsertMarketInstrument({
            displayLabel,
            family:
              market.sportsMarketType === "moneyline"
                ? "moneyline"
                : "player-prop",
            gameId: game.game.id,
            id: instrumentId,
            inPlay: false,
            line,
            participantKey,
            selection,
          });

          upsertSourceMarket({
            gameId: game.game.id,
            id: sourceMarketId,
            instrumentId,
            mappingStatus: "auto",
            rawFamily,
            rawLabel,
            rawMetadata: {
              clobTokenId: tokenId,
              eventDate: event.eventDate ?? null,
              eventId: event.id,
              eventSlug: event.slug,
              line,
              marketId: market.id,
              outcome: outcomeLabel,
              startTime: event.startTime ?? null,
            },
            source: "polymarket",
            sourceMarketKey: market.slug,
            sourceSelectionKey,
          });

          for (const point of points) {
            const capturedAt = new Date(point.t * 1000).toISOString();
            const result = appendHistoricalTick({
              bestAsk: null,
              bestBid: null,
              capturedAt,
              depthScore: null,
              impliedProbability: point.p,
              lineRaw: line,
              oddsRaw: null,
              priceRaw: point.p,
              sourceMarketId,
              volume: toNumber(market.volume),
            });

            if (result.inserted) ticksWritten += 1;
          }

          const rawPayload = {
            event: {
              eventDate: event.eventDate,
              id: event.id,
              slug: event.slug,
              startTime: event.startTime ?? null,
              title: event.title,
            },
            market: {
              id: market.id,
              line,
              outcome: outcomeLabel,
              slug: market.slug,
              sportsMarketType: market.sportsMarketType,
            },
            points: points.slice(0, 5),
            pointsCount: points.length,
            tokenId,
          } satisfies Record<string, unknown>;

          recordRawPayload({
            capturedAt: startedAt,
            contentHash: buildRawPayloadHash(rawPayload),
            entityId: sourceMarketId,
            entityType: "source_market_historical",
            payloadJson: rawPayload,
            source: "polymarket",
          });
          rawPayloadsWritten += 1;
        }
      }
    }

    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
      finishedAt,
      recordsSeen: marketsConsidered,
      recordsWritten: ticksWritten,
      source: "polymarket",
      startedAt,
      status: "ok",
    });

    return {
      eventsSeen: events.length,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketsConsidered,
      ok: true as const,
      pointsFetched,
      rawPayloadsWritten,
      startedAt,
      ticksWritten,
    } satisfies PolymarketHistoricalSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "polymarket",
      startedAt,
      status: "error",
    });
    throw error;
  }
}
