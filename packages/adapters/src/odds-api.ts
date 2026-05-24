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

type OddsApiBookmakerName = "Bet365" | "Kalshi";
type OddsApiSourceId = Extract<ResearchSourceId, "bet365" | "kalshi">;

type OddsApiEvent = {
  away: string;
  date: string;
  home: string;
  id: number | string;
  league?: {
    name?: string | null;
    slug?: string | null;
  } | null;
  scores?: {
    away?: number | null;
    home?: number | null;
    periods?: Record<string, number | null> | null;
  } | null;
  sport?: {
    name?: string | null;
    slug?: string | null;
  } | null;
  status?: string | null;
};

type OddsApiMarketOddsRow = Record<string, number | string | null | undefined>;

type OddsApiMarket = {
  name: string;
  odds?: OddsApiMarketOddsRow[] | null;
  updatedAt?: string | null;
};

type OddsApiEventOdds = OddsApiEvent & {
  bookmakerIds?: Record<string, string | null> | null;
  bookmakers?: Record<string, OddsApiMarket[] | null> | null;
  urls?: Record<string, string | null> | null;
};

type OddsApiSelectionRecord = {
  bestAsk: number | null;
  bestBid: number | null;
  capturedAt: string;
  depthScore: number | null;
  displayLabel: string;
  family: "moneyline" | "player-prop" | "spread" | "total";
  gameId: string;
  impliedProbability: number | null;
  inPlay: boolean;
  instrumentId: string | null;
  line: number | null;
  lineRaw: number | null;
  oddsRaw: string | null;
  participantKey: string | null;
  priceRaw: number | null;
  rawFamily: string;
  rawLabel: string;
  rawPayloadJson: Record<string, unknown>;
  selection: string;
  source: OddsApiSourceId;
  sourceMarketId: string;
  sourceMarketKey: string;
  sourceSelectionKey: string;
  volume: number | null;
};

export type OddsApiSyncSummary = {
  bookmaker: OddsApiBookmakerName;
  finishedAt: string;
  gamesMatched: number;
  marketsSeen: number;
  ok: true;
  quoteObservationsWritten: number;
  rawPayloadsWritten: number;
  recordsSeen: number;
  recordsWritten: number;
  source: OddsApiSourceId;
  sourceMarketsObserved: number;
  startedAt: string;
};

const bookmakerSourceMap: Record<OddsApiBookmakerName, OddsApiSourceId> = {
  Bet365: "bet365",
  Kalshi: "kalshi",
};

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

function toNumber(value: number | string | null | undefined) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toDecimalOddsString(value: number | string | null | undefined) {
  if (value == null || value === "") {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(value) : null;
}

function decimalOddsToProbability(value: number | string | null | undefined) {
  const numeric = toNumber(value);
  if (numeric == null || numeric <= 0) {
    return null;
  }

  return 1 / numeric;
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

function buildStableId(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) => normalizeToken(String(part ?? "")))
    .filter(Boolean)
    .join("-");
}

function buildRawPayloadHash(payload: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildSourceMarketId(
  source: OddsApiSourceId,
  eventId: string | number,
  marketName: string,
  selectionKey: string,
  line: number | null
) {
  return buildStableId([source, "oa", eventId, marketName, selectionKey, line]);
}

function readNonNegativeNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getTargetLookaheadHours() {
  return readNonNegativeNumberEnv("ODDS_API_TARGET_LOOKAHEAD_HOURS", 8);
}

function getTargetLookbackMinutes() {
  return readNonNegativeNumberEnv("ODDS_API_TARGET_LOOKBACK_MINUTES", 90);
}

function getOddsApiKey(options?: { apiKey?: string }) {
  return (
    options?.apiKey ??
    process.env.ODDS_API_KEY ??
    process.env.ODDS_API_IO_KEY ??
    null
  );
}

function isLiveGameStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  return normalized.includes("in-play") || normalized === "live";
}

function isScheduledGameStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "scheduled" ||
    normalized === "pending" ||
    normalized.includes("pre") ||
    normalized.includes("not-started")
  );
}

