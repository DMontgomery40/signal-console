// ResearchPage tests.
//
// The page is gold-DB-first: a 31GB golden SQLite DB already holds the canonical
// sources, so Export (the PRIMARY yellow CTA) reads it directly and is enabled
// whenever the gold DB is present — NOT gated on an existing snapshot. Pull is
// demoted to a secondary "Add/repair source data" action for sources not in the
// gold DB or new date windows.
//
// The page reads the read-only /v1/research/* API via queries.ts hooks
// (useResearchGold / Sources / Snapshot / Leaderboard / Models / Pulls) and
// writes via POST /v1/research/export ({ jobId }) and POST /v1/research/pull
// ({ job_id }). The fetch mock routes by URL prefix across all of them. Coverage:
//   - gold status renders (path, humanized size, game count) when present, and
//     an honest "Gold DB not found" line with NO fabricated numbers when absent.
//   - empty state: gold present + no snapshot -> Export ENABLED, honest
//     export-first prompt (NOT "no artifacts"), "not live" leaderboard framing.
//   - mocked artifacts: source matrix, pull job, snapshot + doctor summary,
//     models, leaderboard all render.
//   - dry-run validation enforces the odds-api.io rules (one-bookmaker,
//     league ⊕ eventIds under live-ws, ≤60s since) using deterministic time.
//   - copy separates canonical vs artifact-only in the dry-run preview.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ResearchPage } from "../ResearchPage";
import { explainers } from "@signal-console/ui";

