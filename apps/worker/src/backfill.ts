import {
  syncBet365DirectLive,
  syncBet365Historical,
  syncBet365InternalDump,
  syncKalshiNbaDirect,
  syncKalshiNbaHistorical,
  syncKalshiNbaTrades,
  syncPolymarketNbaHistorical,
  syncPolymarketNbaTrades,
} from "@signal-console/adapters";
import {
  closeDatabase,
  createAppLogger,
  loadRuntimeEnv,
  serializeErrorForLog,
} from "@signal-console/shared";

import { syncNbaSidecarWindow } from "./nba-sidecar";

type BackfillTarget =
  | "all"
  | "bet365-direct"
  | "bet365-historical"
  | "bet365-internal"
  | "kalshi"
  | "kalshi-historical"
  | "kalshi-trades"
  | "nba"
  | "polymarket"
  | "polymarket-trades";

type BackfillOptions = {
  fidelityMinutes?: number;
  gameId?: string;
  league?: string;
  lookaheadDays?: number;
  lookbackDays?: number;
  maxEvents?: number;
  maxTickers?: number;
  periodIntervalMinutes?: 1 | 60;
  since?: string;
  target: BackfillTarget;
  until?: string;
};

const DEFAULT_LOOKBACK_DAYS = 30;

function parseArgs(argv: string[]): BackfillOptions {
  const args: Record<string, string | undefined> = {};
  let target: BackfillTarget = "all";

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (
      token === "kalshi" ||
      token === "kalshi-historical" ||
      token === "kalshi-trades" ||
      token === "polymarket" ||
      token === "polymarket-trades" ||
      token === "nba" ||
      token === "bet365-historical" ||
      token === "bet365-internal" ||
      token === "bet365-direct" ||
      token === "all"
    ) {
      target = token;
      continue;
    }

    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }

  const asNumber = (value: string | undefined) => {
    if (!value) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };

  const period = asNumber(args.periodInterval);
  return {
    fidelityMinutes: asNumber(args.fidelity),
    gameId: args.gameId,
    league: args.league,
    lookaheadDays: asNumber(args.lookaheadDays),
    lookbackDays: asNumber(args.lookbackDays) ?? DEFAULT_LOOKBACK_DAYS,
    maxEvents: asNumber(args.maxEvents),
    maxTickers: asNumber(args.maxTickers),
    periodIntervalMinutes:
      period === 1 || period === 60 ? (period as 1 | 60) : undefined,
    since: args.since,
    target,
    until: args.until,
  };
}

