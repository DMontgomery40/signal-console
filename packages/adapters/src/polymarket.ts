import { createHash } from "node:crypto";

import type {
  ResearchGameCard,
  ResearchSourceId,
} from "@signal-console/domain";
import {
  listResearchGames,
  recordAdapterRun,
  recordQuoteObservation,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

type FetchLike = typeof fetch;

type PolymarketTeam = {
  abbreviation?: string | null;
  alias?: string | null;
  id: number | string;
  name: string;
};

type PolymarketMarket = {
  bestAsk?: number | null;
  bestBid?: number | null;
  clobTokenIds?: string | string[] | null;
  conditionId?: string | null;
  description?: string | null;
  groupItemTitle?: string | null;
  id: string;
  line?: number | null;
  outcomes: string;
  outcomePrices: string;
  question: string;
  slug: string;
  sportsMarketType?: string | null;
  volume?: number | string | null;
};

type PolymarketEvent = {
  active?: boolean | null;
  closed?: boolean | null;
  eventDate?: string | null;
  id: string;
  liquidity?: number | string | null;
  markets?: PolymarketMarket[];
  slug: string;
  startTime?: string | null;
  teams?: PolymarketTeam[];
  title: string;
};

type SupportedPolymarketMarketType =
  | "assists"
  | "first_half_moneyline"
  | "first_half_spreads"
  | "first_half_totals"
  | "moneyline"
  | "points"
  | "rebounds"
  | "spreads"
  | "threes"
  | "totals";

type PolymarketSelectionRecord = {
  capturedAt: string;
  displayLabel: string;
  family: "moneyline" | "player-prop" | "spread" | "total";
  gameId: string;
  inPlay: boolean;
  impliedProbability: number | null;
  instrumentId: string;
  line: number | null;
  lineRaw: number | null;
  participantKey: string | null;
  priceRaw: number | null;
  rawFamily: string;
  rawLabel: string;
  selection: string;
  source: ResearchSourceId;
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey: string;
  volume: number | null;
  rawPayloadJson: Record<string, unknown>;
};

export type PolymarketSyncSummary = {
  finishedAt: string;
  gamesMatched: number;
  marketsSeen: number;
  ok: true;
  quoteObservationsWritten: number;
  rawPayloadsWritten: number;
  recordsSeen: number;
  recordsWritten: number;
  sourceMarketsObserved: number;
  startedAt: string;
};

function parseJsonArray(
  value: string,
  fallback: Array<number | string> = []
): Array<number | string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Array<number | string>)
      : fallback;
  } catch {
    return fallback;
  }
}

function parseOptionalJsonArray(
  value: string | string[] | null | undefined
): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function marketTypeSupported(
  marketType: string | null | undefined
): marketType is SupportedPolymarketMarketType {
  return [
    "assists",
    "first_half_moneyline",
    "first_half_spreads",
    "first_half_totals",
    "moneyline",
    "points",
    "rebounds",
    "spreads",
    "threes",
    "totals",
  ].includes(marketType ?? "");
}

function marketWindowPrefix(marketType: SupportedPolymarketMarketType) {
  return marketType.startsWith("first_half_") ? "1H " : "";
}

function formatLine(line: number | null) {
  if (line == null) {
    return "n/a";
  }

  if (line > 0) {
    return `+${line}`;
  }

  return `${line}`;
}

function buildSourceMarketId(marketId: string, selectionKey: string) {
  return `pm-${marketId}-${normalizeToken(selectionKey)}`;
}

function buildStableId(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) => normalizeToken(String(part ?? "")))
    .filter(Boolean)
    .join("-");
}

function buildGameKey(date: string, teamKeys: string[]) {
  return `${date}::${teamKeys
    .map((key) => normalizeToken(key))
    .sort()
    .join("::")}`;
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
    index.set(buildGameKey(date, teamKeys), gameCard);
  }

  return index;
}

function buildEventKeys(event: PolymarketEvent) {
  if (!event.teams || event.teams.length !== 2) {
    return [];
  }

  const teamKeys = event.teams.map(
    (team) => team.abbreviation ?? team.alias ?? team.name
  );
  const dateCandidates = [
    event.eventDate ?? null,
    event.startTime ? event.startTime.slice(0, 10) : null,
  ].filter((value): value is string => Boolean(value));

  return Array.from(
    new Set(dateCandidates.map((date) => buildGameKey(date, teamKeys)))
  );
}

