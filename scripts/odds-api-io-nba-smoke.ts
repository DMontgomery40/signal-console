import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntimeEnv } from "../packages/shared/src/env";
import {
  ODDS_API_IO_NBA_MARKETS,
  ODDS_API_IO_SELECTED_BOOKMAKER_SPINE,
  applyOddsApiIoWebSocketMessage,
  buildOddsApiIoRestUrl,
  buildOddsApiIoWebSocketUrl,
  createInitialOddsApiIoWebSocketState,
  discoverOddsApiIoNbaLeagueSlugs,
  extractOddsApiIoBookmakerNames,
  readOddsApiIoApiKey,
  redactOddsApiIoUrl,
  summarizeOddsApiIoCoverage,
  verifyOddsApiIoSelectedBookmakers,
  type OddsApiIoEvent,
  type OddsApiIoEventOdds,
  type OddsApiIoMarket,
  type OddsApiIoMarketFamily,
  type OddsApiIoWebSocketMessage,
} from "../packages/adapters/src/odds-api-io-live-comparator";

interface CliOptions {
  readonly from?: string;
  readonly outDir?: string;
  readonly skipWebSocket: boolean;
  readonly timeoutMs: number;
  readonly to?: string;
}

interface HttpEvidence {
  readonly label: string;
  readonly ok: boolean;
  readonly redactedUrl: string;
  readonly status: number;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutRoot = resolve(repoRoot, "outputs", "odds-api-io-live-comparator");
const selectedHeaders = [
  "X-OddsAPI-Seq",
  "x-oddsapi-seq",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
] as const;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: {
    from?: string;
    outDir?: string;
    skipWebSocket: boolean;
    timeoutMs: number;
    to?: string;
  } = {
    skipWebSocket: false,
    timeoutMs: 45_000,
  };

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    const [name, value] = arg.split("=", 2);
    if (name === "--from") {
      if (value == null || value.length === 0) {
        throw new Error("--from requires an ISO timestamp value.");
      }
      options.from = value;
    } else if (name === "--to") {
      if (value == null || value.length === 0) {
        throw new Error("--to requires an ISO timestamp value.");
      }
      options.to = value;
    } else if (name === "--out-dir") {
      if (value == null || value.length === 0) {
        throw new Error("--out-dir requires a path value.");
      }
      options.outDir = value;
    } else if (name === "--timeout-ms") {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 1_000) {
        options.timeoutMs = parsed;
      }
    } else if (name === "--skip-websocket") {
      options.skipWebSocket = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function defaultDateRange(now: Date) {
  return {
    from: new Date(now.getTime() - 12 * 60 * 60_000).toISOString(),
    to: new Date(now.getTime() + 21 * 24 * 60 * 60_000).toISOString(),
  };
}

function safeStamp(value: string) {
  return value.replace(/[:.]/g, "-");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, body, "utf8");
  return {
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function extractHeaders(headers: Headers) {
  return Object.fromEntries(
    selectedHeaders
      .map((name) => [name, headers.get(name)] as const)
      .filter(([, value]) => value != null),
  );
}

async function fetchJsonEvidence(options: {
  readonly label: string;
  readonly rawPath: string;
  readonly url: URL;
}) {
  const response = await fetch(options.url.toString());
  const text = await response.text();
  let payload: unknown = text;

  try {
    const parsedJson: unknown = text.length > 0 ? JSON.parse(text) : null;
    payload = parsedJson;
  } catch {
    payload = text;
  }

  const rawFile = writeJson(options.rawPath, {
    capturedAt: new Date().toISOString(),
    headers: extractHeaders(response.headers),
    payload,
    request: {
      method: "GET",
      url: redactOddsApiIoUrl(options.url.toString()),
    },
    status: response.status,
  });

  return {
    evidence: {
      label: options.label,
      ok: response.ok,
      redactedUrl: redactOddsApiIoUrl(options.url.toString()),
      status: response.status,
    } satisfies HttpEvidence,
    payload,
    rawFile,
    response,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : null;
}

function stringOrNumberOrNull(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function nullableNestedNameSlug(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    name: stringOrNull(value["name"]),
    slug: stringOrNull(value["slug"]),
  };
}

function coerceLeagues(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    eventsCount: numberOrNull(entry["eventsCount"]),
    name: stringOrNull(entry["name"]),
    slug: stringOrNull(entry["slug"]),
  }));
}

