// DetectorsPage tests (US-032).
//
// The page is wired against useDetectors() (queries.ts), which talks to
// GET /v1/detectors. The fixture below mirrors the live response shape:
// { detectors: [ { id, version, displayName, paramsSchema } ] } with
// paramsSchema in zod-to-json-schema form. Tests assert:
//   - one card per registered detector
//   - paramsSchema is auto-rendered: number -> number field, enum -> select,
//     boolean -> switch
//   - off-price-print displays the "Sources: Polymarket only" tag
//   - object-shaped params stay compact instead of dumping a giant JSON block

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode, JSX } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BOARD_MAD_BASELINE_MODE_DEFAULT,
  BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
  BOARD_MAD_BASELINE_MODE_TRAILING,
  BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
  BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
  BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  K_MAD_LIVE,
} from "@signal-console/detectors/board-mad/config";

import { DetectorsPage } from "../DetectorsPage";

async function findCardById(detectorId: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const cards = screen.getAllByTestId("detector-card");
    const match = cards.find((c) => c.getAttribute("data-detector-id") === detectorId);
    if (match === undefined) throw new Error(`no detector-card with id=${detectorId}`);
    return match;
  });
}

function asInput(el: HTMLElement): HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) throw new Error("expected <input>");
  return el;
}

function asSelect(el: HTMLElement): HTMLSelectElement {
  if (!(el instanceof HTMLSelectElement)) throw new Error("expected <select>");
  return el;
}

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

// Live-shape fixture: derived from running zod-to-json-schema on each
// detector's Params zod schema (see packages/detectors/src/*/index.ts).
// US-048 adds the `sources` closed-set field per detector.
const DETECTORS_RESPONSE = {
  detectors: [
    {
      id: "board-mad",
      version: "1.2.0",
      displayName: "Board State-Space (whole-board volatility)",
      sources: ["bet365", "kalshi", "polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          bucketSeconds: { type: "integer", minimum: 10, maximum: 300, default: 60 },
          kMad: { type: "number", minimum: 1, maximum: 12, default: K_MAD_LIVE },
          weighting: { type: "string", enum: ["volume", "equal"], default: "volume" },
          baselineMode: {
            type: "string",
            enum: [BOARD_MAD_BASELINE_MODE_TRAILING, BOARD_MAD_BASELINE_MODE_OPENING_RAMP],
            default: BOARD_MAD_BASELINE_MODE_DEFAULT,
          },
          openingBaselineBuckets: {
            type: "integer",
            minimum: 1,
            maximum: 60,
            default: BOARD_MAD_OPENING_BASELINE_BUCKETS_DEFAULT,
          },
          openingRampCompleteBuckets: {
            type: "integer",
            minimum: 2,
            maximum: 120,
            default: BOARD_MAD_OPENING_RAMP_COMPLETE_BUCKETS_DEFAULT,
          },
          trailingBuckets: {
            type: "integer",
            minimum: 5,
            maximum: 60,
            default: BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
          },
          warmupBuckets: {
            type: "integer",
            minimum: 2,
            maximum: 20,
            default: BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
          },
          freshCapSeconds: {
            type: "integer",
            minimum: 30,
            maximum: 3600,
            default: BOARD_MAD_FRESH_CAP_SECONDS_DEFAULT,
          },
          stateSpace: {
            default: {
              trigger: { enterOffset: 0.9 },
              breadth: { marketCountFloor: 1 },
              sourceTrust: { sourceDominancePenalty: 1.2 },
              scale: { madScale: 1.4826, scaleFloor: 0.05 },
            },
          },
        },
      },
    },
    {
      id: "off-price-print",
      version: "1.0.0",
      displayName: "Off-price print (Polymarket only)",
      sources: ["polymarket"],
      paramsSchema: {
        type: "object",
        properties: {
          minVolumeShare: { type: "number", minimum: 0, maximum: 1, default: 0.1 },
          minOffPriceDistance: { type: "number", minimum: 0, maximum: 1, default: 0.4 },
        },
      },
    },
  ],
};