function resolveParticipantKey(
  game: ResearchGameCard,
  event: PolymarketEvent,
  selectionLabel: string
) {
  const normalizedSelection = normalizeToken(selectionLabel);
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
    const eventTokens = [
      normalizeToken(team.abbreviation),
      normalizeToken(team.alias),
      normalizeToken(team.name),
    ].filter(Boolean);

    if (!eventTokens.includes(normalizedSelection)) {
      continue;
    }

    const match = candidates.find((candidate) =>
      candidate.abbreviations.some((token) => eventTokens.includes(token))
    );
    if (match) {
      return match.key;
    }
  }

  return null;
}

function toNumber(value: number | string | null | undefined) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildRawPayloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function describeMetric(marketType: SupportedPolymarketMarketType) {
  switch (marketType) {
    case "assists":
      return "assists";
    case "points":
      return "points";
    case "rebounds":
      return "rebounds";
    case "threes":
      return "threes";
    default:
      return "market";
  }
}

function buildMoneylineSelectionRecords(
  event: PolymarketEvent,
  game: ResearchGameCard,
  market: PolymarketMarket,
  capturedAt: string,
  marketType: Extract<
    SupportedPolymarketMarketType,
    "first_half_moneyline" | "moneyline"
  >
) {
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) =>
    toNumber(price)
  );
  const clobTokenIds = parseOptionalJsonArray(market.clobTokenIds);

  return outcomes
    .map((outcome, index) => {
      const participantKey = resolveParticipantKey(game, event, outcome);
      if (!participantKey) {
        return null;
      }

      const displayLabel = `${marketWindowPrefix(marketType)}${outcome} moneyline`;
      const instrumentId = buildStableId([
        game.game.id,
        "moneyline",
        outcome,
        market.sportsMarketType ?? "moneyline",
      ]);
      const sourceSelectionKey = participantKey;
      const sourceMarketId = buildSourceMarketId(market.id, sourceSelectionKey);
      const rawPayloadJson = {
        event: {
          eventDate: event.eventDate,
          id: event.id,
          active: event.active ?? null,
          closed: event.closed ?? null,
          slug: event.slug,
          startTime: event.startTime ?? null,
          title: event.title,
        },
        market,
        selection: {
          clobTokenId: clobTokenIds[index] ?? null,
          label: outcome,
          participantKey,
          price: prices[index] ?? null,
          outcomeIndex: index,
        },
      } satisfies Record<string, unknown>;

      return {
        capturedAt,
        displayLabel,
        family: "moneyline" as const,
        gameId: game.game.id,
        impliedProbability: prices[index] ?? null,
        inPlay: game.gameState?.status === "in-play",
        instrumentId,
        line: null,
        lineRaw: null,
        participantKey,
        priceRaw: prices[index] ?? null,
        rawFamily: market.sportsMarketType ?? "moneyline",
        rawLabel: outcome,
        rawPayloadJson,
        selection: participantKey,
        source: "polymarket" as const,
        sourceMarketId,
        sourceMarketKey: market.slug,
        sourceSelectionKey,
        volume: toNumber(market.volume) ?? toNumber(event.liquidity),
      } satisfies PolymarketSelectionRecord;
    })
    .filter((record): record is NonNullable<typeof record> => record !== null);
}