function coerceEvents(value: unknown): OddsApiIoEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    away: stringOrNull(entry["away"]),
    date: stringOrNull(entry["date"]),
    home: stringOrNull(entry["home"]),
    id: stringOrNumberOrNull(entry["id"]),
    league: nullableNestedNameSlug(entry["league"]),
    sport: nullableNestedNameSlug(entry["sport"]),
    status: stringOrNull(entry["status"]),
  }));
}

function coerceMarkets(value: unknown): OddsApiIoMarket[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    name: stringOrNull(entry["name"]),
    odds: Array.isArray(entry["odds"]) ? entry["odds"].filter(isRecord) : null,
    updatedAt: stringOrNull(entry["updatedAt"]),
  }));
}

function coerceEventOddsArray(value: unknown): OddsApiIoEventOdds[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map((entry) => ({
      bookmakers: isRecord(entry["bookmakers"])
        ? Object.fromEntries(
            Object.entries(entry["bookmakers"]).map(([bookmaker, markets]) => [
              bookmaker,
              coerceMarkets(markets),
            ]),
          )
        : null,
      id: stringOrNumberOrNull(entry["id"]),
    }));
  }
  if (isRecord(value) && Array.isArray(value["data"])) {
    return coerceEventOddsArray(value["data"]);
  }
  return [];
}

function coerceWebSocketEventOddsMessages(messages: readonly OddsApiIoWebSocketMessage[]) {
  return messages.flatMap((message) => {
    const bookie = typeof message.bookie === "string" ? message.bookie : null;
    const markets = Array.isArray(message.markets) ? message.markets : null;
    if (bookie == null || markets == null) {
      return [];
    }

    return [
      {
        bookmakers: {
          [bookie]: markets,
        },
        id: message.id ?? null,
      } satisfies OddsApiIoEventOdds,
    ];
  });
}

function extractEventIds(events: readonly OddsApiIoEvent[]) {
  return events
    .map((event) => event.id)
    .filter((id): id is string | number => id != null && String(id).length > 0)
    .slice(0, 10);
}

function summarizeFamilyEvidence(inputs: {
  readonly restSnapshot: readonly OddsApiIoEventOdds[];
  readonly restUpdated: readonly OddsApiIoEventOdds[];
  readonly websocket: readonly OddsApiIoEventOdds[];
}) {
  const restSnapshot = summarizeOddsApiIoCoverage(inputs.restSnapshot).marketFamiliesObserved;
  const restUpdated = summarizeOddsApiIoCoverage(inputs.restUpdated).marketFamiliesObserved;
  const websocket = summarizeOddsApiIoCoverage(inputs.websocket).marketFamiliesObserved;
  const families: readonly OddsApiIoMarketFamily[] = [
    "moneyline",
    "spread",
    "total",
    "player-prop",
  ];

  return Object.fromEntries(
    families.map((family) => [
      family,
      {
        restSnapshotCount: restSnapshot[family] ?? 0,
        restUpdatedDeltaCount: restUpdated[family] ?? 0,
        websocketCount: websocket[family] ?? 0,
      },
    ]),
  );
}

function stringifyWebSocketData(data: unknown) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function describeWebSocketError(error: unknown) {
  if (isRecord(error) && "message" in error) {
    return String(error["message"]);
  }
  return String(error);
}

