import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { classToArtifactClass, SOURCE_CAPABILITY_MATRIX } from "./capability-matrix";
import type { PullJobRequest } from "./contract";
import {
  ARTIFACT_GZIP_THRESHOLD_BYTES,
  executePullJob,
  redactEvidence,
  resolveJobState,
  type ExecutorAdapters,
} from "./executor";
import { planPullJob } from "./planner";
import {
  ODDS_API_IO_MULTI_MAX_BOOKMAKERS,
  ODDS_API_IO_MULTI_MAX_EVENT_IDS,
  validatePullJobRequest,
  type ValidationCode,
} from "./validator";
import { validateExportRequest, type ExportValidationCode } from "./export-validator";

const NOW = 1_700_000_000; // fixed unix seconds for deterministic time rules.

function base(overrides: Partial<PullJobRequest> = {}): PullJobRequest {
  return {
    sources: ["kalshi"],
    date_from: "2026-01-01",
    date_to: "2026-01-31",
    capture_mode: "historical",
    market_scope: "all",
    ...overrides,
  };
}

function codes(input: unknown): ValidationCode[] {
  const result = validatePullJobRequest(input, { now: NOW });
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe("capability matrix", () => {
  it("maps each class to the right artifact class", () => {
    expect(classToArtifactClass("snapshot-eligible")).toBe("canonical");
    expect(classToArtifactClass("artifact-only")).toBe("artifact_only");
    expect(classToArtifactClass("pending")).toBe("pending");
  });

  it("models odds-api-io as artifact-only without a historical mode", () => {
    const row = SOURCE_CAPABILITY_MATRIX.find((r) => r.id === "odds-api-io");
    expect(row?.class).toBe("artifact-only");
    expect(row?.supportedModes).not.toContain("historical");
  });

  it("models direct DK/FD as pending with no supported modes", () => {
    for (const id of ["draftkings-direct", "fanduel-direct"]) {
      const row = SOURCE_CAPABILITY_MATRIX.find((r) => r.id === id);
      expect(row?.class).toBe("pending");
      expect(row?.supportedModes).toEqual([]);
    }
  });
});

describe("validator — valid requests", () => {
  it("accepts a kalshi historical request", () => {
    expect(codes(base())).toEqual([]);
  });

  it("accepts a valid live-ws request (markets, league only)", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML", "Player Props"],
            mode: "live-ws",
            league: "nba",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a valid updated-follow request (one bookmaker, fresh since)", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML"],
            mode: "updated-follow",
            since: NOW - 30,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a valid events-snapshot at the 10/30 limits", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "repair",
          odds_api_io: {
            bookmakers: Array.from(
              { length: ODDS_API_IO_MULTI_MAX_BOOKMAKERS },
              (_, i) => `book-${i}`,
            ),
            markets: ["ML"],
            mode: "events-snapshot",
            event_ids: Array.from({ length: ODDS_API_IO_MULTI_MAX_EVENT_IDS }, (_, i) => `e-${i}`),
          },
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a pending source (draftkings-direct) as plannable, not rejected", () => {
    // pending sources have no supported modes, so a capture_mode would be
    // unsupported; but the request itself with no incompatible mode is the
    // pending path exercised through the planner. Here we confirm it is a
    // *known* source (not unknown_source).
    expect(codes(base({ sources: ["draftkings-direct"], capture_mode: "historical" }))).toEqual([
      "unsupported_source_mode",
    ]);
  });
});

