import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATCH_WINDOW_AFTER_SECONDS,
  CATCH_WINDOW_BEFORE_SECONDS,
  normalizeIncident,
  readIncidents,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures/incident-registry.fixture.json");

// Parity + correctness gate for the Phase 0.5 extraction of board truth logic
// into @signal-console/research-truth.
//
// The heavy math (bucketize/bucketScore/buildMarketOutlierEpisodes/findIncidentFire)
// moved BYTE-IDENTICALLY from commit 882621b (verified textually), so it is
// identical by construction.
//
// The incident reader was BUG-FIXED (2026-05-29): the original read only
// snake_case keys while the live registry is camelCase, so it silently produced
// empty gameId/utcTime and broke every downstream incident match. The reader is
// now casing-tolerant (camelCase preferred, snake_case fallback). These tests
// lock BOTH casings AND guard against a regression to empty ids.
describe("research-truth: incident normalization + catch window", () => {
  it("pins the incident catch window to the bakeoff contract (-60s .. +300s)", () => {
    expect(CATCH_WINDOW_BEFORE_SECONDS).toBe(-60);
    expect(CATCH_WINDOW_AFTER_SECONDS).toBe(300);
  });

  it("normalizeIncident maps a camelCase registry row (the live format)", () => {
    const norm = normalizeIncident({
      id: "hartenstein_wallace",
      confidence: "high",
      anchorType: "second",
      gameId: "nba-0042500222",
      utcTime: "2026-05-08T03:12:36.8Z",
      stat: "rebound",
      creditedPlayer: "I. Hartenstein",
      rightfulPlayer: "C. Wallace",
      officialCorrection: false,
      localBoardGameIds: ["nba-0042500222"],
    });
    expect(norm).toMatchObject({
      id: "hartenstein_wallace",
      anchorType: "second",
      gameId: "nba-0042500222",
      utcTime: "2026-05-08T03:12:36.8Z",
      creditedPlayer: "I. Hartenstein",
      rightfulPlayer: "C. Wallace",
      localBoardGameIds: ["nba-0042500222"],
    });
  });

  it("normalizeIncident still tolerates a legacy snake_case row", () => {
    const norm = normalizeIncident({
      id: "reaves_hayes",
      game_id: "nba-0042500224",
      utc_time: "2026-05-12T04:51:40.2Z",
      credited_player: "A. Reaves",
      local_board_game_ids: ["nba-0042500224"],
      official_correction: true,
    });
    expect(norm).toMatchObject({
      id: "reaves_hayes",
      gameId: "nba-0042500224",
      utcTime: "2026-05-12T04:51:40.2Z",
      creditedPlayer: "A. Reaves",
      localBoardGameIds: ["nba-0042500224"],
      officialCorrection: true,
    });
  });

  it("normalizeIncident drops rows without an id", () => {
    expect(normalizeIncident({ confidence: "low" })).toBeNull();
    expect(normalizeIncident(null)).toBeNull();
    expect(normalizeIncident("nope")).toBeNull();
  });

  it("readIncidents loads + normalizes a registry and returns POPULATED ids/anchors (regression: not empty)", () => {
    const incidents = readIncidents(FIXTURE);
    const byId = new Map(incidents.map((i) => [i.id, i]));
    expect(byId.has("hartenstein_wallace")).toBe(true);
    expect(byId.has("reaves_hayes_legacy_snake")).toBe(true);
    expect(byId.has("")).toBe(false); // id-less fixture row dropped

    const camel = byId.get("hartenstein_wallace");
    expect(camel?.gameId).toBe("nba-0042500222"); // would be "" under the old bug
    expect(camel?.utcTime).toBe("2026-05-08T03:12:36.8Z");

    const snake = byId.get("reaves_hayes_legacy_snake");
    expect(snake?.gameId).toBe("nba-0042500224"); // legacy snake fallback still works
    expect(snake?.utcTime).toBe("2026-05-12T04:51:40.2Z");
  });
});