async function collectWebSocketEvidence(options: {
  readonly apiKey: string;
  readonly eventIds: readonly (number | string)[];
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly snapshotSeq: number | null;
}) {
  const socketConstructor = globalThis.WebSocket;
  const baseWebSocketOptions = {
    apiKey: options.apiKey,
    lastSeq: options.snapshotSeq,
    markets: ODDS_API_IO_NBA_MARKETS,
    sport: ["basketball"],
  };
  const websocketOptions: Parameters<typeof buildOddsApiIoWebSocketUrl>[0] =
    options.eventIds.length > 0
      ? {
          ...baseWebSocketOptions,
          eventIds: options.eventIds,
        }
      : {
          ...baseWebSocketOptions,
          leagues: ["usa-nba"],
        };
  const url = buildOddsApiIoWebSocketUrl(websocketOptions);
  const rawPath = join(options.outDir, "raw", "websocket-messages.jsonl");
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, "", "utf8");

  const parsedMessages: OddsApiIoWebSocketMessage[] = [];
  let state = createInitialOddsApiIoWebSocketState();
  const webSocketStatus: {
    error: string;
    opened: boolean;
    openedAt: string | null;
  } = {
    error: "",
    opened: false,
    openedAt: null,
  };
  let closeInfo: { code: number; reason: string; wasClean: boolean } | null = null;

  await new Promise<void>((resolvePromise) => {
    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolvePromise();
      }
    };
    const socket = new socketConstructor(url.toString());
    const timeout = setTimeout(() => {
      if (socket.readyState < 2) {
        socket.close(1000, "signal-console smoke timeout");
      }
      resolveOnce();
    }, options.timeoutMs);

    socket.addEventListener("open", () => {
      webSocketStatus.openedAt = new Date().toISOString();
      webSocketStatus.opened = true;
    });

    socket.addEventListener("message", (event) => {
      const receivedAt = new Date().toISOString();
      const raw = stringifyWebSocketData(event.data);
      let parsed: OddsApiIoWebSocketMessage = {
        message: raw,
        type: "unparsed",
      };

      try {
        const parsedJson: unknown = JSON.parse(raw);
        parsed = isRecord(parsedJson) ? parsedJson : { message: raw, type: "unparsed" };
      } catch {
        webSocketStatus.error = "Received a non-JSON WebSocket frame.";
      }

      parsedMessages.push(parsed);
      state = applyOddsApiIoWebSocketMessage(state, parsed, receivedAt);
      appendFileSync(
        rawPath,
        `${JSON.stringify({
          parsed,
          receivedAt,
        })}\n`,
        "utf8",
      );
    });

    socket.addEventListener("error", (error) => {
      webSocketStatus.error = describeWebSocketError(error);
    });

    socket.addEventListener("close", (event) => {
      closeInfo = {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      };
      resolveOnce();
    });
  });

  const rawBody = `${JSON.stringify({
    closeInfo,
    openedAt: webSocketStatus.openedAt,
    redactedUrl: redactOddsApiIoUrl(url.toString()),
    state,
  })}\n`;
  appendFileSync(rawPath, rawBody, "utf8");

  return {
    messages: parsedMessages,
    rawFile: {
      path: rawPath,
      sha256: createHash("sha256").update(readFileSync(rawPath)).digest("hex"),
    },
    summary: {
      closeInfo,
      error: webSocketStatus.error.length > 0 ? webSocketStatus.error : null,
      messageCount: parsedMessages.length,
      ok: webSocketStatus.opened && webSocketStatus.error.length === 0,
      openedAt: webSocketStatus.openedAt,
      redactedUrl: redactOddsApiIoUrl(url.toString()),
      state,
    },
  };
}

