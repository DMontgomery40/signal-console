import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { MarketFamily } from "@signal-console/domain";
import {
  appendHistoricalTick,
  listResearchGames,
  recordAdapterRun,
  recordRawPayload,
  upsertMarketInstrument,
  upsertSourceMarket,
} from "@signal-console/shared";

export type Bet365InternalRow = {
  observedAt: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  marketFamily: MarketFamily;
  selection: string;
  participantKey?: string | null;
  line?: number | null;
  priceDecimal?: number | null;
  impliedProbability?: number | null;
  oddsAmerican?: number | null;
  inPlay?: boolean;
};

export type Bet365InternalSyncSummary = {
  eligibleFiles: string[];
  finishedAt: string;
  gamesMatched: number;
  ok: true;
  parseErrors: Array<{ file: string; line: number; error: string }>;
  rowsParsed: number;
  rowsSkipped: number;
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

function shiftIsoDate(iso: string, deltaDays: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function americanToImplied(odds: number) {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

function decimalToImplied(decimal: number) {
  if (decimal <= 0) return null;
  return 1 / decimal;
}

function normalizeImpliedProbability(row: Bet365InternalRow) {
  if (typeof row.impliedProbability === "number") return row.impliedProbability;
  if (typeof row.oddsAmerican === "number") {
    return americanToImplied(row.oddsAmerican);
  }
  if (typeof row.priceDecimal === "number") {
    return decimalToImplied(row.priceDecimal);
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

function isEligibleFile(name: string) {
  return name.endsWith(".jsonl") || name.endsWith(".ndjson");
}

export function parseBet365DumpLine(
  rawLine: string,
  lineNumber: number,
  file: string
): { ok: true; row: Bet365InternalRow } | { ok: false; error: string } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { error: "empty line", ok: false };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    return {
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)} (${file}:${lineNumber})`,
      ok: false,
    };
  }

  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (parsed[key] != null) return parsed[key];
    }
    return null;
  };

  const observedAt = pick(
    "observed_at",
    "observedAt",
    "captured_at",
    "capturedAt"
  );
  const gameDate = pick("game_date", "gameDate");
  const homeTeam = pick("home_team", "homeTeam", "home");
  const awayTeam = pick("away_team", "awayTeam", "away");
  const marketFamily = pick("market_family", "marketFamily", "family");
  const selection = pick("selection", "sel");
  const participantKey = pick(
    "participant_key",
    "participantKey",
    "participant"
  );
  const lineValue = pick("line");
  const priceDecimal = pick(
    "price_decimal",
    "priceDecimal",
    "price",
    "decimal"
  );
  const impliedProbability = pick(
    "implied_probability",
    "impliedProbability",
    "implied",
    "prob"
  );
  const oddsAmerican = pick("odds_american", "oddsAmerican", "american");
  const inPlay = pick("in_play", "inPlay");

  if (
    typeof observedAt !== "string" ||
    typeof gameDate !== "string" ||
    typeof homeTeam !== "string" ||
    typeof awayTeam !== "string" ||
    typeof marketFamily !== "string" ||
    typeof selection !== "string"
  ) {
    return {
      error: `missing required fields observed_at / game_date / home_team / away_team / market_family / selection`,
      ok: false,
    };
  }

  const row: Bet365InternalRow = {
    awayTeam,
    gameDate,
    homeTeam,
    impliedProbability:
      typeof impliedProbability === "number" ? impliedProbability : null,
    inPlay: typeof inPlay === "boolean" ? inPlay : false,
    line: typeof lineValue === "number" ? lineValue : null,
    marketFamily: marketFamily as MarketFamily,
    observedAt,
    oddsAmerican: typeof oddsAmerican === "number" ? oddsAmerican : null,
    participantKey: typeof participantKey === "string" ? participantKey : null,
    priceDecimal: typeof priceDecimal === "number" ? priceDecimal : null,
    selection,
  };

  return { ok: true, row };
}

function buildGameIndex(games: Awaited<ReturnType<typeof listResearchGames>>) {
  const index = new Map<string, (typeof games)[number]>();
  for (const game of games) {
    const teamKeys = [
      game.game.awayParticipant.abbreviation ?? game.game.awayParticipant.key,
      game.game.homeParticipant.abbreviation ?? game.game.homeParticipant.key,
    ];
    const date = game.game.scheduledStart.slice(0, 10);
    for (const delta of [0, -1, 1]) {
      const key = buildGameKey(shiftIsoDate(date, delta), teamKeys);
      if (!index.has(key)) index.set(key, game);
    }
  }
  return index;
}

function resolveGame(
  row: Bet365InternalRow,
  gameIndex: ReturnType<typeof buildGameIndex>
) {
  const key = buildGameKey(row.gameDate, [row.homeTeam, row.awayTeam]);
  return gameIndex.get(key) ?? null;
}

function buildInstrumentId(row: Bet365InternalRow, gameId: string) {
  const participant = row.participantKey ?? row.selection;
  if (row.marketFamily === "moneyline") {
    return buildStableId([gameId, "moneyline", participant]);
  }
  if (row.marketFamily === "spread") {
    return buildStableId([gameId, "spread", participant, row.line]);
  }
  if (row.marketFamily === "total") {
    return buildStableId([gameId, "total", row.selection, row.line]);
  }
  return buildStableId([
    gameId,
    row.marketFamily,
    participant,
    row.selection,
    row.line,
  ]);
}

function buildDisplayLabel(row: Bet365InternalRow) {
  if (row.marketFamily === "moneyline") {
    return `${row.participantKey ?? row.selection} moneyline`;
  }
  if (row.marketFamily === "spread") {
    return `${row.participantKey ?? row.selection} ${row.line ?? "?"}`;
  }
  if (row.marketFamily === "total") {
    return `${row.selection} ${row.line ?? "?"} total`;
  }
  return `${row.marketFamily} ${row.selection}`;
}

export function syncBet365InternalDump(options?: {
  dumpDir?: string;
  now?: () => Date;
  processedDirName?: string;
  maxRowsPerRun?: number;
}) {
  const now = options?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const dumpDir = options?.dumpDir ?? process.env.BET365_INTERNAL_DUMP_DIR;
  const processedDirName = options?.processedDirName ?? "_processed";

  if (!dumpDir) {
    throw new Error(
      "BET365_INTERNAL_DUMP_DIR is not configured; set it or pass options.dumpDir."
    );
  }

  const dirStat = (() => {
    try {
      return statSync(dumpDir);
    } catch {
      return null;
    }
  })();

  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`Bet365 internal dump dir does not exist: ${dumpDir}`);
  }

  try {
    const games = listResearchGames({
      league: "NBA",
      scope: "all",
      sport: "basketball",
    });
    const gameIndex = buildGameIndex(games);

    const entries = readdirSync(dumpDir).filter(isEligibleFile);
    const parseErrors: Array<{ error: string; file: string; line: number }> =
      [];
    const matchedGameIds = new Set<string>();
    let rowsParsed = 0;
    let rowsSkipped = 0;
    let ticksWritten = 0;
    const maxRows = options?.maxRowsPerRun ?? Infinity;

    for (const file of entries) {
      const absolutePath = join(dumpDir, file);
      const content = readFileSync(absolutePath, "utf-8");
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i += 1) {
        if (rowsParsed >= maxRows) break;

        const raw = lines[i];
        if (!raw.trim()) continue;

        const parsed = parseBet365DumpLine(raw, i + 1, file);
        if (!parsed.ok) {
          parseErrors.push({ error: parsed.error, file, line: i + 1 });
          rowsSkipped += 1;
          continue;
        }

        const row = parsed.row;
        const game = resolveGame(row, gameIndex);
        if (!game) {
          rowsSkipped += 1;
          continue;
        }

        matchedGameIds.add(game.game.id);
        rowsParsed += 1;

        const instrumentId = buildInstrumentId(row, game.game.id);
        const sourceMarketId = `bet365-internal-${instrumentId}`;
        const implied = normalizeImpliedProbability(row);

        upsertMarketInstrument({
          displayLabel: buildDisplayLabel(row),
          family: row.marketFamily,
          gameId: game.game.id,
          id: instrumentId,
          inPlay: row.inPlay ?? false,
          line: row.line ?? null,
          participantKey: row.participantKey ?? null,
          selection: row.selection,
        });

        upsertSourceMarket({
          gameId: game.game.id,
          id: sourceMarketId,
          instrumentId,
          mappingStatus: "auto",
          rawFamily: row.marketFamily,
          rawLabel: row.selection,
          rawMetadata: {
            awayTeam: row.awayTeam,
            gameDate: row.gameDate,
            homeTeam: row.homeTeam,
            importedFromFile: file,
            oddsAmerican: row.oddsAmerican ?? null,
            priceDecimal: row.priceDecimal ?? null,
          },
          source: "bet365",
          sourceMarketKey: sourceMarketId,
          sourceSelectionKey: row.participantKey ?? row.selection,
        });

        const result = appendHistoricalTick({
          bestAsk: null,
          bestBid: null,
          capturedAt: row.observedAt,
          depthScore: null,
          impliedProbability: implied,
          lineRaw: row.line ?? null,
          oddsRaw:
            typeof row.oddsAmerican === "number"
              ? String(row.oddsAmerican)
              : null,
          priceRaw: row.priceDecimal ?? implied,
          sourceMarketId,
          volume: null,
        });
        if (result.inserted) ticksWritten += 1;

        recordRawPayload({
          capturedAt: row.observedAt,
          contentHash: buildRawPayloadHash(row),
          entityId: sourceMarketId,
          entityType: "source_market_internal_dump",
          payloadJson: row as unknown as Record<string, unknown>,
          source: "bet365",
        });
      }

      // Archive file to _processed/ so we don't re-ingest next run.
      const processedDir = join(dumpDir, processedDirName);
      try {
        statSync(processedDir);
      } catch {
        // Missing processed dir — leave file in place; archiving is a
        // best-effort soft feature.
      }
      try {
        renameSync(absolutePath, join(processedDir, file));
      } catch {
        // best-effort; honest failure is fine
      }
    }

    const finishedAt = now().toISOString();
    recordAdapterRun({
      captureMode: "historical",
      finishedAt,
      recordsSeen: rowsParsed + rowsSkipped,
      recordsWritten: ticksWritten,
      source: "bet365",
      startedAt,
      status: "ok",
    });

    return {
      eligibleFiles: entries,
      finishedAt,
      gamesMatched: matchedGameIds.size,
      ok: true as const,
      parseErrors,
      rowsParsed,
      rowsSkipped,
      startedAt,
      ticksWritten,
    } satisfies Bet365InternalSyncSummary;
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