function selectTargetGames(
  games: ResearchGameCard[],
  options: {
    lookaheadHours?: number;
    lookbackMinutes?: number;
    now: Date;
  }
) {
  const lookaheadMs =
    Math.max(0, options.lookaheadHours ?? getTargetLookaheadHours()) *
    60 *
    60_000;
  const lookbackMs =
    Math.max(0, options.lookbackMinutes ?? getTargetLookbackMinutes()) * 60_000;
  const nowMs = options.now.getTime();
  const windowStart = nowMs - lookbackMs;
  const windowEnd = nowMs + lookaheadMs;

  return games
    .filter((game) => {
      const scheduledAt = new Date(game.game.scheduledStart).getTime();
      if (!Number.isFinite(scheduledAt)) {
        return false;
      }

      if (isLiveGameStatus(game.gameState?.status)) {
        return true;
      }

      return (
        isScheduledGameStatus(game.gameState?.status) &&
        scheduledAt >= windowStart &&
        scheduledAt <= windowEnd
      );
    })
    .sort((left, right) => {
      const leftLive = isLiveGameStatus(left.gameState?.status);
      const rightLive = isLiveGameStatus(right.gameState?.status);
      if (leftLive !== rightLive) {
        return leftLive ? -1 : 1;
      }

      return (
        new Date(left.game.scheduledStart).getTime() -
        new Date(right.game.scheduledStart).getTime()
      );
    });
}

function buildTargetEventRange(
  games: ResearchGameCard[],
  options: {
    now: Date;
    lookaheadHours?: number;
    lookbackMinutes?: number;
  }
) {
  const targetGames = selectTargetGames(games, options);
  if (targetGames.length === 0) {
    return null;
  }

  const lookaheadMs =
    Math.max(0, options.lookaheadHours ?? getTargetLookaheadHours()) *
    60 *
    60_000;
  const lookbackMs =
    Math.max(0, options.lookbackMinutes ?? getTargetLookbackMinutes()) * 60_000;
  const starts = targetGames
    .map((game) => new Date(game.game.scheduledStart).getTime())
    .filter((value) => Number.isFinite(value));
  const fromMs = Math.min(options.now.getTime(), ...starts) - lookbackMs;
  const toMs = Math.max(options.now.getTime(), ...starts) + lookaheadMs;

  return {
    from: new Date(fromMs).toISOString(),
    targetGames,
    to: new Date(toMs).toISOString(),
  };
}