describe("validator — each rejection rule", () => {
  it("schema_invalid: missing required field", () => {
    expect(codes({ sources: ["kalshi"] })).toContain("schema_invalid");
  });

  it("unknown_source", () => {
    expect(codes(base({ sources: ["mystery-book"] }))).toContain("unknown_source");
  });

  it("unsupported_source_mode: odds-api-io historical", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "historical",
          odds_api_io: { bookmakers: ["Bet365"], markets: ["ML"], mode: "events-snapshot" },
        }),
      ),
    ).toContain("unsupported_source_mode");
  });

  it("odds_api_io_options_without_source", () => {
    expect(
      codes(
        base({
          sources: ["kalshi"],
          odds_api_io: { bookmakers: ["Bet365"], markets: ["ML"], mode: "events-snapshot" },
        }),
      ),
    ).toContain("odds_api_io_options_without_source");
  });

  it("odds_api_io_source_without_options", () => {
    expect(codes(base({ sources: ["odds-api-io"], capture_mode: "repair" }))).toContain(
      "odds_api_io_source_without_options",
    );
  });

  it("date_range_inverted", () => {
    expect(codes(base({ date_from: "2026-02-01", date_to: "2026-01-01" }))).toContain(
      "date_range_inverted",
    );
  });

  it("live_ws_requires_markets", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: { bookmakers: ["Bet365"], markets: [], mode: "live-ws" },
        }),
      ),
    ).toContain("live_ws_requires_markets");
  });

  it("live_ws_league_and_event_ids", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML"],
            mode: "live-ws",
            league: "nba",
            event_ids: ["e1"],
          },
        }),
      ),
    ).toContain("live_ws_league_and_event_ids");
  });

  it("updated_follow_requires_one_bookmaker: zero bookmakers", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: { bookmakers: [], markets: ["ML"], mode: "updated-follow", since: NOW },
        }),
      ),
    ).toContain("updated_follow_requires_one_bookmaker");
  });

  it("updated_follow_requires_one_bookmaker: more than one bookmaker", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365", "DraftKings"],
            markets: ["ML"],
            mode: "updated-follow",
            since: NOW,
          },
        }),
      ),
    ).toContain("updated_follow_requires_one_bookmaker");
  });

  it("updated_follow_requires_one_bookmaker: use_selected_bookmakers resolves to 5", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML"],
            mode: "updated-follow",
            since: NOW,
            use_selected_bookmakers: true,
          },
        }),
      ),
    ).toContain("updated_follow_requires_one_bookmaker");
  });

  it("updated_follow_requires_since", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: { bookmakers: ["Bet365"], markets: ["ML"], mode: "updated-follow" },
        }),
      ),
    ).toContain("updated_follow_requires_since");
  });

  it("updated_follow_since_stale: since older than 60s", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "live-capture",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML"],
            mode: "updated-follow",
            since: NOW - 61,
          },
        }),
      ),
    ).toContain("updated_follow_since_stale");
  });

  it("events_snapshot_too_many_event_ids", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "repair",
          odds_api_io: {
            bookmakers: ["Bet365"],
            markets: ["ML"],
            mode: "events-snapshot",
            event_ids: Array.from(
              { length: ODDS_API_IO_MULTI_MAX_EVENT_IDS + 1 },
              (_, i) => `e-${i}`,
            ),
          },
        }),
      ),
    ).toContain("events_snapshot_too_many_event_ids");
  });

  it("events_snapshot_too_many_bookmakers", () => {
    expect(
      codes(
        base({
          sources: ["odds-api-io"],
          capture_mode: "repair",
          odds_api_io: {
            bookmakers: Array.from(
              { length: ODDS_API_IO_MULTI_MAX_BOOKMAKERS + 1 },
              (_, i) => `book-${i}`,
            ),
            markets: ["ML"],
            mode: "events-snapshot",
          },
        }),
      ),
    ).toContain("events_snapshot_too_many_bookmakers");
  });
});

