import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  PlayerPropAlertPlaybackFrame,
  PlayerPropDisagreementAlert,
} from "@signal-console/domain";

import {
  listPlayerPropAlertPlaybackFrames,
  resolvePlayerPropAlertPlaybackDate,
  writePlayerPropAlertPlaybackFrame,
} from "../player-prop-alert-playback";

let tempDir = "";

function sampleAlert(id: string): PlayerPropDisagreementAlert {
  return {
    absoluteDelta: 0.29,
    action: "manual-review",
    bet365: {
      capturedAt: "2026-05-11T01:00:00.000Z",
      impliedProbability: 0.64,
      lineRaw: 29.5,
      mappingStatus: "auto",
      oddsRaw: "-178",
      rawLabel: "Jalen Brunson (29.5)",
      source: "bet365",
      sourceMarketId: "sm-bet365-brunson-points",
      sourceMarketKey: "b365-brunson-points",
      sourceSelectionKey: "over",
    },
    detectedAt: "2026-05-11T01:00:05.000Z",
    direction: "bet365-higher",
    displayLabel: "Jalen Brunson points over 29.5",
    freshness: {
      bet365AgeMs: 5_000,
      predictionMarketAgeMs: 0,
      quoteTimeGapMs: 5_000,
    },
    gameId: "nba-bos-nyk-2026-05-10",
    gameLabel: "Knicks at Celtics",
    id,
    inPlay: true,
    instrumentId: "brunson-points-over-29_5",
    league: "NBA",
    line: 29.5,
    lineMismatch: false,
    participantKey: "jalen-brunson",
    predictionMarket: {
      bestAsk: 0.36,
      bestBid: 0.35,
      capturedAt: "2026-05-11T01:00:05.000Z",
      impliedProbability: 0.35,
      lineRaw: 29.5,
      mappingStatus: "auto",
      priceRaw: 0.35,
      rawLabel: "Jalen Brunson: 30+ points",
      source: "kalshi",
      sourceMarketId: "sm-kalshi-brunson-points",
      sourceMarketKey: "kal-brunson-points",
      sourceSelectionKey: "over",
    },
    riskScore: 327,
    scheduledStart: "2026-05-10T23:00:00.000Z",
    selection: "over",
    severity: "critical",
    signedDelta: -0.29,
    sport: "basketball",
  };
}

function sampleFrame(
  capturedAt: string,
  alerts: PlayerPropDisagreementAlert[]
): PlayerPropAlertPlaybackFrame {
  return {
    alertCount: alerts.length,
    alerts,
    capturedAt,
    notifiedAlertIds: alerts.map((alert) => alert.id),
    poll: {
      includeStale: false,
      limit: 25,
      maxQuoteTimeGapMinutes: 10,
      maxQuoteAgeMinutes: 10,
      minDelta: 0.15,
    },
    source: "player-prop-alert-watch",
  };
}

describe("player prop alert playback", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signal-console-playback-"));
    process.env.PLAYER_PROP_ALERT_PLAYBACK_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.PLAYER_PROP_ALERT_PLAYBACK_DIR;
    delete process.env.PLAYER_PROP_ALERT_TIME_ZONE;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes and reads the latest watcher frames for the Denver game date", () => {
    writePlayerPropAlertPlaybackFrame(
      sampleFrame("2026-05-11T01:00:00.000Z", [sampleAlert("alert-1")])
    );
    writePlayerPropAlertPlaybackFrame(
      sampleFrame("2026-05-11T01:00:10.000Z", [])
    );
    writePlayerPropAlertPlaybackFrame(
      sampleFrame("2026-05-11T01:00:20.000Z", [sampleAlert("alert-2")])
    );

    expect(
      resolvePlayerPropAlertPlaybackDate(
        undefined,
        new Date("2026-05-11T01:00:00.000Z")
      )
    ).toBe("2026-05-10");
    expect(
      listPlayerPropAlertPlaybackFrames({
        date: "2026-05-10",
        limit: 2,
      }).map((frame) => frame.capturedAt)
    ).toEqual(["2026-05-11T01:00:10.000Z", "2026-05-11T01:00:20.000Z"]);
  });

  it("rejects impossible playback dates instead of normalizing them", () => {
    expect(() => resolvePlayerPropAlertPlaybackDate("2026-02-31")).toThrow(
      "Playback date must use YYYY-MM-DD format."
    );
  });

  it("treats zero and negative playback limits as empty result limits", () => {
    writePlayerPropAlertPlaybackFrame(
      sampleFrame("2026-05-11T01:00:00.000Z", [sampleAlert("alert-1")])
    );
    writePlayerPropAlertPlaybackFrame(
      sampleFrame("2026-05-11T01:00:10.000Z", [sampleAlert("alert-2")])
    );

    expect(
      listPlayerPropAlertPlaybackFrames({
        date: "2026-05-10",
        limit: 0,
      })
    ).toEqual([]);
    expect(
      listPlayerPropAlertPlaybackFrames({
        date: "2026-05-10",
        limit: -4,
      })
    ).toEqual([]);
  });

  it("skips malformed replay lines without hiding valid frames", () => {
    writeFileSync(
      join(tempDir, "2026-05-10.jsonl"),
      [
        JSON.stringify(sampleFrame("2026-05-11T01:00:00.000Z", [])),
        "{not json",
        JSON.stringify(
          sampleFrame("2026-05-11T01:00:10.000Z", [sampleAlert("alert-1")])
        ),
      ].join("\n")
    );

    expect(
      listPlayerPropAlertPlaybackFrames({ date: "2026-05-10" })
    ).toMatchObject([
      { alertCount: 0 },
      {
        alertCount: 1,
        notifiedAlertIds: ["alert-1"],
      },
    ]);
  });
});