function findMatchingGame(games: ResearchGameCard[], event: OddsApiEvent) {
  const eventDate = event.date.slice(0, 10);

  return (
    games.find((game) => {
      if (game.game.scheduledStart.slice(0, 10) !== eventDate) {
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
    }) ?? null
  );
}

function extractLine(row: OddsApiMarketOddsRow) {
  return (
    toNumber(row.hdp) ??
    toNumber(row.max) ??
    toNumber(row.line) ??
    toNumber(row.total) ??
    null
  );
}

function normalizeMarketName(name: string) {
  const normalized = normalizeToken(name);
  const playerPropMetric = normalizePlayerPropMetric(name);
  const hasUnsupportedWindow =
    normalized.includes("q1") ||
    normalized.includes("q2") ||
    normalized.includes("q3") ||
    normalized.includes("q4") ||
    normalized.includes("quarter") ||
    normalized.includes("1st-half") ||
    normalized.includes("first-half") ||
    normalized.includes("2nd-half") ||
    normalized.includes("second-half") ||
    normalized.includes("half-time") ||
    normalized.includes("halftime");

  const hasUnsupportedScope =
    normalized.includes("team-total") || normalized.includes("race-to");

  if (playerPropMetric) {
    return {
      autoMap: !hasUnsupportedWindow,
      family: "player-prop" as const,
      playerPropMetric,
    };
  }

  if (
    normalized === "ml" ||
    normalized.includes("moneyline") ||
    normalized.includes("match-result")
  ) {
    return {
      autoMap: !hasUnsupportedWindow,
      family: "moneyline" as const,
    };
  }

  if (
    normalized.includes("spread") ||
    normalized.includes("asian-handicap") ||
    normalized === "handicap"
  ) {
    return {
      autoMap: !hasUnsupportedWindow,
      family: "spread" as const,
    };
  }

  if (normalized.includes("total") || normalized.includes("over-under")) {
    return {
      autoMap: !hasUnsupportedWindow && !hasUnsupportedScope,
      family: "total" as const,
    };
  }

  return null;
}

function normalizePlayerPropMetric(name: string) {
  const normalized = normalizeToken(name);

  if (normalized.includes("player-first-basket")) return "first-basket";
  if (normalized.includes("player-first-assist")) return "first-assist";
  if (normalized.includes("player-first-rebound")) return "first-rebound";
  if (normalized.includes("triple-double")) return "triple-double";
  if (normalized.includes("double-double")) return "double-double";
  if (normalized.includes("points-assists-rebounds")) {
    return "points-assists-rebounds";
  }
  if (normalized.includes("points-rebounds")) return "points-rebounds";
  if (normalized.includes("points-assists")) return "points-assists";
  if (normalized.includes("assists-rebounds")) return "assists-rebounds";
  if (normalized.includes("steals-blocks")) return "steals-blocks";
  if (normalized.includes("field-goals-made")) return "field-goals-made";
  if (normalized.includes("threes-made")) return "threes";
  if (normalized.includes("player-threes-milestones")) {
    return "threes-milestone";
  }
  if (normalized.includes("player-points-milestones")) {
    return "points-milestone";
  }
  if (normalized.includes("player-rebounds-milestones")) {
    return "rebounds-milestone";
  }
  if (normalized.includes("player-assists-milestones")) {
    return "assists-milestone";
  }
  if (normalized.includes("points-o-u")) return "points";
  if (normalized.includes("rebounds-o-u")) return "rebounds";
  if (normalized.includes("assists-o-u")) return "assists";
  if (normalized.includes("blocks-o-u")) return "blocks";
  if (normalized.includes("steals-o-u")) return "steals";

  return null;
}

function formatPlayerPropMetric(metric: string) {
  return metric.split("-").join(" ");
}

function selectionLabelForParticipant(
  game: ResearchGameCard,
  side: "home" | "away"
) {
  const participant =
    side === "home" ? game.game.homeParticipant : game.game.awayParticipant;

  return {
    key: participant.key,
    label: participant.shortName,
  };
}

function makeSelectionRecord(options: {
  bookmaker: OddsApiBookmakerName;
  bookmakerId?: string | null;
  capturedAt: string;
  displayLabel: string;
  event: OddsApiEventOdds;
  game: ResearchGameCard;
  market: OddsApiMarket;
  oddsValue: number | string | null | undefined;
  layDepthValue?: number | string | null | undefined;
  layValue?: number | string | null | undefined;
  line: number | null;
  participantKey: string | null;
  rawLabel: string;
  rawSelection: Record<string, unknown>;
  selection: string;
  source: OddsApiSourceId;
  sourceFamily: "moneyline" | "player-prop" | "spread" | "total";
  sourceMarketKey: string;
  sourceSelectionKey: string;
  depthValue?: number | string | null | undefined;
}) {
  const priceRaw = toNumber(options.oddsValue);
  const oddsRaw = toDecimalOddsString(options.oddsValue);
  const impliedProbability = decimalOddsToProbability(options.oddsValue);
  const sourceMarketId = buildSourceMarketId(
    options.source,
    options.event.id,
    options.market.name,
    options.sourceSelectionKey,
    options.line
  );

  const rawPayloadJson = {
    bookmaker: options.bookmaker,
    bookmakerId: options.bookmakerId ?? null,
    event: {
      away: options.event.away,
      date: options.event.date,
      home: options.event.home,
      id: options.event.id,
      league: options.event.league ?? null,
      scores: options.event.scores ?? null,
      sport: options.event.sport ?? null,
      status: options.event.status ?? null,
      url: options.event.urls?.[options.bookmaker] ?? null,
    },
    market: options.market,
    provider: "odds-api.io",
    selection: options.rawSelection,
  } satisfies Record<string, unknown>;

  return {
    bestAsk: decimalOddsToProbability(options.layValue),
    bestBid: impliedProbability,
    capturedAt: options.capturedAt,
    depthScore: toNumber(options.layDepthValue),
    displayLabel: options.displayLabel,
    family: options.sourceFamily,
    gameId: options.game.game.id,
    impliedProbability,
    inPlay: options.game.gameState?.status === "in-play",
    line: options.line,
    lineRaw: options.line,
    oddsRaw,
    participantKey: options.participantKey,
    priceRaw,
    rawFamily: options.market.name,
    rawLabel: options.rawLabel,
    rawPayloadJson,
    selection: options.selection,
    source: options.source,
    sourceMarketId,
    sourceMarketKey: options.sourceMarketKey,
    sourceSelectionKey: options.sourceSelectionKey,
    volume: toNumber(options.depthValue),
  } satisfies Omit<OddsApiSelectionRecord, "instrumentId">;
}

function parsePlayerPropLabel(rawLabel: unknown) {
  const label = String(rawLabel ?? "").trim();
  const parentheticals = [...label.matchAll(/\(([^)]*)\)/g)].map((match) =>
    match[1].trim()
  );
  const player = label.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const labelSelection =
    parentheticals
      .map((value) => normalizeToken(value))
      .find((value) => value === "yes" || value === "no") ?? null;
  const numericLine = [...parentheticals]
    .reverse()
    .map((value) => toNumber(value))
    .find((value): value is number => value != null);

  return {
    label,
    labelSelection,
    line: numericLine ?? null,
    player,
    playerKey: normalizeToken(player),
  };
}