describe("DetectorsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockDetectors(body: unknown = DETECTORS_RESPONSE): void {
    fetchMock.mockImplementation(async (input) => {
      await Promise.resolve();
      if (urlOf(input).startsWith("/v1/detectors")) return jsonResponse(body);
      return new Response("not found", { status: 404 });
    });
  }

  it("queries GET /v1/detectors and renders one card per detector", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("detector-card")).toHaveLength(2);
    });

    const urls = fetchMock.mock.calls.map((c) => urlOf(c[0]));
    expect(urls).toContain("/v1/detectors");

    const ids = screen
      .getAllByTestId("detector-card")
      .map((el) => el.getAttribute("data-detector-id"));
    expect(ids).toEqual(["board-mad", "off-price-print"]);

    // Secondary cross-link to the Research eval lab (in-app /research route).
    const researchLink = screen.getByTestId("detectors-research-link");
    expect(researchLink.getAttribute("href")).toBe("/research");
    expect(researchLink.textContent).toContain("Compare in Research");
  });

  it("renders the board state-space displayName, version, and id", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const card = await findCardById("board-mad");
    expect(card.textContent).toContain("Board State-Space (whole-board volatility)");
    expect(within(card).getByTestId("detector-version").textContent).toBe("v1.2.0");
    expect(card.textContent).toContain("board-mad");
  });

  it("auto-renders number params as number fields with defaults, min, and max attrs", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const card = await findCardById("board-mad");
    const kInput = asInput(within(card).getByTestId("param-input-kMad"));
    expect(kInput.getAttribute("type")).toBe("number");
    expect(kInput.getAttribute("data-param-kind")).toBe("number");
    expect(kInput.disabled).toBe(true);
    expect(kInput.value).toBe("3");
    expect(kInput.getAttribute("min")).toBe("1");
    expect(kInput.getAttribute("max")).toBe("12");

    const bucketInput = asInput(within(card).getByTestId("param-input-bucketSeconds"));
    expect(bucketInput.getAttribute("type")).toBe("number");
    expect(bucketInput.value).toBe("60");
  });

  it("auto-renders enum params as a disabled select with one option per enum value", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const card = await findCardById("board-mad");
    const weighting = asSelect(within(card).getByTestId("param-input-weighting"));
    expect(weighting.tagName).toBe("SELECT");
    expect(weighting.getAttribute("data-param-kind")).toBe("enum");
    expect(weighting.disabled).toBe(true);
    expect(weighting.value).toBe("volume");
    const options = Array.from(weighting.options).map((o) => o.value);
    expect(options).toEqual(["volume", "equal"]);

    const baselineMode = asSelect(within(card).getByTestId("param-input-baselineMode"));
    expect(baselineMode.value).toBe(BOARD_MAD_BASELINE_MODE_DEFAULT);
    const baselineOptions = Array.from(baselineMode.options).map((o) => o.value);
    expect(baselineOptions).toEqual([
      BOARD_MAD_BASELINE_MODE_TRAILING,
      BOARD_MAD_BASELINE_MODE_OPENING_RAMP,
    ]);
  });

  it("auto-renders boolean params as a disabled switch", async () => {
    // Inject a synthetic boolean param so we exercise the boolean branch
    // without coupling the test to a future detector that may add one.
    mockDetectors({
      detectors: [
        {
          id: "synthetic-bool",
          version: "0.1.0",
          displayName: "Synthetic Boolean Detector",
          sources: ["polymarket"],
          paramsSchema: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
            },
          },
        },
      ],
    });
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const card = await findCardById("synthetic-bool");
    const sw = within(card).getByTestId("param-input-enabled");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    const box = asInput(within(sw).getByRole("checkbox", { hidden: true }));
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it("renders a SOURCES chip on EVERY detector card (US-048)", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("detector-card")).toHaveLength(2);
    });

    const opp = screen
      .getAllByTestId("detector-card")
      .find((c) => c.getAttribute("data-detector-id") === "off-price-print");
    const boardMad = screen
      .getAllByTestId("detector-card")
      .find((c) => c.getAttribute("data-detector-id") === "board-mad");
    expect(opp).toBeDefined();
    expect(boardMad).toBeDefined();
    if (opp === undefined || boardMad === undefined) return;

    // board-mad reads from all three sources — uppercase, comma-separated.
    const boardMadChip = within(boardMad).getByTestId("detector-sources-tag");
    expect(boardMadChip.textContent).toBe("SOURCES: BET365, KALSHI, POLYMARKET");

    // off-price-print is single-source — drop the redundant "ONLY"; the
    // single entry implies it.
    const oppChip = within(opp).getByTestId("detector-sources-tag");
    expect(oppChip.textContent).toBe("SOURCES: POLYMARKET");
  });

  it("keeps state-space object params compact and points tuning to Settings + Backtest", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const card = await findCardById("board-mad");
    const field = within(card).getByTestId("param-input-stateSpace");
    expect(field.textContent).toContain("trigger");
    expect(field.textContent).toContain("breadth");
    expect(field.textContent).toContain("sourceTrust");
    expect(field.textContent).toContain(
      "Inspect and tune these coefficients on Settings and Backtest.",
    );
  });

  it("does not ship internal implementation playbooks in the product UI", async () => {
    mockDetectors();
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    await waitFor(() => {
      expect(screen.getAllByTestId("detector-card")).toHaveLength(2);
    });

    expect(screen.queryByTestId("how-to-add-detector")).toBeNull();
    expect(screen.queryByText("How to add a detector ALGORITHM")).toBeNull();
    expect(screen.queryByText("How to add a data SOURCE (FanDuel, DraftKings, etc.)")).toBeNull();
  });

  it("shows a loading indicator while the query is in flight, then renders cards", async () => {
    // Defer the fetch resolution so the page renders in its loading state long
    // enough for the assertion to run, then release to confirm the post-load
    // meta text. Capture the resolver via a holder object so TS doesn't
    // narrow the let-binding away inside the Promise executor closure.
    const holder: { resolve: ((res: Response) => void) | null } = { resolve: null };
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          holder.resolve = resolve;
        }),
    );
    render(<DetectorsPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("detectors-meta").textContent).toBe("loading…");
    await waitFor(() => {
      expect(holder.resolve).not.toBeNull();
    });
    holder.resolve?.(jsonResponse(DETECTORS_RESPONSE));
    await waitFor(() => {
      expect(screen.getAllByTestId("detector-card")).toHaveLength(2);
    });
    expect(screen.getByTestId("detectors-meta").textContent).toBe("2 registered");
  });

  it("renders a QueryErrorBanner when the API returns an HTTP error", async () => {
    fetchMock.mockImplementation(async () => {
      await Promise.resolve();
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    });
    render(<DetectorsPage />, { wrapper: makeWrapper() });

    const banner = await screen.findByTestId("query-error-banner");
    expect(banner.textContent).toContain("Failed to load detectors");
  });
});