function makeWrapper(): (props: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type FetchFn = typeof fetch;
function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// The repo's vitest setup does not register jest-dom, so assert disabled state
// on the native element rather than via a custom matcher.
function isDisabled(el: HTMLElement): boolean {
  return el instanceof HTMLButtonElement ? el.disabled : el.hasAttribute("disabled");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Gold-DB status fixtures. The default is a present 31GB-scale gold DB with the
// canonical 1256-game corpus; the absent variant returns present:false with
// zeroed numerics and gameCount:null (the route NEVER throws on a missing DB).
const GOLD_RESPONSE = {
  present: true,
  path: "/data/signal-console.sqlite",
  sizeBytes: 33_285_996_544, // ≈31 GB
  lastModified: "2026-05-28T22:10:00Z",
  gameCount: 1256,
};
const GOLD_ABSENT_RESPONSE = {
  present: false,
  path: "/data/signal-console.sqlite",
  sizeBytes: 0,
  lastModified: "",
  gameCount: null,
};

// The capability matrix is shipped by the API from the shared package; this
// fixture is the live shape (snapshot-eligible / artifact-only / pending).
const SOURCES_RESPONSE = {
  sources: [
    {
      id: "kalshi",
      class: "snapshot-eligible",
      supportedModes: ["historical", "repair", "live-capture"],
      limitations: ["Direct Kalshi API is the authoritative Kalshi player-prop path."],
    },
    {
      id: "odds-api-io",
      class: "artifact-only",
      supportedModes: ["repair", "live-capture"],
      limitations: ["Not a historical warehouse: no historical capture mode."],
    },
    {
      id: "draftkings-direct",
      class: "pending",
      supportedModes: [],
      limitations: ["Reachable only via Odds-API.io today; no persisted direct adapter."],
    },
  ],
};

const MODELS_RESPONSE = {
  models: [
    {
      id: "robust_mad",
      label: "Robust MAD",
      description: "Robust median-absolute-deviation residual detector.",
      source: "static",
    },
  ],
};

const EMPTY_SNAPSHOT = { snapshot: null };
const EMPTY_LEADERBOARD = { runId: null, rows: [] };
const EMPTY_PULLS = { pulls: [] };

// Mirrors the REAL export-quant-snapshot manifest shape (nested counts /
// dateRange / sourceCoverageSummary / files), so the test proves the page
// reads actual artifacts, not a fixture-only flat shape.
const SNAPSHOT_RESPONSE = {
  snapshot: {
    snapshotId: "snap-2026-05-20",
    dateRange: { observedStart: "2026-05-01T00:00:00Z", observedEnd: "2026-05-20T00:00:00Z" },
    counts: { games: 42, incidents: 7, scoreWindows: 5, sourceCoverage: 278 },
    sourceCoverageSummary: { canonical: 278 },
    files: ["manifest.json", "games.parquet", "incidents.parquet"],
    doctor_summary: "All sources fresh; 0 gaps detected in the window.",
  },
};

// Mirrors the REAL leaderboard.json row shape (snake_case, recall fractions).
const LEADERBOARD_RESPONSE = {
  runId: "run-2026-05-20T09:00:00Z",
  rows: [
    {
      model: "robust_mad",
      incident_recall: 0.6,
      incidents_caught: 3,
      incidents_total: 5,
      fires_per_game: 18.4,
      tape_outlier_recall: 0.5758,
      burden: 311,
      residual_coverage: 0.81,
    },
  ],
};

const PULLS_RESPONSE = {
  pulls: [
    {
      jobId: "pull-abc123",
      state: "succeeded",
      sources: ["kalshi", "odds-api-io"],
      createdAt: "2026-05-20T08:55:00Z",
    },
  ],
};

const EMPTY_ATTRIBUTION = { attribution: null };
const SEEDED_ATTRIBUTION = {
  attribution: {
    overall: { n: 15, n_scored: 9, abstention_rate: 0.4, median_score: 0 },
    player_swap: { n: 8, n_scored: 6, abstention_rate: 0.25, median_score: 0.022 },
    team_dispute: { n: 7, n_scored: 3, abstention_rate: 0.57, median_score: -0.015 },
    line_select: "aggregate_drift",
    n_incidents: 15,
  },
};

const EMPTY_FAR = { farCalibration: null };
const SEEDED_FAR = {
  farCalibration: {
    n_control_games: 163,
    all_control: {
      per_pair_far: { "0.02": 0.0567, "0.05": 0.0356 },
      per_rebound_far: { "0.02": 0.111, "0.05": 0.0737 },
    },
    matched_recall: { n_incidents: 9, n_scored: 2, tpr_per_pair: { "0.02": 0.5, "0.05": 0 } },
    data_quality: { games_bad_starters: 0, rebounds_oncourt_ne5_frac: 0.0115 },
  },
};

const EMPTY_CONFLUENCE = { confluenceEval: null };
const SEEDED_CONFLUENCE = {
  confluenceEval: {
    generatedAt: "2026-06-01T08:00:00.000Z",
    gate_verdict: "VIABLE",
    meets_bar: false,
    gate: { verdict: "VIABLE", n_evaluated: 14, successes: 13, secondary_rank_auc: 0.972 },
    operating_point: {
      meets_bar: false,
      fp_ratio_at_target_recall: 17.417,
      max_recall_point: { caught: 14, threshold: -1.0, fp_ratio: 129.214 },
      baseline_comparison: [
        { baseline: "expanding", fp_ratio_at_target_recall: 17.417, recall_ceiling: 14 },
        { baseline: "rolling-60", fp_ratio_at_target_recall: 137.643, recall_ceiling: 14 },
      ],
    },
  },
};

const EMPTY_HARVESTED = { harvestedLabels: null };
const SEEDED_HARVESTED = {
  harvestedLabels: {
    generatedAt: "2026-05-31T00:00:00.000Z",
    source: "pbp-revision-harvester",
    gamesScanned: 12,
    incidentCount: 1,
    incidents: [
      {
        id: "harvested-nba-x-416",
        gameId: "nba-x",
        creditedPlayer: "S. Merrill",
        rightfulPlayer: "J. Allen",
        stat: "rebound",
        correctionLatencySec: 840,
      },
    ],
  },
};

interface MockShape {
  readonly gold?: unknown;
  readonly sources?: unknown;
  readonly snapshot?: unknown;
  readonly leaderboard?: unknown;
  readonly models?: unknown;
  readonly pulls?: unknown;
  readonly attribution?: unknown;
  readonly farCalibration?: unknown;
  readonly confluenceEval?: unknown;
  readonly harvestedLabels?: unknown;
}

describe("ResearchPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mockResearch(shape: MockShape = {}): void {
    const gold = shape.gold ?? GOLD_RESPONSE;
    const sources = shape.sources ?? SOURCES_RESPONSE;
    const snapshot = shape.snapshot ?? EMPTY_SNAPSHOT;
    const leaderboard = shape.leaderboard ?? EMPTY_LEADERBOARD;
    const models = shape.models ?? MODELS_RESPONSE;
    const pulls = shape.pulls ?? EMPTY_PULLS;
    const attribution = shape.attribution ?? EMPTY_ATTRIBUTION;
    const farCalibration = shape.farCalibration ?? EMPTY_FAR;
    const confluenceEval = shape.confluenceEval ?? EMPTY_CONFLUENCE;
    const harvestedLabels = shape.harvestedLabels ?? EMPTY_HARVESTED;
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      // Export ({ jobId }) is checked before pull because both contain
      // "/v1/research/" and the URLs are distinct.
      if (method === "POST" && url.includes("/v1/research/export")) {
        return jsonResponse({ jobId: "export-new-1" }, { status: 202 });
      }
      if (method === "POST" && url.includes("/v1/research/pull")) {
        return jsonResponse({ job_id: "pull-new-1" }, { status: 202 });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(gold);
      if (url.includes("/v1/research/sources")) return jsonResponse(sources);
      if (url.includes("/v1/research/snapshot/latest")) return jsonResponse(snapshot);
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(leaderboard);
      if (url.includes("/v1/research/models")) return jsonResponse(models);
      if (url.includes("/v1/research/pulls")) return jsonResponse(pulls);
      if (url.includes("/v1/research/far-calibration")) return jsonResponse(farCalibration);
      if (url.includes("/v1/research/confluence-eval")) return jsonResponse(confluenceEval);
      if (url.includes("/v1/research/harvested-labels")) return jsonResponse(harvestedLabels);
      if (url.includes("/v1/research/attribution")) return jsonResponse(attribution);
      return new Response("not found", { status: 404 });
    });
  }

  it("gold present + no snapshot: Export enabled, honest export-first prompt, NO fabricated numbers", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    // Gold IS present, so there is NO "no artifacts" warning; instead the honest
    // export-first prompt that never implies we have no data.
    const prompt = await screen.findByTestId("research-empty-prompt");
    expect(prompt.textContent).toBe(
      "Golden DB ready. Export a reproducible snapshot to start modeling.",
    );
    expect(screen.queryByTestId("research-no-artifacts")).toBeNull();

    // Export is the PRIMARY CTA, ENABLED whenever the gold DB is present (NOT
    // gated on a snapshot). Pull stays enabled (now "Add/repair source data").
    // Open report disabled until a leaderboard/report exists.
    expect(isDisabled(screen.getByTestId("research-cta-export"))).toBe(false);
    expect(isDisabled(screen.getByTestId("research-cta-pull"))).toBe(false);
    expect(screen.getByTestId("research-cta-pull").textContent).toContain("Add/repair source data");
    expect(isDisabled(screen.getByTestId("research-cta-report"))).toBe(true);

    // Header reads "none", never a fabricated 0.
    expect(screen.getByTestId("research-latest-snapshot-id").textContent).toBe("none");

    // Empty tables show honest one-liners (export-first, never pull-blocked).
    expect(screen.getByTestId("research-pull-jobs-empty").textContent).toContain(
      "No add/repair jobs yet",
    );
    expect(screen.getByTestId("research-snapshot-empty").textContent).toContain("no pull needed");
    expect(screen.getByTestId("research-leaderboard-empty")).not.toBeNull();
    expect(screen.queryByTestId("research-leaderboard-row")).toBeNull();
    expect(screen.queryByTestId("research-pull-job-row")).toBeNull();
    expect(screen.getByTestId("research-attribution-empty")).not.toBeNull();
    expect(screen.queryByTestId("research-attribution-row")).toBeNull();

    // Model lab shows the export-first empty state, not a pull prompt.
    expect(screen.getByTestId("research-model-lab-empty").textContent).toContain("no pull needed");

    // No fabricated fires/game number anywhere in the empty page.
    expect(screen.queryByText(/fires\/game/i)).toBeNull();
  });

  it("renders the attribution re-ranker section stratified (overall/player_swap/team_dispute)", async () => {
    mockResearch({ attribution: SEEDED_ATTRIBUTION });
    render(<ResearchPage />, { wrapper: makeWrapper() });

    expect(await screen.findByTestId("research-attribution")).not.toBeNull();
    const rows = await screen.findAllByTestId("research-attribution-row");
    expect(rows.map((r) => r.getAttribute("data-stratum"))).toEqual([
      "overall",
      "player_swap",
      "team_dispute",
    ]);
    // the line-select footnote surfaces the chosen strategy; not the live signal
    expect(screen.getByTestId("research-attribution-meta").textContent).toContain(
      "aggregate_drift",
    );
    // The verbose description now lives in the dotted-underline hover explainer, not
    // an inline paragraph (de-crowding). Verify the content moved there, not vanished.
    expect(explainers["research-attribution"].eli5).toContain("not the live suspend signal");
  });

  it("renders the FAR calibration section (per-pair/per-rebound FAR + matched recall) with honest N", async () => {
    mockResearch({ farCalibration: SEEDED_FAR });
    render(<ResearchPage />, { wrapper: makeWrapper() });

    expect(await screen.findByTestId("research-far-calibration")).not.toBeNull();
    const rows = await screen.findAllByTestId("research-far-calibration-row");
    // one row per threshold (0.01, 0.02, 0.05, 0.1, 0.2)
    expect(rows.map((r) => r.getAttribute("data-threshold"))).toEqual([
      "0.01",
      "0.02",
      "0.05",
      "0.1",
      "0.2",
    ]);
    const meta = screen.getByTestId("research-far-calibration-meta").textContent;
    expect(meta).toContain("control games 163");
    // matched recall is surfaced WITH its N (2 of 9), never as a bare point estimate
    expect(meta).toContain("matched recall n 2 / 9");
    // "label-starved" caveat now lives in the hover explainer (de-crowded heading).
    expect(explainers["research-far"].eli5).toContain("label-starved");
  });

  it("FAR calibration shows the empty state when no report is present", async () => {
    mockResearch({ farCalibration: EMPTY_FAR });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("research-far-calibration-empty")).not.toBeNull();
    expect(screen.queryByTestId("research-far-calibration-row")).toBeNull();
  });

  it("renders the confluence eval showing a PASSING gate with a FAILING bar (honest split)", async () => {
    mockResearch({ confluenceEval: SEEDED_CONFLUENCE });
    render(<ResearchPage />, { wrapper: makeWrapper() });

    // The whole point: gate VIABLE but bar FAIL must both be visible, never collapsed
    // into a single green "viable" verdict. Await the gate (query is async).
    const gate = await screen.findByTestId("research-confluence-eval-gate");
    expect(gate.getAttribute("data-verdict")).toBe("VIABLE");
    const bar = screen.getByTestId("research-confluence-eval-bar");
    expect(bar.getAttribute("data-meets-bar")).toBe("false");
    expect(bar.textContent).toContain("FAIL");
    expect(bar.textContent).toContain("17.4:1");
    // one row per baseline compared
    const rows = await screen.findAllByTestId("research-confluence-eval-row");
    expect(rows.map((r) => r.getAttribute("data-baseline"))).toEqual(["expanding", "rolling-60"]);
    // the lower-bound caveat is stated in the hover explainer, not hidden
    expect(explainers["research-confluence"].eli5).toContain("LOWER BOUND");
  });

  it("confluence eval shows the empty state when no report is present", async () => {
    mockResearch({ confluenceEval: EMPTY_CONFLUENCE });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("research-confluence-eval-empty")).not.toBeNull();
    expect(screen.queryByTestId("research-confluence-eval-row")).toBeNull();
  });

  it("renders harvested miscredit labels (credited→rightful + latency) when present", async () => {
    mockResearch({ harvestedLabels: SEEDED_HARVESTED });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("research-harvested-labels")).not.toBeNull();
    const rows = await screen.findAllByTestId("research-harvested-labels-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("S. Merrill");
    expect(rows[0]?.textContent).toContain("J. Allen");
    expect(rows[0]?.textContent).toContain("14m"); // 840s latency rendered in minutes
    expect(screen.getByTestId("research-harvested-labels-meta").textContent).toContain("labels 1");
  });

  it("harvested labels shows the accruing-empty state when no corrections recovered", async () => {
    mockResearch({ harvestedLabels: EMPTY_HARVESTED });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("research-harvested-labels-empty")).not.toBeNull();
    expect(screen.queryByTestId("research-harvested-labels-row")).toBeNull();
  });

  it("renders the quant-guide panel with an honest Open link and a Copy CLI quickstart action", async () => {
    mockResearch();
    // jsdom has no clipboard; stub navigator with a writeText spy. The file's
    // afterEach unstubs all globals, so this does not leak into other tests.
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<ResearchPage />, { wrapper: makeWrapper() });

    const panel = await screen.findByTestId("research-quant-guide");
    expect(panel.textContent).toContain("devs, traders, ops, and researchers");

    // "Open Quant Guide" opens the API-served guide (GET /v1/research/guide),
    // NOT a static docs path that would fall through to the SPA shell. The
    // source file path is shown alongside so the link stays honest.
    const open = screen.getByTestId("research-quant-guide-open");
    expect(open.getAttribute("href")).toBe("/v1/research/guide");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
    expect(panel.textContent).toContain("docs/quant-researcher-guide.md");

    // Copy writes a RUNNABLE multi-line quickstart: compare requires --snapshot,
    // so the quickstart must resolve a snapshot id and pass the flag.
    fireEvent.click(screen.getByTestId("research-quant-guide-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("pnpm quant:export");
    expect(copied).toContain("pnpm quant compare robust_mad state_space_current");
    expect(copied).toContain("--snapshot");
    expect(copied).not.toContain("<snapshot>");
    // SNAP must resolve to a real snapshot PATH (the snapshots dir + id), not a bare
    // dir name — `ls` alone yields just the id and --snapshot would point at nothing.
    expect(copied).toContain(
      'SNAP="outputs/nba-quant-lab/snapshots/$(ls -t outputs/nba-quant-lab/snapshots',
    );
  });

  it("renders the gold dataset status: ready dot, path, humanized size, game count", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    await screen.findByTestId("research-gold-ready");
    const status = screen.getByTestId("research-gold-status");
    expect(status.textContent).toContain("Golden DB ready");
    expect(screen.getByTestId("research-gold-path").textContent).toBe(
      "/data/signal-console.sqlite",
    );
    // 33_285_996_544 bytes ≈ 31.0 GB.
    expect(screen.getByTestId("research-gold-size").textContent).toBe("31.0 GB");
    expect(screen.getByTestId("research-gold-game-count").textContent).toBe("1,256");
  });

  it("gold absent: honest 'not found' line with NO fabricated numbers and Export disabled", async () => {
    mockResearch({ gold: GOLD_ABSENT_RESPONSE });
    render(<ResearchPage />, { wrapper: makeWrapper() });

    // The gold-DB-absent path: honest message, no ready dot, no fabricated size.
    const absent = await screen.findByTestId("research-gold-absent");
    expect(absent.textContent).toBe("Gold DB not found at /data/signal-console.sqlite");
    expect(screen.queryByTestId("research-gold-ready")).toBeNull();
    expect(screen.queryByTestId("research-gold-size")).toBeNull();

    // With no gold DB AND no snapshot, the "no artifacts" framing returns, and
    // Export is disabled (nothing to read).
    expect(screen.getByTestId("research-no-artifacts").textContent).toContain(
      "No research artifacts yet",
    );
    expect(isDisabled(screen.getByTestId("research-cta-export"))).toBe(true);
  });

  it("keeps the honest 'not live' framing on the leaderboard even when empty", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    const disclaimer = await screen.findByTestId("research-leaderboard-disclaimer");
    expect(disclaimer.textContent).toBe("Research snapshot result, not live production behavior.");
  });

  it("renders the source coverage matrix with dot+label readiness and the Odds-API.io note", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("research-source-row")).toHaveLength(3);
    });
    const rows = screen.getAllByTestId("research-source-row");
    const byId = (id: string): HTMLElement => {
      const row = rows.find((r) => r.getAttribute("data-source-id") === id);
      if (row === undefined) throw new Error(`no source row ${id}`);
      return row;
    };
    // Gold-first readiness wording: canonical sources are already in the gold DB,
    // artifact-only land via optional pulls, pending sources require a pull to add.
    expect(byId("kalshi").textContent).toContain("canonical · in gold DB");
    expect(byId("odds-api-io").textContent).toContain("artifact-only");
    expect(byId("draftkings-direct").textContent).toContain("pull to add");

    // Odds-API.io row carries the warehouse-disclaimer copy verbatim.
    expect(screen.getByTestId("research-odds-api-io-note").textContent).toBe(
      "event snapshot/live artifact lane — not a historical warehouse",
    );
  });

  it("renders mocked artifacts: pull job, snapshot + doctor summary, models, leaderboard", async () => {
    mockResearch({
      snapshot: SNAPSHOT_RESPONSE,
      leaderboard: LEADERBOARD_RESPONSE,
      pulls: PULLS_RESPONSE,
    });
    render(<ResearchPage />, { wrapper: makeWrapper() });

    // Header reflects the real snapshot id + pull status, no fabrication.
    await waitFor(() => {
      expect(screen.getByTestId("research-latest-snapshot-id").textContent).toBe("snap-2026-05-20");
    });
    expect(screen.getByTestId("research-latest-pull-status").textContent).toContain("succeeded");
    expect(screen.queryByTestId("research-no-artifacts")).toBeNull();

    // Pull job row.
    const jobRow = await screen.findByTestId("research-pull-job-row");
    expect(jobRow.getAttribute("data-job-id")).toBe("pull-abc123");
    expect(jobRow.textContent).toContain("succeeded");

    // Snapshot block reads the real nested manifest: id, counts, coverage,
    // doctor summary.
    expect(screen.getByTestId("research-snapshot-id").textContent).toBe("snap-2026-05-20");
    expect(screen.getByTestId("research-snapshot-coverage").textContent).toContain("canonical=278");
    expect(screen.getByTestId("research-snapshot-doctor").textContent).toContain(
      "All sources fresh",
    );

    // Models.
    const modelRow = await screen.findByTestId("research-model-row");
    expect(modelRow.getAttribute("data-model-id")).toBe("robust_mad");

    // Leaderboard row with mono tabular metrics.
    const lbRow = await screen.findByTestId("research-leaderboard-row");
    expect(lbRow.getAttribute("data-model-id")).toBe("robust_mad");
    expect(lbRow.textContent).toContain("60.0%"); // incident recall
    expect(lbRow.textContent).toContain("3 / 5"); // caught / scoreable
    expect(lbRow.textContent).toContain("18.4"); // fires/game

    // Export enabled (gold present); Open report enabled once a report exists.
    expect(isDisabled(screen.getByTestId("research-cta-export"))).toBe(false);
    expect(isDisabled(screen.getByTestId("research-cta-report"))).toBe(false);
  });

  it("wires the recall@fires/game explainer to the Incident recall column, not fires-per-game", async () => {
    mockResearch({ leaderboard: LEADERBOARD_RESPONSE });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("research-leaderboard-row");

    // ExplainerCard marks its trigger with data-explainer-id. The "Incident
    // recall" header must carry the recall-at-fire-budget explainer.
    const recallTrigger = screen.getByText("Incident recall").closest("[data-explainer-id]");
    expect(recallTrigger?.getAttribute("data-explainer-id")).toBe("recall-fires-per-game");

    // Tape-outlier and residual coverage keep their dedicated explainers.
    expect(
      screen
        .getByText("Tape-outlier")
        .closest("[data-explainer-id]")
        ?.getAttribute("data-explainer-id"),
    ).toBe("tape-outlier");
    expect(
      screen
        .getByText("Residual cov.")
        .closest("[data-explainer-id]")
        ?.getAttribute("data-explainer-id"),
    ).toBe("residual-coverage");
  });

  it("Export is gold-gated (enabled with gold present even without a snapshot); Open report stays report-gated", async () => {
    // Gold is present (default mock) but there is no snapshot and no leaderboard.
    // Export must be ENABLED (it reads the gold DB directly); Open report must be
    // DISABLED until a report exists.
    mockResearch({ pulls: PULLS_RESPONSE });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("research-pull-job-row");
    expect(screen.queryByTestId("research-no-artifacts")).toBeNull();
    expect(isDisabled(screen.getByTestId("research-cta-export"))).toBe(false);
    expect(isDisabled(screen.getByTestId("research-cta-report"))).toBe(true);
  });

  it("opens the Export dialog, POSTs /v1/research/export, and shows the returned jobId + CLI", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    // Wait for gold so the CTA is enabled, then open the export dialog.
    await screen.findByTestId("research-gold-ready");
    fireEvent.click(screen.getByTestId("research-cta-export"));
    const dialog = await screen.findByTestId("research-export-dialog");

    // Gold recap + the exact one-command CLI for CLI users.
    expect(within(dialog).getByTestId("research-export-cli").textContent).toBe("pnpm quant:export");

    // Full corpus is the default scope.
    expect(screen.getByTestId("research-export-scope-full").getAttribute("data-active")).toBe(
      "true",
    );
    expect(screen.getByTestId("research-export-snapshot-id").getAttribute("pattern")).toBe(
      "[A-Za-z0-9][A-Za-z0-9_-]*",
    );

    // Submit POSTs and surfaces the returned jobId.
    fireEvent.click(screen.getByTestId("research-export-submit"));
    const job = await screen.findByTestId("research-export-job");
    expect(job.textContent).toContain("export-new-1");
    expect(job.textContent).toContain("appears under Snapshot when done");

    const posted = fetchMock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? "GET").toUpperCase() === "POST" &&
        urlOf(c[0]).includes("/v1/research/export"),
    );
    expect(posted).toBeDefined();
    const rawBody = posted?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");
    expect(isRecord(body) ? body.scope : undefined).toBe("full");
  });

  it("builds the Export dialog CLI equivalent from the active form values", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    await screen.findByTestId("research-gold-ready");
    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");

    fireEvent.change(screen.getByTestId("research-export-snapshot-id"), {
      target: { value: "snap-x" },
    });
    fireEvent.change(screen.getByTestId("research-export-since"), {
      target: { value: "2026-05-01" },
    });
    fireEvent.change(screen.getByTestId("research-export-until"), {
      target: { value: "2026-05-25" },
    });
    fireEvent.change(screen.getByTestId("research-export-game-ids"), {
      target: { value: "nba-1, nba-2" },
    });

    expect(screen.getByTestId("research-export-cli").textContent).toBe(
      "pnpm quant:export --snapshot-id snap-x --since 2026-05-01 --until 2026-05-25 --games nba-1,nba-2",
    );

    fireEvent.click(screen.getByTestId("research-export-scope-sample"));
    fireEvent.change(screen.getByTestId("research-export-sample"), {
      target: { value: "25" },
    });
    expect(screen.getByTestId("research-export-cli").textContent).toBe(
      "pnpm quant:export --sample 25 --snapshot-id snap-x --since 2026-05-01 --until 2026-05-25",
    );
  });

  it("does not send gameIds from the Export dialog when sample scope is selected", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });

    await screen.findByTestId("research-gold-ready");
    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");

    fireEvent.change(screen.getByTestId("research-export-game-ids"), {
      target: { value: "nba-1,nba-2" },
    });
    fireEvent.click(screen.getByTestId("research-export-scope-sample"));
    expect(isDisabled(screen.getByTestId("research-export-game-ids"))).toBe(true);

    fireEvent.click(screen.getByTestId("research-export-submit"));
    await screen.findByTestId("research-export-job");

    const posted = fetchMock.mock.calls.find(
      (c) =>
        (c[1]?.method ?? "GET").toUpperCase() === "POST" &&
        urlOf(c[0]).includes("/v1/research/export"),
    );
    const rawBody = posted?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body: unknown = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");
    expect(isRecord(body) ? body.scope : undefined).toBe("sample");
    expect(isRecord(body) ? body.gameIds : undefined).toBeUndefined();
  });

  it("keeps polling after replacement exports until the latest snapshot changes", async () => {
    const oldSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-existing",
        generatedAt: "2026-05-20T09:00:00Z",
      },
    };
    const newSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-replacement",
        generatedAt: "2026-05-31T20:00:00Z",
      },
    };
    let exportPosted = false;
    let postExportSnapshotReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/research/export")) {
        exportPosted = true;
        return jsonResponse({ jobId: "export-new-1" }, { status: 202 });
      }
      if (method === "POST" && url.includes("/v1/research/pull")) {
        return jsonResponse({ job_id: "pull-new-1" }, { status: 202 });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) {
        if (exportPosted) postExportSnapshotReads += 1;
        return jsonResponse(
          exportPosted && postExportSnapshotReads >= 2 ? newSnapshot : oldSnapshot,
        );
      }
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      return new Response("not found", { status: 404 });
    });

    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect((await screen.findByTestId("research-snapshot-id")).textContent).toBe("snap-existing");

    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T20:00:00Z"));
    fireEvent.click(screen.getByTestId("research-export-submit"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-export-job").textContent).toContain("export-new-1");
    expect(screen.getByTestId("research-snapshot-id").textContent).toBe("snap-existing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-snapshot-id").textContent).toBe("snap-replacement");
  });

  it("does not treat the first snapshot response as completion when export starts before snapshot loads", async () => {
    let resolveInitialSnapshot: ((response: Response) => void) | undefined;
    const initialSnapshot = new Promise<Response>((resolve) => {
      resolveInitialSnapshot = resolve;
    });
    const oldSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-existing",
        generatedAt: "2026-05-20T09:00:00Z",
      },
    };
    const newSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-replacement",
        generatedAt: "2026-05-31T20:00:00Z",
      },
    };
    let snapshotReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/research/export")) {
        return jsonResponse({ jobId: "export-new-1" }, { status: 202 });
      }
      if (method === "POST" && url.includes("/v1/research/pull")) {
        return jsonResponse({ job_id: "pull-new-1" }, { status: 202 });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) {
        snapshotReads += 1;
        if (snapshotReads === 1) return await initialSnapshot;
        return jsonResponse(snapshotReads >= 3 ? newSnapshot : oldSnapshot);
      }
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      return new Response("not found", { status: 404 });
    });

    render(<ResearchPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("research-gold-ready");
    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T20:00:00Z"));
    fireEvent.click(screen.getByTestId("research-export-submit"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-export-job").textContent).toContain("export-new-1");

    await act(async () => {
      resolveInitialSnapshot?.(jsonResponse(oldSnapshot));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-snapshot-id").textContent).toBe("snap-replacement");
  });

  it("stops polling when the first unresolved snapshot already reflects a fast export", async () => {
    let resolveInitialSnapshot: ((response: Response) => void) | undefined;
    const initialSnapshot = new Promise<Response>((resolve) => {
      resolveInitialSnapshot = resolve;
    });
    const fastSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-fast",
        generatedAt: "2026-05-31T20:00:01Z",
      },
    };
    let snapshotReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/research/export")) {
        return jsonResponse({ jobId: "export-new-1" }, { status: 202 });
      }
      if (method === "POST" && url.includes("/v1/research/pull")) {
        return jsonResponse({ job_id: "pull-new-1" }, { status: 202 });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) {
        snapshotReads += 1;
        if (snapshotReads === 1) return await initialSnapshot;
        return jsonResponse(fastSnapshot);
      }
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      return new Response("not found", { status: 404 });
    });

    render(<ResearchPage />, { wrapper: makeWrapper() });
    await screen.findByTestId("research-gold-ready");
    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T20:00:00Z"));
    fireEvent.click(screen.getByTestId("research-export-submit"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-export-job").textContent).toContain("export-new-1");

    await act(async () => {
      resolveInitialSnapshot?.(jsonResponse(fastSnapshot));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-snapshot-id").textContent).toBe("snap-fast");

    const readsAfterCompletion = snapshotReads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(snapshotReads).toBe(readsAfterCompletion);
  });

  it("stops export polling and surfaces a timeout when the snapshot never changes", async () => {
    const oldSnapshot = {
      snapshot: {
        ...SNAPSHOT_RESPONSE.snapshot,
        snapshotId: "snap-existing",
        generatedAt: "2026-05-20T09:00:00Z",
      },
    };
    let exportPosted = false;
    let snapshotReads = 0;
    fetchMock.mockImplementation(async (input, init) => {
      await Promise.resolve();
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/v1/research/export")) {
        exportPosted = true;
        return jsonResponse({ jobId: "export-new-1" }, { status: 202 });
      }
      if (method === "POST" && url.includes("/v1/research/pull")) {
        return jsonResponse({ job_id: "pull-new-1" }, { status: 202 });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) {
        if (exportPosted) snapshotReads += 1;
        return jsonResponse(oldSnapshot);
      }
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      return new Response("not found", { status: 404 });
    });

    render(<ResearchPage />, { wrapper: makeWrapper() });
    expect((await screen.findByTestId("research-snapshot-id")).textContent).toBe("snap-existing");

    fireEvent.click(screen.getByTestId("research-cta-export"));
    await screen.findByTestId("research-export-dialog");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T20:00:00Z"));
    fireEvent.click(screen.getByTestId("research-export-submit"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-export-job").textContent).toContain("export-new-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("research-export-polling-error").textContent).toContain(
      "Export did not produce a new snapshot",
    );

    const readsAfterTimeout = snapshotReads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(snapshotReads).toBe(readsAfterTimeout);
  });

  async function openDialog(): Promise<void> {
    fireEvent.click(screen.getByTestId("research-cta-pull"));
    await screen.findByTestId("research-pull-dialog");
  }

  it("gates Submit on a fresh valid dry-run and previews canonical vs artifact-only", async () => {
    // No fake timers needed: the dialog derives the updated-follow `since` from
    // the same `nowSeconds` it passes to the planner, so staleness is purely
    // (seconds-ago vs 60) and fully deterministic against the real clock.
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await openDialog();

    // Before a dry-run, Submit is disabled.
    expect(isDisabled(screen.getByTestId("research-pull-submit"))).toBe(true);

    // Compose a valid mixed-class pull: kalshi (canonical) + odds-api-io
    // (artifact-only), live-capture events-snapshot (default markets, single
    // bookmaker). kalshi is on by default; add odds-api-io and switch mode.
    fireEvent.click(screen.getByTestId("research-pull-source-odds-api-io"));
    // Default capture_mode is historical, but odds-api-io needs repair/live-capture.
    fireEvent.change(screen.getByTestId("research-pull-capture-mode"), {
      target: { value: "live-capture" },
    });

    fireEvent.click(screen.getByTestId("research-pull-dry-run"));

    // Valid plan -> preview rows separate canonical from artifact-only.
    const preview = await screen.findByTestId("research-pull-preview");
    const rows = within(preview).getAllByTestId("research-pull-preview-row");
    const kalshi = rows.find((r) => r.getAttribute("data-source-id") === "kalshi");
    const odds = rows.find((r) => r.getAttribute("data-source-id") === "odds-api-io");
    expect(kalshi?.getAttribute("data-artifact-class")).toBe("canonical");
    expect(kalshi?.textContent).toContain("canonical");
    expect(odds?.getAttribute("data-artifact-class")).toBe("artifact_only");
    expect(odds?.textContent).toContain("artifact-only");

    // Submit now enabled; clicking it POSTs and closes the dialog.
    const submitBtn = screen.getByTestId("research-pull-submit");
    expect(isDisabled(submitBtn)).toBe(false);
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.queryByTestId("research-pull-dialog")).toBeNull();
    });
    const posted = fetchMock.mock.calls.find(
      (c) => (c[1]?.method ?? "GET").toUpperCase() === "POST",
    );
    expect(posted).toBeDefined();
  });

  it("dry-run rejects updated-follow with two bookmakers and keeps Submit disabled", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await openDialog();

    fireEvent.click(screen.getByTestId("research-pull-source-odds-api-io"));
    fireEvent.change(screen.getByTestId("research-pull-capture-mode"), {
      target: { value: "live-capture" },
    });
    fireEvent.click(screen.getByTestId("research-pull-mode-updated-follow"));
    // Default bookmakers is ["Kalshi"]; add a second one to break the rule.
    fireEvent.click(screen.getByTestId("research-pull-book-Bet365"));

    fireEvent.click(screen.getByTestId("research-pull-dry-run"));

    const errors = await screen.findByTestId("research-pull-errors");
    const codes = within(errors)
      .getAllByTestId("research-pull-error")
      .map((e) => e.getAttribute("data-error-code"));
    expect(codes).toContain("updated_follow_requires_one_bookmaker");
    expect(isDisabled(screen.getByTestId("research-pull-submit"))).toBe(true);
  });

  it("dry-run rejects live-ws combining a league and event IDs", async () => {
    // The validator's live_ws_league_and_event_ids rule fires only when BOTH a
    // league and event IDs reach it under live-ws. The dialog sends whatever the
    // operator typed (it does NOT silently mask one), so the dry-run surfaces
    // the XOR conflict and keeps Submit disabled.
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await openDialog();

    fireEvent.click(screen.getByTestId("research-pull-source-odds-api-io"));
    fireEvent.change(screen.getByTestId("research-pull-capture-mode"), {
      target: { value: "live-capture" },
    });
    fireEvent.click(screen.getByTestId("research-pull-mode-live-ws"));
    // League is "NBA" by default; ALSO set event IDs -> both reach the validator.
    fireEvent.change(screen.getByTestId("research-pull-event-ids"), {
      target: { value: "evt-1 evt-2" },
    });
    fireEvent.click(screen.getByTestId("research-pull-dry-run"));

    const errors = await screen.findByTestId("research-pull-errors");
    const codes = within(errors)
      .getAllByTestId("research-pull-error")
      .map((e) => e.getAttribute("data-error-code"));
    expect(codes).toContain("live_ws_league_and_event_ids");
    expect(isDisabled(screen.getByTestId("research-pull-submit"))).toBe(true);
  });

  it("preview shows the canonical / artifact-only / PENDING split even when a pending source makes the plan invalid", async () => {
    // draftkings-direct is pending (no supported capture mode), so the overall
    // plan is invalid — but the preview must still report where each selected
    // source WOULD land, including the pending row.
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await openDialog();

    // kalshi is on by default (canonical); add odds-api-io (artifact-only) and
    // draftkings-direct (pending).
    fireEvent.click(screen.getByTestId("research-pull-source-odds-api-io"));
    fireEvent.click(screen.getByTestId("research-pull-source-draftkings-direct"));
    fireEvent.change(screen.getByTestId("research-pull-capture-mode"), {
      target: { value: "live-capture" },
    });
    fireEvent.click(screen.getByTestId("research-pull-dry-run"));

    const preview = await screen.findByTestId("research-pull-preview");
    const rows = within(preview).getAllByTestId("research-pull-preview-row");
    const classOf = (id: string): string | null =>
      rows
        .find((r) => r.getAttribute("data-source-id") === id)
        ?.getAttribute("data-artifact-class") ?? null;
    expect(classOf("kalshi")).toBe("canonical");
    expect(classOf("odds-api-io")).toBe("artifact_only");
    expect(classOf("draftkings-direct")).toBe("pending");

    // Plan is invalid (pending supports no mode) -> errors shown, Submit locked.
    expect(screen.getByTestId("research-pull-errors")).not.toBeNull();
    expect(isDisabled(screen.getByTestId("research-pull-submit"))).toBe(true);
  });

  it("dry-run rejects updated-follow with a stale since watermark (>60s)", async () => {
    mockResearch();
    render(<ResearchPage />, { wrapper: makeWrapper() });
    await openDialog();

    fireEvent.click(screen.getByTestId("research-pull-source-odds-api-io"));
    fireEvent.change(screen.getByTestId("research-pull-capture-mode"), {
      target: { value: "live-capture" },
    });
    fireEvent.click(screen.getByTestId("research-pull-mode-updated-follow"));
    // since defaults to 30s ago (valid); push it to 9999s ago (stale).
    fireEvent.change(screen.getByTestId("research-pull-since"), {
      target: { value: "9999" },
    });
    fireEvent.click(screen.getByTestId("research-pull-dry-run"));

    const errors = await screen.findByTestId("research-pull-errors");
    const codes = within(errors)
      .getAllByTestId("research-pull-error")
      .map((e) => e.getAttribute("data-error-code"));
    expect(codes).toContain("updated_follow_since_stale");
    expect(isDisabled(screen.getByTestId("research-pull-submit"))).toBe(true);
  });

  it("renders an error banner when an artifact query returns an HTTP error", async () => {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      const url = urlOf(input);
      if (url.includes("/v1/research/sources")) {
        return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      }
      // Other reads succeed (gold present) so only the sources error surfaces.
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) return jsonResponse(EMPTY_SNAPSHOT);
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      return new Response("not found", { status: 404 });
    });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    const banner = await screen.findByTestId("query-error-banner");
    expect(banner.textContent).toContain("Failed to load research artifacts");
  });

  it("surfaces a FAILED far-calibration request as an error banner, not a silent empty state", async () => {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      const url = urlOf(input);
      // Only far-calibration fails; everything else (incl. harvested-labels) succeeds.
      if (url.includes("/v1/research/far-calibration")) {
        return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) return jsonResponse(EMPTY_SNAPSHOT);
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      if (url.includes("/v1/research/confluence-eval")) return jsonResponse(EMPTY_CONFLUENCE);
      if (url.includes("/v1/research/harvested-labels")) return jsonResponse(EMPTY_HARVESTED);
      if (url.includes("/v1/research/attribution")) return jsonResponse(EMPTY_ATTRIBUTION);
      return new Response("not found", { status: 404 });
    });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    // Only far-calibration fails + every other read succeeds, so the error banner can
    // only come from far-calibration being in the error aggregation — before the fix
    // its failure was omitted and produced NO banner (a silent empty state instead).
    const banner = await screen.findByTestId("query-error-banner");
    expect(banner.textContent).toContain("Failed to load research artifacts");
  });

  it("surfaces a FAILED confluence-eval request as an error banner, not a silent empty state", async () => {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      const url = urlOf(input);
      // Only confluence-eval fails; everything else succeeds. An ABSENT artifact
      // returns null successfully (empty state, no banner); a FAILED request must
      // banner — proving confluence-eval is in the error aggregation.
      if (url.includes("/v1/research/confluence-eval")) {
        return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      }
      if (url.includes("/v1/research/gold")) return jsonResponse(GOLD_RESPONSE);
      if (url.includes("/v1/research/sources")) return jsonResponse(SOURCES_RESPONSE);
      if (url.includes("/v1/research/snapshot/latest")) return jsonResponse(EMPTY_SNAPSHOT);
      if (url.includes("/v1/research/leaderboard/latest")) return jsonResponse(EMPTY_LEADERBOARD);
      if (url.includes("/v1/research/models")) return jsonResponse(MODELS_RESPONSE);
      if (url.includes("/v1/research/pulls")) return jsonResponse(EMPTY_PULLS);
      if (url.includes("/v1/research/far-calibration")) return jsonResponse(EMPTY_FAR);
      if (url.includes("/v1/research/harvested-labels")) return jsonResponse(EMPTY_HARVESTED);
      if (url.includes("/v1/research/attribution")) return jsonResponse(EMPTY_ATTRIBUTION);
      return new Response("not found", { status: 404 });
    });
    render(<ResearchPage />, { wrapper: makeWrapper() });
    const banner = await screen.findByTestId("query-error-banner");
    expect(banner.textContent).toContain("Failed to load research artifacts");
  });
});