function buildPlayerPropRecords(
  bookmaker: OddsApiBookmakerName,
  event: OddsApiEventOdds,
  game: ResearchGameCard,
  market: OddsApiMarket,
  autoMap: boolean,
  source: OddsApiSourceId,
  capturedAt: string,
  playerPropMetric: string
) {
  const bookmakerId = event.bookmakerIds?.[bookmaker] ?? null;

  return (market.odds ?? [])
    .flatMap((row) => {
      const parsedLabel = parsePlayerPropLabel(row.label);
      if (!parsedLabel.player || !parsedLabel.playerKey) {
        return [];
      }

      const line = extractLine(row) ?? parsedLabel.line;
      const selections: Array<{
        oddsValue: number | string | null | undefined;
        rawSelection: Record<string, unknown>;
        selection: string;
      }> = [];

      if (row.over != null) {
        selections.push({
          oddsValue: row.over,
          rawSelection: {
            label: parsedLabel.label,
            line,
            odds: row.over,
            player: parsedLabel.player,
            selection: "over",
          },
          selection: "over",
        });
      }

      if (row.under != null && row.over != null) {
        selections.push({
          oddsValue: row.under,
          rawSelection: {
            label: parsedLabel.label,
            line,
            odds: row.under,
            player: parsedLabel.player,
            selection: "under",
          },
          selection: "under",
        });
      } else if (row.under != null) {
        const selection = parsedLabel.labelSelection ?? "under";
        selections.push({
          oddsValue: row.under,
          rawSelection: {
            label: parsedLabel.label,
            line,
            odds: row.under,
            player: parsedLabel.player,
            selection,
          },
          selection,
        });
      }

      return selections.map(({ oddsValue, rawSelection, selection }) => {
        const metricLabel = formatPlayerPropMetric(playerPropMetric);
        const lineLabel = line == null ? "" : ` ${line}`;
        const displayLabel =
          `${parsedLabel.player} ${metricLabel} ${selection}${lineLabel}`.trim();
        const sourceSelectionKey = buildStableId([
          parsedLabel.playerKey,
          selection,
        ]);
        const sourceMarketKey = buildStableId([
          event.id,
          market.name,
          parsedLabel.playerKey,
          line,
        ]);

        return {
          ...makeSelectionRecord({
            bookmaker,
            bookmakerId,
            capturedAt,
            displayLabel,
            event,
            game,
            line,
            market,
            oddsValue,
            participantKey: parsedLabel.playerKey,
            rawLabel: parsedLabel.label,
            rawSelection: {
              ...rawSelection,
              metric: playerPropMetric,
            },
            selection,
            source,
            sourceFamily: "player-prop",
            sourceMarketKey,
            sourceSelectionKey,
          }),
          instrumentId: autoMap
            ? buildStableId([
                game.game.id,
                "player-prop",
                playerPropMetric,
                parsedLabel.playerKey,
                selection,
                line,
              ])
            : null,
        };
      });
    })
    .filter((record) => record.priceRaw != null);
}