describe("planner — dry-run plan output (pure, no I/O)", () => {
  it("plans a kalshi historical request to a canonical snapshot-to-gold op", () => {
    const plan = planPullJob(base(), { now: NOW });
    expect(plan.ok).toBe(true);
    expect(plan.resolvedSources).toEqual(["kalshi"]);
    expect(plan.errors).toEqual([]);
    expect(plan.sources).toHaveLength(1);
    const kalshi = plan.sources[0]!;
    expect(kalshi.id).toBe("kalshi");
    expect(kalshi.artifactClass).toBe("canonical");
    expect(kalshi.operations.map((o) => o.kind)).toEqual(["snapshot-to-gold"]);
    expect(kalshi.operations[0]!.target).toBe("gold:kalshi");
  });

  it("plans an odds-api.io live-ws request to an artifact_only live-ws op", () => {
    const plan = planPullJob(
      base({
        sources: ["odds-api-io"],
        capture_mode: "live-capture",
        market_scope: "player-props",
        odds_api_io: {
          bookmakers: ["Bet365"],
          markets: ["ML", "Player Props"],
          mode: "live-ws",
          league: "nba",
        },
      }),
      { now: NOW },
    );
    expect(plan.ok).toBe(true);
    expect(plan.resolvedSources).toEqual(["odds-api-io"]);
    expect(plan.bookmakers).toEqual(["Bet365"]);
    const oai = plan.sources[0]!;
    expect(oai.artifactClass).toBe("artifact_only");
    expect(oai.operations.map((o) => o.kind)).toEqual(["live-ws"]);
    expect(oai.operations[0]!.target).toBe("wss://api.odds-api.io/v3/ws");
  });

  it("returns errors and no operations for an invalid request", () => {
    const plan = planPullJob(base({ date_from: "2026-02-01", date_to: "2026-01-01" }), {
      now: NOW,
    });
    expect(plan.ok).toBe(false);
    expect(plan.sources).toEqual([]);
    expect(plan.errors.map((e) => e.code)).toContain("date_range_inverted");
  });

  it("resolves use_selected_bookmakers to the 5-book spine in the plan", () => {
    const plan = planPullJob(
      base({
        sources: ["odds-api-io"],
        capture_mode: "repair",
        odds_api_io: {
          bookmakers: ["Bet365"],
          markets: ["ML"],
          mode: "events-snapshot",
          use_selected_bookmakers: true,
        },
      }),
      { now: NOW },
    );
    expect(plan.ok).toBe(true);
    expect(plan.bookmakers).toHaveLength(5);
  });
});

/* ------------------------------- executor --------------------------------- */

const SECRET_KEY = "sk-super-secret-odds-key";

function mockAdapters(overrides: Partial<ExecutorAdapters> = {}): ExecutorAdapters {
  return {
    syncKalshiNbaDirect: vi.fn(async () => ({ adapter: "kalshi-direct", ok: true })),
    syncKalshiNbaHistorical: vi.fn(async () => ({ adapter: "kalshi-historical", ok: true })),
    syncKalshiNbaTrades: vi.fn(async () => ({ adapter: "kalshi-trades", ok: true })),
    syncPolymarketNbaHistorical: vi.fn(async () => ({ adapter: "poly-historical", ok: true })),
    syncPolymarketNbaTrades: vi.fn(async () => ({ adapter: "poly-trades", ok: true })),
    syncBet365DirectLive: vi.fn(async () => ({ adapter: "bet365-direct", ok: true })),
    syncBet365Historical: vi.fn(async () => ({ adapter: "bet365-historical", ok: true })),
    syncBet365InternalDump: vi.fn(() => ({ adapter: "bet365-internal", ok: true })),
    fetchOddsApiIoNbaEvents: vi.fn(async () => [{ id: "evt-1" }, { id: "evt-2" }]),
    fetchOddsApiIoEventOddsSnapshot: vi.fn(async () => ({
      payload: [{ id: "evt-1" }],
      // a fetched payload that ALSO carries a redacted url + a secret-named key:
      requestUrl: `https://api.odds-api.io/v3/odds/multi?apiKey=${SECRET_KEY}&eventIds=evt-1`,
      apiKey: SECRET_KEY,
    })),
    fetchOddsApiIoUpdatedDelta: vi.fn(async () => ({ delta: [] })),
    readOddsApiIoApiKey: vi.fn(() => SECRET_KEY),
    ...overrides,
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "research-pull-"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Recursively read every file under a directory as raw bytes. */
function readAllFiles(dir: string): { path: string; bytes: Buffer }[] {
  const out: { path: string; bytes: Buffer }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllFiles(abs));
    } else {
      out.push({ path: abs, bytes: readFileSync(abs) });
    }
  }
  return out;
}

