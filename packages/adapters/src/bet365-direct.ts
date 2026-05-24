import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type { MarketFamily } from "@signal-console/domain";
import {
  listResearchGames,
  recordAdapterRun,
  recordQuoteObservation,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

type PlaywrightBrowser = {
  close: () => Promise<void>;
  newContext: (options?: {
    storageState?: string;
    userAgent?: string;
  }) => Promise<PlaywrightContext>;
};

type PlaywrightContext = {
  close: () => Promise<void>;
  newPage: () => Promise<PlaywrightPage>;
};

type PlaywrightPage = {
  close: () => Promise<void>;
  content: () => Promise<string>;
  goto: (
    url: string,
    options?: { waitUntil?: string; timeout?: number }
  ) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  url: () => string;
};

export type Bet365DirectOffering = {
  family: MarketFamily;
  selection: string;
  participantKey?: string | null;
  line?: number | null;
  displayLabel: string;
  impliedProbability?: number | null;
  priceDecimal?: number | null;
  oddsAmerican?: number | null;
  rawLabel: string;
};

export type Bet365DirectGameSnapshot = {
  gameId: string;
  capturedAt: string;
  pageUrl: string;
  offerings: Bet365DirectOffering[];
};

export type Bet365DirectSyncSummary = {
  capturedSnapshots: number;
  finishedAt: string;
  gameErrors: Array<{ gameId: string; error: string }>;
  gamesAttempted: number;
  gamesMatched: number;
  ok: true;
  rawPayloadsWritten: number;
  startedAt: string;
  ticksWritten: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeToken(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function impliedProbFromDecimal(decimal: number) {
  return decimal > 0 ? 1 / decimal : null;
}

function impliedProbFromAmerican(odds: number) {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

function normalizeImplied(offering: Bet365DirectOffering): number | null {
  if (typeof offering.impliedProbability === "number") {
    return offering.impliedProbability;
  }
  if (typeof offering.oddsAmerican === "number") {
    return impliedProbFromAmerican(offering.oddsAmerican);
  }
  if (typeof offering.priceDecimal === "number") {
    return impliedProbFromDecimal(offering.priceDecimal);
  }
  return null;
}

/**
 * Parse a minimal DOM-ish HTML snippet into offerings.
 * This is a seam you can specialize against the real bet365 page shape after
 * you have captured one via Playwright. The current extractor is deliberately
 * conservative: it looks for `data-odds` decimal-odds attributes plus team-name
 * text content anchored by `data-team` attributes. If those markers are absent
 * it returns an empty list rather than guessing. That keeps ingest honest.
 */
export function parseBet365HtmlSnapshot(
  html: string,
  options: {
    awayTeamShort: string;
    homeTeamShort: string;
    awayParticipantKey: string;
    homeParticipantKey: string;
  }
): Bet365DirectOffering[] {
  const offerings: Bet365DirectOffering[] = [];
  const moneylinePattern =
    /<[^>]+data-market=["']moneyline["'][^>]*data-team=["']([^"']+)["'][^>]*data-odds=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = moneylinePattern.exec(html)) !== null) {
    const teamAttr = match[1].toLowerCase();
    const decimal = Number(match[2]);
    if (!Number.isFinite(decimal) || decimal <= 1) continue;
    const normalized = normalizeToken(teamAttr);
    const participantKey =
      normalized === normalizeToken(options.awayTeamShort) ||
      normalized === options.awayParticipantKey
        ? options.awayParticipantKey
        : normalized === normalizeToken(options.homeTeamShort) ||
            normalized === options.homeParticipantKey
          ? options.homeParticipantKey
          : null;
    if (!participantKey) continue;
    offerings.push({
      displayLabel: `${participantKey} moneyline`,
      family: "moneyline",
      impliedProbability: impliedProbFromDecimal(decimal),
      participantKey,
      priceDecimal: decimal,
      rawLabel: teamAttr,
      selection: participantKey,
    });
  }

  return offerings;
}

export async function openBet365Browser(options?: {
  storageStatePath?: string;
  headless?: boolean;
  userAgent?: string;
}): Promise<{
  browser: PlaywrightBrowser;
  context: PlaywrightContext;
  page: PlaywrightPage;
}> {
  const storageStatePath =
    options?.storageStatePath ?? process.env.BET365_SESSION_STATE_PATH;
  if (!storageStatePath) {
    throw new Error(
      "BET365_SESSION_STATE_PATH is not configured; provide a Playwright storageState.json."
    );
  }
  if (!existsSync(storageStatePath)) {
    throw new Error(
      `Bet365 session state file does not exist: ${storageStatePath}`
    );
  }

  const imported = (await import("playwright").catch((err) => {
    throw new Error(
      `playwright is not installed in this environment: ${err instanceof Error ? err.message : String(err)}`
    );
  })) as {
    chromium: {
      launch: (opts?: { headless?: boolean }) => Promise<PlaywrightBrowser>;
    };
  };

  const browser = await imported.chromium.launch({
    headless: options?.headless ?? true,
  });
  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent: options?.userAgent ?? DEFAULT_USER_AGENT,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function captureBet365Snapshot(options: {
  gameId: string;
  pageUrl: string;
  page: PlaywrightPage;
  awayTeamShort: string;
  homeTeamShort: string;
  awayParticipantKey: string;
  homeParticipantKey: string;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<Bet365DirectGameSnapshot> {
  const now = options.now ?? (() => new Date());
  await options.page.goto(options.pageUrl, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: "networkidle",
  });
  // Give single-page-app widgets a beat to populate odds DOM.
  await options.page.waitForTimeout(1500);
  const html = await options.page.content();
  const offerings = parseBet365HtmlSnapshot(html, {
    awayParticipantKey: options.awayParticipantKey,
    awayTeamShort: options.awayTeamShort,
    homeParticipantKey: options.homeParticipantKey,
    homeTeamShort: options.homeTeamShort,
  });
  return {
    capturedAt: now().toISOString(),
    gameId: options.gameId,
    offerings,
    pageUrl: options.page.url(),
  };
}

export function persistBet365Snapshot(snapshot: Bet365DirectGameSnapshot) {
  let ticksWritten = 0;
  let rawPayloadsWritten = 0;

  for (const offering of snapshot.offerings) {
    const implied = normalizeImplied(offering);
    if (implied == null) continue;

    const instrumentId = buildStableId([
      snapshot.gameId,
      offering.family,
      offering.participantKey ?? offering.selection,
      offering.line,
    ]);
    const sourceMarketId = `bet365-direct-${instrumentId}`;

    upsertMarketInstrument({
      displayLabel: offering.displayLabel,
      family: offering.family,
      gameId: snapshot.gameId,
      id: instrumentId,
      inPlay: true,
      line: offering.line ?? null,
      participantKey: offering.participantKey ?? null,
      selection: offering.selection,
    });

    upsertSourceMarket({
      gameId: snapshot.gameId,
      id: sourceMarketId,
      instrumentId,
      mappingStatus: "auto",
      rawFamily: offering.family,
      rawLabel: offering.rawLabel,
      rawMetadata: {
        displayLabel: offering.displayLabel,
        oddsAmerican: offering.oddsAmerican ?? null,
        pageUrl: snapshot.pageUrl,
        priceDecimal: offering.priceDecimal ?? null,
      },
      source: "bet365",
      sourceMarketKey: sourceMarketId,
      sourceSelectionKey: offering.participantKey ?? offering.selection,
    });

    const result = recordQuoteObservation({
      bestAsk: null,
      bestBid: null,
      capturedAt: snapshot.capturedAt,
      depthScore: null,
      heartbeatAfterMs: 5 * 60_000,
      impliedProbability: implied,
      lineRaw: offering.line ?? null,
      oddsRaw:
        typeof offering.oddsAmerican === "number"
          ? String(offering.oddsAmerican)
          : null,
      priceRaw: offering.priceDecimal ?? implied,
      sourceMarketId,
      volume: null,
    });
    if (result.wrote) ticksWritten += 1;

    recordRawPayload({
      capturedAt: snapshot.capturedAt,
      contentHash: buildRawPayloadHash(
        offering as unknown as Record<string, unknown>
      ),
      entityId: sourceMarketId,
      entityType: "source_market",
      payloadJson: offering as unknown as Record<string, unknown>,
      source: "bet365",
    });
    rawPayloadsWritten += 1;
  }

  return { rawPayloadsWritten, ticksWritten };
}

export async function syncBet365DirectLive(options?: {
  buildGameUrl?: (
    gameId: string,
    metadata: {
      awayTeamShort: string;
      homeTeamShort: string;
    }
  ) => string;
  gameLimit?: number;
  headless?: boolean;
  now?: () => Date;
  storageStatePath?: string;
}): Promise<Bet365DirectSyncSummary> {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const buildUrl =
    options?.buildGameUrl ??
    ((gameId: string, meta: { awayTeamShort: string; homeTeamShort: string }) =>
      `https://www.bet365.com/#/AC/B18/C20604387/E${encodeURIComponent(meta.awayTeamShort)}-${encodeURIComponent(meta.homeTeamShort)}/${gameId}`);

  const gameErrors: Array<{ error: string; gameId: string }> = [];
  let capturedSnapshots = 0;
  let ticksWritten = 0;
  let rawPayloadsWritten = 0;
  const matchedGameIds = new Set<string>();

  let browserHandle: Awaited<ReturnType<typeof openBet365Browser>> | null =
    null;

  try {
    const games = listResearchGames({
      league: "NBA",
      referenceNow: now().toISOString(),
      sport: "basketball",
    }).filter(
      (card) =>
        card.gameState?.status === "in-play" ||
        card.gameState?.status === "scheduled"
    );
    const limited = options?.gameLimit
      ? games.slice(0, options.gameLimit)
      : games;

    if (limited.length === 0) {
      const finishedAt = now().toISOString();
      recordAdapterRun({
        captureMode: "live",
        finishedAt,
        recordsSeen: 0,
        recordsWritten: 0,
        source: "bet365",
        startedAt,
        status: "ok",
      });
      return {
        capturedSnapshots: 0,
        finishedAt,
        gameErrors: [],
        gamesAttempted: 0,
        gamesMatched: 0,
        ok: true as const,
        rawPayloadsWritten: 0,
        startedAt,
        ticksWritten: 0,
      };
    }

    browserHandle = await openBet365Browser({
      headless: options?.headless,
      storageStatePath: options?.storageStatePath,
    });

    for (const game of limited) {
      try {
        const snapshot = await captureBet365Snapshot({
          awayParticipantKey: game.game.awayParticipant.key,
          awayTeamShort: game.game.awayParticipant.shortName,
          gameId: game.game.id,
          homeParticipantKey: game.game.homeParticipant.key,
          homeTeamShort: game.game.homeParticipant.shortName,
          now,
          page: browserHandle.page,
          pageUrl: buildUrl(game.game.id, {
            awayTeamShort: game.game.awayParticipant.shortName,
            homeTeamShort: game.game.homeParticipant.shortName,
          }),
        });

        if (snapshot.offerings.length > 0) {
          const stats = persistBet365Snapshot(snapshot);
          ticksWritten += stats.ticksWritten;
          rawPayloadsWritten += stats.rawPayloadsWritten;
          capturedSnapshots += 1;
          matchedGameIds.add(game.game.id);
        }
      } catch (gameError) {
        gameErrors.push({
          error:
            gameError instanceof Error ? gameError.message : String(gameError),
          gameId: game.game.id,
        });
      }
    }

    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "live",
      finishedAt,
      recordsSeen: limited.length,
      recordsWritten: ticksWritten,
      source: "bet365",
      startedAt,
      status: "ok",
    });

    return {
      capturedSnapshots,
      finishedAt,
      gameErrors,
      gamesAttempted: limited.length,
      gamesMatched: matchedGameIds.size,
      ok: true as const,
      rawPayloadsWritten,
      startedAt,
      ticksWritten,
    };
  } catch (error) {
    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "live",
      errorMessage: error instanceof Error ? error.message : String(error),
      finishedAt,
      recordsSeen: 0,
      recordsWritten: 0,
      source: "bet365",
      startedAt,
      status: "error",
    });
    throw error;
  } finally {
    if (browserHandle) {
      await browserHandle.page.close().catch(() => {});
      await browserHandle.context.close().catch(() => {});
      await browserHandle.browser.close().catch(() => {});
    }
  }
}