function buildMoneylineRecords(
  bookmaker: OddsApiBookmakerName,
  event: OddsApiEventOdds,
  game: ResearchGameCard,
  market: OddsApiMarket,
  autoMap: boolean,
  source: OddsApiSourceId,
  capturedAt: string
) {
  const [row] = market.odds ?? [];
  if (!row) {
    return [];
  }

  const bookmakerId = event.bookmakerIds?.[bookmaker] ?? null;
  const homeSelection = selectionLabelForParticipant(game, "home");
  const awaySelection = selectionLabelForParticipant(game, "away");

  return [
    {
      ...makeSelectionRecord({
        bookmaker,
        bookmakerId,
        capturedAt,
        depthValue: row.depthHome,
        displayLabel: `${homeSelection.label} moneyline`,
        event,
        game,
        layDepthValue: row.depthLayHome,
        layValue: row.layHome,
        line: null,
        market,
        oddsValue: row.home,
        participantKey: homeSelection.key,
        rawLabel: event.home,
        rawSelection: {
          label: event.home,
          side: "home",
          odds: row.home ?? null,
          layOdds: row.layHome ?? null,
          depth: row.depthHome ?? null,
          layDepth: row.depthLayHome ?? null,
        },
        selection: homeSelection.key,
        source,
        sourceFamily: "moneyline",
        sourceMarketKey: buildStableId([event.id, market.name, "home"]),
        sourceSelectionKey: homeSelection.key,
      }),
      instrumentId: autoMap
        ? buildStableId([
            game.game.id,
            "moneyline",
            homeSelection.label,
            "moneyline",
          ])
        : null,
    },
    {
      ...makeSelectionRecord({
        bookmaker,
        bookmakerId,
        capturedAt,
        depthValue: row.depthAway,
        displayLabel: `${awaySelection.label} moneyline`,
        event,
        game,
        layDepthValue: row.depthLayAway,
        layValue: row.layAway,
        line: null,
        market,
        oddsValue: row.away,
        participantKey: awaySelection.key,
        rawLabel: event.away,
        rawSelection: {
          label: event.away,
          side: "away",
          odds: row.away ?? null,
          layOdds: row.layAway ?? null,
          depth: row.depthAway ?? null,
          layDepth: row.depthLayAway ?? null,
        },
        selection: awaySelection.key,
        source,
        sourceFamily: "moneyline",
        sourceMarketKey: buildStableId([event.id, market.name, "away"]),
        sourceSelectionKey: awaySelection.key,
      }),
      instrumentId: autoMap
        ? buildStableId([
            game.game.id,
            "moneyline",
            awaySelection.label,
            "moneyline",
          ])
        : null,
    },
  ].filter((record) => record.priceRaw != null);
}

function buildSpreadRecords(
  bookmaker: OddsApiBookmakerName,
  event: OddsApiEventOdds,
  game: ResearchGameCard,
  market: OddsApiMarket,
  autoMap: boolean,
  source: OddsApiSourceId,
  capturedAt: string
) {
  const bookmakerId = event.bookmakerIds?.[bookmaker] ?? null;
  const homeSelection = selectionLabelForParticipant(game, "home");
  const awaySelection = selectionLabelForParticipant(game, "away");

  return (market.odds ?? [])
    .flatMap((row) => {
      const baseLine = extractLine(row);
      if (baseLine == null) {
        return [];
      }

      return [
        {
          ...makeSelectionRecord({
            bookmaker,
            bookmakerId,
            capturedAt,
            depthValue: row.depthHome,
            displayLabel: `${homeSelection.label} ${formatLine(baseLine)}`,
            event,
            game,
            layDepthValue: row.depthLayHome,
            layValue: row.layHome,
            line: baseLine,
            market,
            oddsValue: row.home,
            participantKey: homeSelection.key,
            rawLabel: event.home,
            rawSelection: {
              handicap: baseLine,
              label: event.home,
              side: "home",
              odds: row.home ?? null,
              layOdds: row.layHome ?? null,
              depth: row.depthHome ?? null,
              layDepth: row.depthLayHome ?? null,
            },
            selection: homeSelection.key,
            source,
            sourceFamily: "spread",
            sourceMarketKey: buildStableId([event.id, market.name, baseLine]),
            sourceSelectionKey: homeSelection.key,
          }),
          instrumentId: autoMap
            ? buildStableId([
                game.game.id,
                "spreads",
                homeSelection.label,
                baseLine,
              ])
            : null,
        },
        {
          ...makeSelectionRecord({
            bookmaker,
            bookmakerId,
            capturedAt,
            depthValue: row.depthAway,
            displayLabel: `${awaySelection.label} ${formatLine(baseLine * -1)}`,
            event,
            game,
            layDepthValue: row.depthLayAway,
            layValue: row.layAway,
            line: baseLine * -1,
            market,
            oddsValue: row.away,
            participantKey: awaySelection.key,
            rawLabel: event.away,
            rawSelection: {
              handicap: baseLine * -1,
              label: event.away,
              side: "away",
              odds: row.away ?? null,
              layOdds: row.layAway ?? null,
              depth: row.depthAway ?? null,
              layDepth: row.depthLayAway ?? null,
            },
            selection: awaySelection.key,
            source,
            sourceFamily: "spread",
            sourceMarketKey: buildStableId([event.id, market.name, baseLine]),
            sourceSelectionKey: awaySelection.key,
          }),
          instrumentId: autoMap
            ? buildStableId([
                game.game.id,
                "spreads",
                awaySelection.label,
                baseLine * -1,
              ])
            : null,
        },
      ];
    })
    .filter((record) => record.priceRaw != null);
}