function printUsage() {
  const lines = [
    "Signal Console historical backfill",
    "",
    "Usage:",
    "  pnpm backfill nba [--lookbackDays 365] [--lookaheadDays 0]",
    "  pnpm backfill kalshi [--since 2026-04-20] [--maxEvents N]",
    "  pnpm backfill kalshi-historical [--maxEvents N] [--periodInterval 1|60]",
    "  pnpm backfill kalshi-trades --since 2026-05-11T20:00:00Z --until 2026-05-12T08:00:00Z [--gameId nba-0042500224] [--maxTickers N]",
    "  pnpm backfill polymarket [--since 2024-10-01] [--maxEvents N] [--fidelity 1]",
    "  pnpm backfill polymarket-trades --since 2026-05-18T00:00:00Z --until 2026-05-18T05:30:00Z [--gameId nba-0042500207] [--maxTickers N]",
    "  pnpm backfill bet365-historical [--since 2026-04-29] [--until 2026-05-20] [--maxEvents N]",
    "  pnpm backfill bet365-internal    # reads BET365_INTERNAL_DUMP_DIR/*.jsonl",
    "  pnpm backfill bet365-direct      # Playwright scrape, needs BET365_SESSION_STATE_PATH",
    "  pnpm backfill all",
    "",
    "Order matters: run `nba` first so canonical games exist before matching market events.",
  ];

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

async function runNba(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  const summary = await syncNbaSidecarWindow({
    lookaheadDays: options.lookaheadDays ?? 0,
    lookbackDays: options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
  });
  if (!summary.ok) {
    throw new Error(
      `NBA sidecar historical window had partial failures: ${summary.dateErrors
        .map((entry) => `${entry.date}: ${entry.error}`)
        .join(" | ")}`
    );
  }
  logger.info(summary, "NBA sidecar historical window completed.");
  return summary;
}

async function runKalshi(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  const summary = await syncKalshiNbaDirect({
    captureMode: "historical",
    maxEvents: options.maxEvents,
    minimumStartDate: options.since,
  });
  logger.info(summary, "Kalshi NBA direct backfill completed.");
  return summary;
}

async function runKalshiHistorical(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  const summary = await syncKalshiNbaHistorical({
    maxEvents: options.maxEvents,
    periodIntervalMinutes: options.periodIntervalMinutes ?? 60,
  });
  logger.info(summary, "Kalshi NBA historical backfill completed.");
  return summary;
}

async function runKalshiTrades(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  if (!options.since || !options.until) {
    throw new Error(
      "kalshi-trades requires --since and --until (ISO8601 timestamps)"
    );
  }
  const summary = await syncKalshiNbaTrades({
    since: options.since,
    until: options.until,
    gameId: options.gameId,
    league: options.league,
    maxTickers: options.maxTickers,
  });
  logger.info(summary, "Kalshi NBA trades backfill completed.");
  return summary;
}

async function runPolymarket(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  const summary = await syncPolymarketNbaHistorical({
    fidelityMinutes: options.fidelityMinutes ?? 1,
    maxEvents: options.maxEvents,
    since: options.since,
  });
  logger.info(summary, "Polymarket NBA historical backfill completed.");
  return summary;
}

async function runPolymarketTrades(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  if (!options.since || !options.until) {
    throw new Error(
      "polymarket-trades requires --since and --until (ISO8601 timestamps)"
    );
  }
  const summary = await syncPolymarketNbaTrades({
    since: options.since,
    until: options.until,
    gameId: options.gameId,
    league: options.league,
    maxMarkets: options.maxTickers,
  });
  logger.info(summary, "Polymarket NBA trades backfill completed.");
  return summary;
}

async function runBet365Internal(logger: ReturnType<typeof createAppLogger>) {
  const summary = syncBet365InternalDump();
  logger.info(summary, "Bet365 internal dump ingest completed.");
  return summary;
}

async function runBet365Historical(
  logger: ReturnType<typeof createAppLogger>,
  options: BackfillOptions
) {
  const summary = await syncBet365Historical({
    dateFrom: options.since,
    dateTo: options.until,
    maxEvents: options.maxEvents,
  });
  logger.info(summary, "Bet365 historical Odds API backfill completed.");
  return summary;
}

async function runBet365Direct(logger: ReturnType<typeof createAppLogger>) {
  const summary = await syncBet365DirectLive({ headless: true });
  logger.info(summary, "Bet365 direct live capture completed.");
  return summary;
}

export async function runBackfill(argv: string[] = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  loadRuntimeEnv();
  const logger = createAppLogger({ component: "backfill" });
  const options = parseArgs(argv);
  logger.info(options, "Backfill starting.");

  try {
    switch (options.target) {
      case "nba":
        await runNba(logger, options);
        break;
      case "kalshi":
        await runKalshi(logger, options);
        break;
      case "kalshi-historical":
        await runKalshiHistorical(logger, options);
        break;
      case "kalshi-trades":
        await runKalshiTrades(logger, options);
        break;
      case "polymarket":
        await runPolymarket(logger, options);
        break;
      case "polymarket-trades":
        await runPolymarketTrades(logger, options);
        break;
      case "bet365-historical":
        await runBet365Historical(logger, options);
        break;
      case "bet365-internal":
        await runBet365Internal(logger);
        break;
      case "bet365-direct":
        await runBet365Direct(logger);
        break;
      case "all":
        await runNba(logger, options);
        await runKalshi(logger, options);
        await runPolymarket(logger, options);
        await runBet365Historical(logger, options);
        await runBet365Internal(logger);
        break;
    }
    logger.info(options, "Backfill finished.");
  } catch (error) {
    logger.error(
      { error: serializeErrorForLog(error), options },
      "Backfill failed."
    );
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runBackfill();
}