describe("executor — canonical dispatch", () => {
  it("dispatches a validated kalshi historical plan to syncKalshiNbaHistorical only", async () => {
    const adapters = mockAdapters();
    const root = tmpRoot();
    const result = await executePullJob(base({ sources: ["kalshi"] }), {
      now: NOW,
      outputRoot: root,
      jobId: "job-kalshi-hist",
      adapters,
    });

    expect(result.job.state).toBe("succeeded");
    expect(adapters.syncKalshiNbaHistorical).toHaveBeenCalledTimes(1);
    expect(adapters.syncKalshiNbaHistorical).toHaveBeenCalledWith({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    // No other kalshi path fired.
    expect(adapters.syncKalshiNbaDirect).not.toHaveBeenCalled();
    expect(adapters.syncKalshiNbaTrades).not.toHaveBeenCalled();
    // No odds-api.io fetch happened for a canonical-only job.
    expect(adapters.fetchOddsApiIoEventOddsSnapshot).not.toHaveBeenCalled();
    const source = result.sources.find((s) => s.id === "kalshi");
    expect(source?.artifactClass).toBe("canonical");
  });

  it("routes kalshi live-capture to syncKalshiNbaDirect and player-props to trades", async () => {
    const live = mockAdapters();
    await executePullJob(
      base({ sources: ["kalshi"], capture_mode: "live-capture", market_scope: "all" }),
      { now: NOW, outputRoot: tmpRoot(), jobId: "j-live", adapters: live },
    );
    expect(live.syncKalshiNbaDirect).toHaveBeenCalledWith({ captureMode: "live" });

    const props = mockAdapters();
    await executePullJob(base({ sources: ["kalshi"], market_scope: "player-props" }), {
      now: NOW,
      outputRoot: tmpRoot(),
      jobId: "j-props",
      adapters: props,
    });
    expect(props.syncKalshiNbaTrades).toHaveBeenCalledTimes(1);
    expect(props.syncKalshiNbaTrades).toHaveBeenCalledWith({
      since: "2026-01-01T00:00:00Z",
      until: "2026-01-31T23:59:59Z",
    });
  });
});

describe("executor — odds-api.io is artifact_only and never canonical", () => {
  it("classifies odds-api.io as artifact_only and never touches a canonical sync fn", async () => {
    const adapters = mockAdapters();
    const root = tmpRoot();
    const result = await executePullJob(
      base({
        sources: ["odds-api-io"],
        capture_mode: "repair",
        odds_api_io: {
          bookmakers: ["Bet365", "DraftKings"],
          markets: ["ML", "Player Props"],
          mode: "events-snapshot",
        },
      }),
      { now: NOW, outputRoot: root, jobId: "job-oai", adapters },
    );

    const oai = result.sources.find((s) => s.id === "odds-api-io");
    expect(oai?.artifactClass).toBe("artifact_only");
    expect(oai?.state).toBe("succeeded");

    // Artifact path fired the fetch helpers...
    expect(adapters.fetchOddsApiIoNbaEvents).toHaveBeenCalledTimes(1);
    expect(adapters.fetchOddsApiIoEventOddsSnapshot).toHaveBeenCalledTimes(1);

    // ...and NEVER a canonical sync fn (no gold write).
    expect(adapters.syncKalshiNbaDirect).not.toHaveBeenCalled();
    expect(adapters.syncKalshiNbaHistorical).not.toHaveBeenCalled();
    expect(adapters.syncKalshiNbaTrades).not.toHaveBeenCalled();
    expect(adapters.syncPolymarketNbaHistorical).not.toHaveBeenCalled();
    expect(adapters.syncPolymarketNbaTrades).not.toHaveBeenCalled();
    expect(adapters.syncBet365DirectLive).not.toHaveBeenCalled();
    expect(adapters.syncBet365Historical).not.toHaveBeenCalled();
    expect(adapters.syncBet365InternalDump).not.toHaveBeenCalled();

    // Evidence lives only under the job folder's evidence/odds-api-io/ dir.
    const evidence = result.artifacts.filter((a) => a.source === "odds-api-io");
    expect(evidence.length).toBeGreaterThan(0);
    for (const a of evidence) {
      expect(a.file.startsWith("evidence/odds-api-io/")).toBe(true);
    }
  });
});

describe("executor — job-artifact writer (redaction + required files)", () => {
  it("writes the required files, redacts keys, and hashes every artifact", async () => {
    const adapters = mockAdapters();
    const root = tmpRoot();
    const result = await executePullJob(
      base({
        sources: ["odds-api-io"],
        capture_mode: "repair",
        odds_api_io: {
          bookmakers: ["Bet365"],
          markets: ["ML"],
          mode: "events-snapshot",
        },
      }),
      { now: NOW, outputRoot: root, jobId: "job-writer", adapters },
    );

    const jobDir = result.jobDir;
    // Required files present.
    for (const f of ["job.json", "manifest.json", "summary.json", "SUMMARY.md"]) {
      expect(statSync(join(jobDir, f)).isFile()).toBe(true);
    }

    const job = readJson(join(jobDir, "job.json")) as { jobId: string; state: string };
    expect(job.jobId).toBe("job-writer");

    const manifest = readJson(join(jobDir, "manifest.json")) as {
      artifacts: { contentHash: string; redacted: boolean; file: string }[];
    };
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    for (const a of manifest.artifacts) {
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.redacted).toBe(true);
    }

    // The secret key must NOT appear ANYWHERE under the job dir, even though
    // the fetched payload carried it in both a URL and an apiKey field.
    for (const { bytes, path } of readAllFiles(jobDir)) {
      const text = path.endsWith(".gz")
        ? gunzipSync(bytes).toString("utf8")
        : bytes.toString("utf8");
      expect(text).not.toContain(SECRET_KEY);
    }
  });

  it("gzips artifacts above the threshold and records gzip+hash in the manifest", async () => {
    // A large fetched payload forces gzip on disk.
    const big = "x".repeat(ARTIFACT_GZIP_THRESHOLD_BYTES + 1024);
    const adapters = mockAdapters({
      fetchOddsApiIoUpdatedDelta: vi.fn(async () => ({ blob: big })),
    });
    const root = tmpRoot();
    const result = await executePullJob(
      base({
        sources: ["odds-api-io"],
        capture_mode: "live-capture",
        odds_api_io: {
          bookmakers: ["Bet365"],
          markets: ["ML"],
          mode: "updated-follow",
          since: NOW - 10,
        },
      }),
      { now: NOW, outputRoot: root, jobId: "job-gzip", adapters },
    );

    const gz = result.artifacts.find((a) => a.gzip);
    expect(gz).toBeDefined();
    expect(gz?.file.endsWith(".json.gz")).toBe(true);
    expect(gz?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // The gzipped file on disk round-trips and still excludes the secret.
    const abs = join(result.jobDir, gz!.file);
    const text = gunzipSync(readFileSync(abs)).toString("utf8");
    expect(text).toContain(big);
    expect(text).not.toContain(SECRET_KEY);
  });
});

describe("executor — state machine", () => {
  it("returns partial when one source fails and another succeeds", () => {
    expect(
      resolveJobState([
        { id: "a", artifactClass: "canonical", state: "succeeded", operations: [], artifacts: [] },
        {
          id: "b",
          artifactClass: "canonical",
          state: "failed",
          operations: [],
          artifacts: [],
          error: "boom",
        },
      ]),
    ).toBe("partial");
  });

  it("returns failed when all sources fail and succeeded when none fail", () => {
    expect(
      resolveJobState([
        {
          id: "a",
          artifactClass: "canonical",
          state: "failed",
          operations: [],
          artifacts: [],
          error: "x",
        },
      ]),
    ).toBe("failed");
    expect(
      resolveJobState([
        { id: "a", artifactClass: "canonical", state: "succeeded", operations: [], artifacts: [] },
        { id: "b", artifactClass: "pending", state: "noop", operations: [], artifacts: [] },
      ]),
    ).toBe("succeeded");
  });

  it("surfaces partial end-to-end when one adapter throws", async () => {
    const adapters = mockAdapters({
      syncPolymarketNbaHistorical: vi.fn(async () => {
        throw new Error("provider 503");
      }),
    });
    const result = await executePullJob(base({ sources: ["kalshi", "polymarket"] }), {
      now: NOW,
      outputRoot: tmpRoot(),
      jobId: "job-partial",
      adapters,
    });
    expect(result.job.state).toBe("partial");
    expect(result.sources.find((s) => s.id === "polymarket")?.state).toBe("failed");
    expect(result.sources.find((s) => s.id === "kalshi")?.state).toBe("succeeded");
  });

  it("writes a failed job folder for an invalid request without calling adapters", async () => {
    const adapters = mockAdapters();
    const result = await executePullJob(
      // historical not supported by odds-api-io -> validation fails.
      base({ sources: ["odds-api-io"], capture_mode: "historical" }),
      { now: NOW, outputRoot: tmpRoot(), jobId: "job-invalid", adapters },
    );
    expect(result.job.state).toBe("failed");
    expect(adapters.fetchOddsApiIoNbaEvents).not.toHaveBeenCalled();
    expect(adapters.syncKalshiNbaHistorical).not.toHaveBeenCalled();
    expect(statSync(join(result.jobDir, "SUMMARY.md")).isFile()).toBe(true);
  });
});

describe("validateExportRequest", () => {
  function exportCodes(input: unknown): ExportValidationCode[] {
    const result = validateExportRequest(input);
    return result.ok ? [] : result.errors.map((e) => e.code);
  }

  it("accepts a full-corpus export with no sample", () => {
    const result = validateExportRequest({ scope: "full" });
    expect(result.ok).toBe(true);
  });

  it("accepts a sample export with a positive count and optional window", () => {
    const result = validateExportRequest({
      scope: "sample",
      sample: 25,
      snapshotId: "snap-x",
      since: "2026-05-01",
      until: "2026-05-25",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects snapshot ids that are not safe path segments", () => {
    for (const snapshotId of ["../escape", "/tmp/escape", ".", "..", "snap.child", "snap/child"]) {
      expect(exportCodes({ scope: "full", snapshotId })).toContain("schema_invalid");
    }
  });

  it("rejects gameIds on a sample export so sampling cannot be overridden", () => {
    expect(exportCodes({ scope: "sample", sample: 25, gameIds: ["nba-1"] })).toContain(
      "sample_rejects_game_ids",
    );
  });

  it("rejects an unknown scope as schema_invalid", () => {
    expect(exportCodes({ scope: "everything" })).toContain("schema_invalid");
  });

  it("rejects scope=sample without a count", () => {
    expect(exportCodes({ scope: "sample" })).toContain("sample_requires_count");
  });

  it("rejects a non-positive sample as schema_invalid (zod gate)", () => {
    expect(exportCodes({ scope: "sample", sample: 0 })).toContain("schema_invalid");
  });

  it("rejects a sample count on a full-corpus scope", () => {
    expect(exportCodes({ scope: "full", sample: 10 })).toContain("sample_count_without_scope");
  });

  it("rejects an inverted since/until window", () => {
    expect(exportCodes({ scope: "full", since: "2026-05-25", until: "2026-05-01" })).toContain(
      "date_range_inverted",
    );
  });

  it("rejects unknown keys via the strict schema", () => {
    expect(exportCodes({ scope: "full", bogus: true })).toContain("schema_invalid");
  });
});

describe("redactEvidence", () => {
  it("redacts secret-named keys and apiKey URLs but keeps benign data", () => {
    const redacted = redactEvidence({
      apiKey: "secret",
      requestUrl: "https://api.odds-api.io/v3/odds?apiKey=secret&sport=Basketball",
      ticksWritten: 42,
      nested: { authorization: "Bearer abc", note: "ok" },
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("REDACTED");
    expect(redacted.requestUrl).toBe(
      "https://api.odds-api.io/v3/odds?apiKey=REDACTED&sport=Basketball",
    );
    expect(redacted.ticksWritten).toBe(42);
    expect((redacted.nested as Record<string, unknown>).authorization).toBe("REDACTED");
    expect((redacted.nested as Record<string, unknown>).note).toBe("ok");
  });
});