function buildTotalRecords(
  bookmaker: OddsApiBookmakerName,
  event: OddsApiEventOdds,
  game: ResearchGameCard,
  market: OddsApiMarket,
  autoMap: boolean,
  source: OddsApiSourceId,
  capturedAt: string
) {
  const bookmakerId = event.bookmakerIds?.[bookmaker] ?? null;

  return (market.odds ?? [])
    .flatMap((row) => {
      const line = extractLine(row);
      if (line == null) {
        return [];
      }

      return [
        {
          ...makeSelectionRecord({
            bookmaker,
            bookmakerId,
            capturedAt,
            depthValue: row.depthOver,
            displayLabel: `Over ${line} total`,
            event,
            game,
            layDepthValue: row.depthLayOver,
            layValue: row.layOver,
            line,
            market,
            oddsValue: row.over,
            participantKey: null,
            rawLabel: "Over",
            rawSelection: {
              label: "Over",
              line,
              odds: row.over ?? null,
              layOdds: row.layOver ?? null,
              depth: row.depthOver ?? null,
              layDepth: row.depthLayOver ?? null,
            },
            selection: "over",
            source,
            sourceFamily: "total",
            sourceMarketKey: buildStableId([event.id, market.name, line]),
            sourceSelectionKey: "over",
          }),
          instrumentId: autoMap
            ? buildStableId([game.game.id, "totals", "over", line])
            : null,
        },
        {
          ...makeSelectionRecord({
            bookmaker,
            bookmakerId,
            capturedAt,
            depthValue: row.depthUnder,
            displayLabel: `Under ${line} total`,
            event,
            game,
            layDepthValue: row.depthLayUnder,
            layValue: row.layUnder,
            line,
            market,
            oddsValue: row.under,
            participantKey: null,
            rawLabel: "Under",
            rawSelection: {
              label: "Under",
              line,
              odds: row.under ?? null,
              layOdds: row.layUnder ?? null,
              depth: row.depthUnder ?? null,
              layDepth: row.depthLayUnder ?? null,
            },
            selection: "under",
            source,
            sourceFamily: "total",
            sourceMarketKey: buildStableId([event.id, market.name, line]),
            sourceSelectionKey: "under",
          }),
          instrumentId: autoMap
            ? buildStableId([game.game.id, "totals", "under", line])
            : null,
        },
      ];
    })
    .filter((record) => record.priceRaw != null);
}