async function main() {
  loadRuntimeEnv();
  const options = parseArgs(process.argv.slice(2));
  const apiKey = readOddsApiIoApiKey();
  if (apiKey == null || apiKey.length === 0) {
    throw new Error("Missing ODDSAPI_API_KEY, ODDS_API_KEY, or ODDS_API_IO_KEY.");
  }

  const capturedAt = new Date();
  const dateRange = defaultDateRange(capturedAt);
  const outDir = resolve(
    options.outDir ?? join(defaultOutRoot, safeStamp(capturedAt.toISOString())),
  );
  const rawDir = join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  const from = options.from ?? dateRange.from;
  const to = options.to ?? dateRange.to;
  const requests: HttpEvidence[] = [];
  const rawFiles: Array<{ path: string; sha256: string }> = [];

  const selectedUrl = buildOddsApiIoRestUrl("bookmakers/selected", { apiKey });
  const selectedResult = await fetchJsonEvidence({
    label: "selected-bookmakers",
    rawPath: join(rawDir, "selected-bookmakers.json"),
    url: selectedUrl,
  });
  requests.push(selectedResult.evidence);
  rawFiles.push(selectedResult.rawFile);
  const selectedBookmakers = extractOddsApiIoBookmakerNames(selectedResult.payload);
  const selectedVerification = verifyOddsApiIoSelectedBookmakers(selectedBookmakers);

  const leaguesUrl = buildOddsApiIoRestUrl("leagues", {
    apiKey,
    sport: "basketball",
  });
  const leaguesResult = await fetchJsonEvidence({
    label: "basketball-leagues",
    rawPath: join(rawDir, "basketball-leagues.json"),
    url: leaguesUrl,
  });
  requests.push(leaguesResult.evidence);
  rawFiles.push(leaguesResult.rawFile);
  const nbaLeagueSlugs = discoverOddsApiIoNbaLeagueSlugs(coerceLeagues(leaguesResult.payload));
  const leagueCandidates = nbaLeagueSlugs.length > 0 ? nbaLeagueSlugs : ["usa-nba"];

  const eventsByLeague: Record<string, OddsApiIoEvent[]> = {};
  for (const league of leagueCandidates) {
    const eventsUrl = buildOddsApiIoRestUrl("events", {
      apiKey,
      from,
      league,
      sport: "basketball",
      status: "pending,live",
      to,
    });
    const eventsResult = await fetchJsonEvidence({
      label: `nba-events-${league}`,
      rawPath: join(rawDir, `nba-events-${league}.json`),
      url: eventsUrl,
    });
    requests.push(eventsResult.evidence);
    rawFiles.push(eventsResult.rawFile);
    eventsByLeague[league] = coerceEvents(eventsResult.payload);
  }

  const selectedLeague =
    leagueCandidates.find((league) => (eventsByLeague[league]?.length ?? 0) > 0) ??
    leagueCandidates[0] ??
    "usa-nba";
  const selectedEvents = eventsByLeague[selectedLeague] ?? [];
  const eventIds = extractEventIds(selectedEvents);

  let restSnapshot: OddsApiIoEventOdds[] = [];
  let restSnapshotSeq: number | null = null;
  if (eventIds.length > 0) {
    const snapshotUrl = buildOddsApiIoRestUrl("odds/multi", {
      apiKey,
      bookmakers: ODDS_API_IO_SELECTED_BOOKMAKER_SPINE,
      eventIds,
      includeSeq: "true",
    });
    const snapshotResult = await fetchJsonEvidence({
      label: "odds-snapshot",
      rawPath: join(rawDir, "odds-snapshot.json"),
      url: snapshotUrl,
    });
    requests.push(snapshotResult.evidence);
    rawFiles.push(snapshotResult.rawFile);
    restSnapshot = coerceEventOddsArray(snapshotResult.payload);
    restSnapshotSeq = Number(snapshotResult.response.headers.get("X-OddsAPI-Seq"));
    if (!Number.isFinite(restSnapshotSeq)) {
      restSnapshotSeq = null;
    }
  }

  const sinceUnixSeconds = Math.max(0, Math.floor((Date.now() - 45_000) / 1_000));
  const restUpdatedPayloads: OddsApiIoEventOdds[] = [];
  for (const bookmaker of ODDS_API_IO_SELECTED_BOOKMAKER_SPINE) {
    const updatedUrl = buildOddsApiIoRestUrl("odds/updated", {
      apiKey,
      bookmaker,
      since: sinceUnixSeconds,
      sport: "Basketball",
    });
    const updatedResult = await fetchJsonEvidence({
      label: `odds-updated-${bookmaker}`,
      rawPath: join(rawDir, `odds-updated-${bookmaker}.json`),
      url: updatedUrl,
    });
    requests.push(updatedResult.evidence);
    rawFiles.push(updatedResult.rawFile);
    restUpdatedPayloads.push(...coerceEventOddsArray(updatedResult.payload));
  }

  const websocketEvidence = options.skipWebSocket
    ? {
        messages: [],
        rawFile: null,
        summary: {
          ok: false,
          skipped: true,
        },
      }
    : await collectWebSocketEvidence({
        apiKey,
        eventIds,
        outDir,
        snapshotSeq: restSnapshotSeq,
        timeoutMs: options.timeoutMs,
      });
  if (websocketEvidence.rawFile) {
    rawFiles.push(websocketEvidence.rawFile);
  }

  const websocketEventOdds = coerceWebSocketEventOddsMessages(websocketEvidence.messages);
  const restSnapshotCoverage = summarizeOddsApiIoCoverage(restSnapshot);
  const restUpdatedCoverage = summarizeOddsApiIoCoverage(restUpdatedPayloads);
  const websocketCoverage = summarizeOddsApiIoCoverage(websocketEventOdds);
  const familyEvidence = summarizeFamilyEvidence({
    restSnapshot,
    restUpdated: restUpdatedPayloads,
    websocket: websocketEventOdds,
  });
  const marketProofStatus =
    eventIds.length === 0
      ? "calendar-blocked-no-nba-events-in-provider-window"
      : Object.values(familyEvidence).some((family) => family.websocketCount > 0)
        ? "websocket-updates-observed"
        : restSnapshot.length > 0 || restUpdatedPayloads.length > 0
          ? "rest-snapshot-or-delta-only-during-smoke-window"
          : "no-market-payloads-observed";

  const summary = {
    capturedAt: capturedAt.toISOString(),
    docsFetchedBeforeImplementation: [
      "https://docs.odds-api.io/llms.txt",
      "https://docs.odds-api.io/llms-full.txt",
      "https://docs.odds-api.io/guides/websockets",
      "https://docs.odds-api.io/guides/prediction-markets",
      "https://docs.odds-api.io/examples/player-props",
    ],
    eventDiscovery: {
      dateRange: { from, to },
      eventIds,
      eventsFound: selectedEvents.length,
      leagueCandidates,
      selectedLeague,
    },
    familyEvidence,
    marketProofStatus,
    rawPayloadProvenance: rawFiles.map((file) => ({
      path: file.path.replace(`${repoRoot}/`, ""),
      sha256: file.sha256,
    })),
    requests,
    restSnapshotCoverage,
    restUpdatedCoverage,
    selectedBookmakers,
    selectedVerification,
    websocket: {
      coverage: websocketCoverage,
      summary: websocketEvidence.summary,
    },
  };

  const summaryFile = writeJson(join(outDir, "summary.json"), summary);
  const markdown = [
    "# Odds-API.io NBA Live Comparator Smoke",
    "",
    `- Captured at: ${summary.capturedAt}`,
    `- Selected bookmaker spine OK: ${summary.selectedVerification.ok}`,
    `- NBA league selected: ${summary.eventDiscovery.selectedLeague}`,
    `- NBA events found: ${summary.eventDiscovery.eventsFound}`,
    `- Market proof status: ${summary.marketProofStatus}`,
    `- Summary JSON: ${summaryFile.path.replace(`${repoRoot}/`, "")}`,
    "",
    "## Family Evidence",
    "",
    "```json",
    JSON.stringify(summary.familyEvidence, null, 2),
    "```",
    "",
    "## Raw Payload Provenance",
    "",
    ...summary.rawPayloadProvenance.map((file) => `- ${file.path} sha256=${file.sha256}`),
    "",
  ].join("\n");
  writeFileSync(join(outDir, "SUMMARY.md"), markdown, "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