function buildSpreadSelectionRecords(
  event: PolymarketEvent,
  game: ResearchGameCard,
  market: PolymarketMarket,
  capturedAt: string,
  marketType: Extract<
    SupportedPolymarketMarketType,
    "first_half_spreads" | "spreads"
  >
) {
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) =>
    toNumber(price)
  );
  const clobTokenIds = parseOptionalJsonArray(market.clobTokenIds);
  const baseLine = toNumber(market.line);

  return outcomes
    .map((outcome, index) => {
      const participantKey = resolveParticipantKey(game, event, outcome);
      if (!participantKey) {
        return null;
      }

      const signedLine =
        baseLine == null ? null : index === 0 ? baseLine : baseLine * -1;
      const displayLabel = `${marketWindowPrefix(marketType)}${outcome} ${formatLine(signedLine)}`;
      const instrumentId = buildStableId([
        game.game.id,
        marketType,
        outcome,
        signedLine,
      ]);
      const sourceSelectionKey = participantKey;
      const sourceMarketId = buildSourceMarketId(market.id, sourceSelectionKey);
      const rawPayloadJson = {
        event: {
          eventDate: event.eventDate,
          id: event.id,
          active: event.active ?? null,
          closed: event.closed ?? null,
          slug: event.slug,
          startTime: event.startTime ?? null,
          title: event.title,
        },
        market,
        selection: {
          clobTokenId: clobTokenIds[index] ?? null,
          label: outcome,
          participantKey,
          price: prices[index] ?? null,
          outcomeIndex: index,
          signedLine,
        },
      } satisfies Record<string, unknown>;

      return {
        capturedAt,
        displayLabel,
        family: "spread" as const,
        gameId: game.game.id,
        impliedProbability: prices[index] ?? null,
        inPlay: game.gameState?.status === "in-play",
        instrumentId,
        line: signedLine,
        lineRaw: signedLine,
        participantKey,
        priceRaw: prices[index] ?? null,
        rawFamily: marketType,
        rawLabel: outcome,
        rawPayloadJson,
        selection: participantKey,
        source: "polymarket" as const,
        sourceMarketId,
        sourceMarketKey: market.slug,
        sourceSelectionKey,
        volume: toNumber(market.volume),
      } satisfies PolymarketSelectionRecord;
    })
    .filter((record): record is NonNullable<typeof record> => record !== null);
}

function buildTotalSelectionRecords(
  event: PolymarketEvent,
  game: ResearchGameCard,
  market: PolymarketMarket,
  capturedAt: string,
  marketType: Extract<
    SupportedPolymarketMarketType,
    "first_half_totals" | "totals"
  >
) {
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) =>
    toNumber(price)
  );
  const clobTokenIds = parseOptionalJsonArray(market.clobTokenIds);
  const line = toNumber(market.line);

  return outcomes
    .map((outcome, index) => {
      const normalizedSelection = normalizeToken(outcome);
      if (!["over", "under"].includes(normalizedSelection)) {
        return null;
      }

      const displayLabel = `${marketWindowPrefix(marketType)}${outcome} ${line ?? "n/a"} total`;
      const instrumentId = buildStableId([
        game.game.id,
        marketType,
        normalizedSelection,
        line,
      ]);
      const sourceMarketId = buildSourceMarketId(
        market.id,
        normalizedSelection
      );
      const rawPayloadJson = {
        event: {
          eventDate: event.eventDate,
          id: event.id,
          active: event.active ?? null,
          closed: event.closed ?? null,
          slug: event.slug,
          startTime: event.startTime ?? null,
          title: event.title,
        },
        market,
        selection: {
          clobTokenId: clobTokenIds[index] ?? null,
          label: outcome,
          price: prices[index] ?? null,
          outcomeIndex: index,
          selection: normalizedSelection,
        },
      } satisfies Record<string, unknown>;

      return {
        capturedAt,
        displayLabel,
        family: "total" as const,
        gameId: game.game.id,
        impliedProbability: prices[index] ?? null,
        inPlay: game.gameState?.status === "in-play",
        instrumentId,
        line,
        lineRaw: line,
        participantKey: null,
        priceRaw: prices[index] ?? null,
        rawFamily: marketType,
        rawLabel: outcome,
        rawPayloadJson,
        selection: normalizedSelection,
        source: "polymarket" as const,
        sourceMarketId,
        sourceMarketKey: market.slug,
        sourceSelectionKey: normalizedSelection,
        volume: toNumber(market.volume),
      } satisfies PolymarketSelectionRecord;
    })
    .filter((record): record is NonNullable<typeof record> => record !== null);
}

