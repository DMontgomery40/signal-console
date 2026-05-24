import { describe, expect, it } from "vitest";

import type { MarketAnomalyAlert } from "@signal-console/domain";

import { participantKeyFromDisplayLabel } from "../board-anomaly-fanout-support";
import { buildFanouts } from "../board-anomaly-live-fanouts";
import { buildObservationLabels } from "../board-anomaly-observation-context";

function makeMarketAlert(
  overrides: Partial<MarketAnomalyAlert> &
    Pick<MarketAnomalyAlert, "displayLabel" | "id">
): MarketAnomalyAlert {
  return {
    id: overrides.id,
    action: "manual-review",
    apiSurface: "data-api/trades",
    confidence: 0.72,
    detectedAt: overrides.detectedAt ?? "2026-05-21T00:00:05.000Z",
    displayLabel: overrides.displayLabel,
    eventTimestamp: overrides.eventTimestamp ?? "2026-05-21T00:00:05.000Z",
    eventType: "trade",
    family: overrides.family ?? "player-prop",
    gameId: overrides.gameId ?? "nba-den-min-2026-05-21",
    gameLabel: overrides.gameLabel ?? "Nuggets @ Timberwolves",
    instrumentId: overrides.instrumentId ?? `${overrides.id}-instrument`,
    labels: overrides.labels ?? ["volume-share anomaly"],
    league: overrides.league ?? "NBA",
    mappingStatus: overrides.mappingStatus ?? "auto",
    rawLabel: overrides.rawLabel ?? overrides.displayLabel,
    score: overrides.score ?? 78,
    severity: overrides.severity ?? "high",
    source: overrides.source ?? "polymarket",
    sourceMarketId: overrides.sourceMarketId ?? `${overrides.id}-source-market`,
    sourceMarketKey:
      overrides.sourceMarketKey ?? `${overrides.id}-source-market-key`,
    sourceSelectionKey: overrides.sourceSelectionKey ?? "over",
    sport: overrides.sport ?? "basketball",
    components: overrides.components ?? {
      crossVenue: 0.4,
      liquidity: 0.35,
      offPrice: 0.6,
      volatility: 0.45,
      volumeShare: 0.8,
    },
    metrics: overrides.metrics ?? {
      notional: 140,
      size: 140,
      tradePrice: 0.98,
      volumeShare: 0.18,
    },
  };
}

describe("board anomaly runtime name normalization", () => {
  it("normalizes accented and punctuation-heavy display labels into the same participant key", () => {
    expect(
      participantKeyFromDisplayLabel("Nikola Jokić points over 29.5")
    ).toBe("nikola jokic");
    expect(
      participantKeyFromDisplayLabel("Royce O'Neale: Points O/U 6.5")
    ).toBe("royce oneale");
    expect(
      participantKeyFromDisplayLabel("Shai Gilgeous-Alexander: Assists O/U 7.5")
    ).toBe("shai gilgeous alexander");
    expect(
      participantKeyFromDisplayLabel("Pistons Team Total Over 112.5")
    ).toBeNull();
  });

  it("keeps normalized observation labels usable when source labels contain accents", () => {
    expect(
      buildObservationLabels(
        "player-prop",
        "Nikola Jokić: Points O/U 29.5",
        null,
        "Nikola Jokić points over 29.5"
      )
    ).toEqual(
      expect.objectContaining({
        normalizedTokens: expect.arrayContaining(["nikola", "jokic", "points"]),
        statFamilyHints: expect.arrayContaining(["points"]),
      })
    );
  });

  it("groups mixed accented/plain live player-prop alerts into one fanout participant", () => {
    const fanouts = buildFanouts([
      makeMarketAlert({
        id: "jokic-points",
        displayLabel: "Nikola Jokić points over 29.5",
        eventTimestamp: "2026-05-21T00:00:05.000Z",
        source: "polymarket",
        metrics: {
          notional: 160,
          size: 160,
          tradePrice: 0.98,
          volumeShare: 0.18,
        },
      }),
      makeMarketAlert({
        id: "jokic-rebounds",
        displayLabel: "Nikola Jokic rebounds over 13.5",
        eventTimestamp: "2026-05-21T00:00:55.000Z",
        source: "kalshi",
        metrics: {
          notional: 120,
          size: 120,
          tradePrice: 0.97,
          volumeShare: 0.14,
        },
      }),
    ]);

    expect(fanouts).toHaveLength(1);
    expect(fanouts[0]).toEqual(
      expect.objectContaining({
        participantKey: "nikola jokic",
      })
    );
    expect(
      fanouts[0].members.map((member) => member.alert.displayLabel)
    ).toEqual(
      expect.arrayContaining([
        "Nikola Jokić points over 29.5",
        "Nikola Jokic rebounds over 13.5",
      ])
    );
  });
});