export function buildOddsApiSelectionRecords(
  bookmaker: OddsApiBookmakerName,
  event: OddsApiEventOdds,
  game: ResearchGameCard
) {
  const source = bookmakerSourceMap[bookmaker];
  const markets = event.bookmakers?.[bookmaker] ?? [];

  return markets.flatMap((market) => {
    const capturedAt =
      market.updatedAt && !Number.isNaN(new Date(market.updatedAt).getTime())
        ? market.updatedAt
        : new Date().toISOString();
    const normalizedMarket = normalizeMarketName(market.name);

    switch (normalizedMarket?.family) {
      case "moneyline":
        return buildMoneylineRecords(
          bookmaker,
          event,
          game,
          market,
          normalizedMarket.autoMap,
          source,
          capturedAt
        );
      case "spread":
        return buildSpreadRecords(
          bookmaker,
          event,
          game,
          market,
          normalizedMarket.autoMap,
          source,
          capturedAt
        );
      case "total":
        return buildTotalRecords(
          bookmaker,
          event,
          game,
          market,
          normalizedMarket.autoMap,
          source,
          capturedAt
        );
      case "player-prop":
        return buildPlayerPropRecords(
          bookmaker,
          event,
          game,
          market,
          normalizedMarket.autoMap,
          source,
          capturedAt,
          normalizedMarket.playerPropMetric
        );
      default:
        return [];
    }
  });
}

function chunk<T>(items: T[], size: number) {
  const groups: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }

  return groups;
}

function buildOddsApiUrl(baseUrl: string, pathname: string) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(pathname.replace(/^\//, ""), normalizedBaseUrl);
}

export async function fetchOddsApiNbaEvents(options: {
  apiKey: string;
  bookmaker: OddsApiBookmakerName;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  from?: string;
  to?: string;
}) {
  const baseUrl = options.baseUrl ?? "https://api.odds-api.io/v3";
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildOddsApiUrl(baseUrl, "events");

  url.searchParams.set("apiKey", options.apiKey);
  url.searchParams.set("sport", "basketball");
  url.searchParams.set("league", "usa-nba");
  url.searchParams.set("status", "pending,live");
  url.searchParams.set("bookmaker", options.bookmaker);
  url.searchParams.set("limit", "100");
  if (options.from) {
    url.searchParams.set("from", options.from);
  }
  if (options.to) {
    url.searchParams.set("to", options.to);
  }

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    const context = [
      `sport=${url.searchParams.get("sport")}`,
      `league=${url.searchParams.get("league")}`,
      `status=${url.searchParams.get("status")}`,
      `bookmaker=${options.bookmaker}`,
      `from=${url.searchParams.get("from") ?? "n/a"}`,
      `to=${url.searchParams.get("to") ?? "n/a"}`,
      `limit=${url.searchParams.get("limit")}`,
    ].join(" ");
    throw new Error(
      `Odds-API events request for ${options.bookmaker} failed with status ${response.status} (${context}).`
    );
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as OddsApiEvent[]) : [];
}

export async function fetchOddsApiEventOdds(options: {
  apiKey: string;
  bookmaker: OddsApiBookmakerName;
  eventIds: Array<number | string>;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}) {
  const baseUrl = options.baseUrl ?? "https://api.odds-api.io/v3";
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: OddsApiEventOdds[] = [];

  for (const group of chunk(options.eventIds, 10)) {
    if (group.length === 0) {
      continue;
    }

    const url = buildOddsApiUrl(baseUrl, "odds/multi");
    url.searchParams.set("apiKey", options.apiKey);
    url.searchParams.set("bookmakers", options.bookmaker);
    url.searchParams.set(
      "eventIds",
      group.map((value) => String(value)).join(",")
    );

    const response = await fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(
        `Odds-API multi-odds request for ${options.bookmaker} failed with status ${response.status}.`
      );
    }

    const payload = (await response.json()) as unknown;
    if (Array.isArray(payload)) {
      results.push(...(payload as OddsApiEventOdds[]));
    }
  }

  return results;
}