function buildPlayerPropSelectionRecords(
  event: PolymarketEvent,
  game: ResearchGameCard,
  market: PolymarketMarket,
  capturedAt: string,
  marketType: Extract<
    SupportedPolymarketMarketType,
    "assists" | "points" | "rebounds" | "threes"
  >
) {
  if (!market.question.includes(" O/U ")) {
    return [];
  }

  const [subject] = market.question.split(":");
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) =>
    toNumber(price)
  );
  const clobTokenIds = parseOptionalJsonArray(market.clobTokenIds);
  const line = toNumber(market.line);

  if (!subject || line == null || outcomes.length < 2) {
    return [];
  }

  const subjectKey = normalizeToken(subject);

  return [
    {
      clobTokenId: clobTokenIds[0] ?? null,
      outcome: outcomes[0] ?? "Yes",
      outcomeIndex: 0,
      price: prices[0] ?? null,
      selection: "over",
    },
    {
      clobTokenId: clobTokenIds[1] ?? null,
      outcome: outcomes[1] ?? "No",
      outcomeIndex: 1,
      price: prices[1] ?? null,
      selection: "under",
    },
  ].map(({ clobTokenId, outcome, outcomeIndex, price, selection }) => {
    const displayLabel = `${subject} ${describeMetric(marketType)} ${selection} ${line}`;
    const instrumentId = buildStableId([
      game.game.id,
      "player-prop",
      marketType,
      subjectKey,
      selection,
      line,
    ]);
    const sourceMarketId = buildSourceMarketId(market.id, selection);
    const rawPayloadJson = {
      event: {
        eventDate: event.eventDate,
        id: event.id,
        active: event.active ?? null,
        closed: event.closed ?? null,
        slug: event.slug,
        startTime: event.startTime ?? null,
        title: event.title,
      },
      market,
      selection: {
        clobTokenId,
        label: outcome,
        outcomeIndex,
        price,
        selection,
        subject,
      },
    } satisfies Record<string, unknown>;

    return {
      capturedAt,
      displayLabel,
      family: "player-prop" as const,
      gameId: game.game.id,
      impliedProbability: price,
      inPlay: game.gameState?.status === "in-play",
      instrumentId,
      line,
      lineRaw: line,
      participantKey: subjectKey,
      priceRaw: price,
      rawFamily: marketType,
      rawLabel: market.question,
      rawPayloadJson,
      selection,
      source: "polymarket" as const,
      sourceMarketId,
      sourceMarketKey: market.slug,
      sourceSelectionKey: selection,
      volume: toNumber(market.volume),
    } satisfies PolymarketSelectionRecord;
  });
}

export function buildPolymarketSelectionRecords(
  event: PolymarketEvent,
  game: ResearchGameCard,
  market: PolymarketMarket,
  capturedAt: string
) {
  if (!marketTypeSupported(market.sportsMarketType)) {
    return [];
  }

  switch (market.sportsMarketType) {
    case "moneyline":
    case "first_half_moneyline":
      return buildMoneylineSelectionRecords(
        event,
        game,
        market,
        capturedAt,
        market.sportsMarketType
      );
    case "spreads":
    case "first_half_spreads":
      return buildSpreadSelectionRecords(
        event,
        game,
        market,
        capturedAt,
        market.sportsMarketType
      );
    case "totals":
    case "first_half_totals":
      return buildTotalSelectionRecords(
        event,
        game,
        market,
        capturedAt,
        market.sportsMarketType
      );
    case "assists":
    case "points":
    case "rebounds":
    case "threes":
      return buildPlayerPropSelectionRecords(
        event,
        game,
        market,
        capturedAt,
        market.sportsMarketType
      );
    default:
      return [];
  }
}

export async function fetchPolymarketNbaEvents(options?: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  limit?: number;
}) {
  const baseUrl = options?.baseUrl ?? "https://gamma-api.polymarket.com";
  const limit = options?.limit ?? 200;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const url = new URL("/events", baseUrl);
  url.searchParams.set("tag_slug", "nba");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", String(limit));

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Polymarket events request failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as PolymarketEvent[]) : [];
}

export async function syncPolymarketNbaMarkets(options?: {
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();

  try {
    const games =
      options?.games ??
      listResearchGames({
        league: "NBA",
        referenceNow: now().toISOString(),
        sport: "basketball",
      });
    const events = await fetchPolymarketNbaEvents({
      fetchImpl: options?.fetchImpl,
    });
    const gameIndex = buildGameIndex(games);
    const matchedGameIds = new Set<string>();

    let marketsSeen = 0;
    let quoteObservationsWritten = 0;
    let rawPayloadsWritten = 0;
    let sourceMarketsObserved = 0;

    for (const event of events) {
      const gameKeys = buildEventKeys(event);
      if (gameKeys.length === 0) {
        continue;
      }

      const game = gameKeys
        .map((gameKey) => gameIndex.get(gameKey) ?? null)
        .find((candidate): candidate is ResearchGameCard => candidate != null);
      if (!game) {
        continue;
      }

      matchedGameIds.add(game.game.id);

      for (const market of event.markets ?? []) {
        const selectionRecords = buildPolymarketSelectionRecords(
          event,
          game,
          market,
          now().toISOString()
        );

        if (selectionRecords.length === 0) {
          continue;
        }

        marketsSeen += 1;

        for (const record of selectionRecords) {
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

          upsertSourceMarket({
            gameId: record.gameId,
            id: record.sourceMarketId,
            instrumentId: record.instrumentId,
            mappingStatus: "auto",
            rawFamily: record.rawFamily,
            rawLabel: record.rawLabel,
            rawMetadata: {
              clobTokenId:
                typeof record.rawPayloadJson.selection === "object" &&
                record.rawPayloadJson.selection != null &&
                "clobTokenId" in record.rawPayloadJson.selection
                  ? record.rawPayloadJson.selection.clobTokenId
                  : null,
              conditionId: market.conditionId ?? null,
              eventDate: event.eventDate ?? null,
              eventActive: event.active ?? null,
              eventClosed: event.closed ?? null,
              eventId: event.id,
              eventSlug: event.slug,
              eventTitle: event.title,
              marketClosed: event.closed ?? null,
              marketId: market.id,
              marketQuestion: market.question,
              marketVolume: toNumber(market.volume),
              outcome:
                typeof record.rawPayloadJson.selection === "object" &&
                record.rawPayloadJson.selection != null &&
                "label" in record.rawPayloadJson.selection
                  ? record.rawPayloadJson.selection.label
                  : null,
              outcomeIndex:
                typeof record.rawPayloadJson.selection === "object" &&
                record.rawPayloadJson.selection != null &&
                "outcomeIndex" in record.rawPayloadJson.selection
                  ? record.rawPayloadJson.selection.outcomeIndex
                  : null,
              sportsMarketType: market.sportsMarketType ?? null,
              startTime: event.startTime ?? null,
            },
            source: "polymarket",
            sourceMarketKey: record.sourceMarketKey,
            sourceSelectionKey: record.sourceSelectionKey,
          });
          sourceMarketsObserved += 1;

          const quoteResult = recordQuoteObservation({
            bestAsk: null,
            bestBid: null,
            capturedAt: record.capturedAt,
            depthScore: null,
            heartbeatAfterMs: 5 * 60_000,
            impliedProbability: record.impliedProbability,
            lineRaw: record.lineRaw,
            oddsRaw: null,
            priceRaw: record.priceRaw,
            sourceMarketId: record.sourceMarketId,
            volume: record.volume,
          });

          if (quoteResult.wrote) {
            quoteObservationsWritten += 1;
          }

          recordRawPayload({
            capturedAt: record.capturedAt,
            contentHash: buildRawPayloadHash(record.rawPayloadJson),
            entityId: record.sourceMarketId,
            entityType: "source_market",
            payloadJson: record.rawPayloadJson,
            source: "polymarket",
          });
          rawPayloadsWritten += 1;
        }
      }
    }

    const finishedAt = now().toISOString();
    const recordsSeen = sourceMarketsObserved;
    const recordsWritten =
      sourceMarketsObserved + quoteObservationsWritten + rawPayloadsWritten;

    recordAdapterRun({
      finishedAt,
      recordsSeen,
      recordsWritten,
      source: "polymarket",
      startedAt,
      status: "ok",
    });

    return {
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketsSeen,
      ok: true as const,
      quoteObservationsWritten,
      rawPayloadsWritten,
      recordsSeen,
      recordsWritten,
      sourceMarketsObserved,
      startedAt,
    } satisfies PolymarketSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
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