async function syncOddsApiBookmaker(options: {
  apiKey?: string;
  baseUrl?: string;
  bookmaker: OddsApiBookmakerName;
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const source = bookmakerSourceMap[options.bookmaker];
  const startedAt = now().toISOString();
  const apiKey = getOddsApiKey({ apiKey: options.apiKey });

  if (!apiKey) {
    throw new Error(
      `Missing ODDS_API_KEY for ${options.bookmaker} backup ingestion.`
    );
  }

  try {
    const games =
      options.games ??
      listResearchGames({
        league: "NBA",
        referenceNow: now().toISOString(),
        sport: "basketball",
      });

    if (games.length === 0) {
      const finishedAt = now().toISOString();
      recordAdapterRun({
        finishedAt,
        recordsSeen: 0,
        recordsWritten: 0,
        source,
        startedAt,
        status: "ok",
      });

      return {
        bookmaker: options.bookmaker,
        finishedAt,
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        source,
        sourceMarketsObserved: 0,
        startedAt,
      } satisfies OddsApiSyncSummary;
    }

    const targetRange = buildTargetEventRange(games, { now: now() });
    if (!targetRange) {
      const finishedAt = now().toISOString();
      recordAdapterRun({
        finishedAt,
        recordsSeen: 0,
        recordsWritten: 0,
        source,
        startedAt,
        status: "ok",
      });

      return {
        bookmaker: options.bookmaker,
        finishedAt,
        gamesMatched: 0,
        marketsSeen: 0,
        ok: true as const,
        quoteObservationsWritten: 0,
        rawPayloadsWritten: 0,
        recordsSeen: 0,
        recordsWritten: 0,
        source,
        sourceMarketsObserved: 0,
        startedAt,
      } satisfies OddsApiSyncSummary;
    }

    const events = await fetchOddsApiNbaEvents({
      apiKey,
      baseUrl: options.baseUrl,
      bookmaker: options.bookmaker,
      fetchImpl: options.fetchImpl,
      from: targetRange.from,
      to: targetRange.to,
    });

    const matchedGames = events
      .map((event) => ({
        event,
        game: findMatchingGame(targetRange.targetGames, event),
      }))
      .filter(
        (
          value
        ): value is {
          event: OddsApiEvent;
          game: ResearchGameCard;
        } => value.game !== null
      );

    const oddsByEventId = new Map<string, OddsApiEventOdds>();
    const eventOdds = await fetchOddsApiEventOdds({
      apiKey,
      baseUrl: options.baseUrl,
      bookmaker: options.bookmaker,
      eventIds: matchedGames.map(({ event }) => event.id),
      fetchImpl: options.fetchImpl,
    });

    for (const event of eventOdds) {
      oddsByEventId.set(String(event.id), event);
    }

    let marketsSeen = 0;
    let quoteObservationsWritten = 0;
    let rawPayloadsWritten = 0;
    let sourceMarketsObserved = 0;
    const matchedGameIds = new Set<string>();

    for (const { event, game } of matchedGames) {
      const eventOddsPayload = oddsByEventId.get(String(event.id));
      if (!eventOddsPayload) {
        continue;
      }

      const records = buildOddsApiSelectionRecords(
        options.bookmaker,
        eventOddsPayload,
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
            bookmaker: options.bookmaker,
            bookmakerId:
              eventOddsPayload.bookmakerIds?.[options.bookmaker] ?? null,
            bookmakerUrl: eventOddsPayload.urls?.[options.bookmaker] ?? null,
            eventId: eventOddsPayload.id,
            eventStatus: eventOddsPayload.status ?? null,
            league: eventOddsPayload.league?.slug ?? null,
            provider: "odds-api.io",
          },
          source,
          sourceMarketKey: record.sourceMarketKey,
          sourceSelectionKey: record.sourceSelectionKey,
        });
        sourceMarketsObserved += 1;

        const quoteResult = recordQuoteObservation({
          bestAsk: record.bestAsk,
          bestBid: record.bestBid,
          capturedAt: record.capturedAt,
          depthScore: record.depthScore,
          heartbeatAfterMs: 5 * 60_000,
          impliedProbability: record.impliedProbability,
          lineRaw: record.lineRaw,
          oddsRaw: record.oddsRaw,
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
          source,
        });
        rawPayloadsWritten += 1;
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
      source,
      startedAt,
      status: "ok",
    });

    return {
      bookmaker: options.bookmaker,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      marketsSeen,
      ok: true as const,
      quoteObservationsWritten,
      rawPayloadsWritten,
      recordsSeen,
      recordsWritten,
      source,
      sourceMarketsObserved,
      startedAt,
    } satisfies OddsApiSyncSummary;
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source,
      startedAt,
      status: "error",
    });
    throw error;
  }
}

export async function syncOddsApiBet365NbaMarkets(options?: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  now?: () => Date;
}) {
  return syncOddsApiBookmaker({
    ...options,
    bookmaker: "Bet365",
  });
}

export async function syncOddsApiKalshiNbaMarkets(options?: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  games?: ResearchGameCard[];
  now?: () => Date;
}) {
  return syncOddsApiBookmaker({
    ...options,
    bookmaker: "Kalshi",
  });
}
