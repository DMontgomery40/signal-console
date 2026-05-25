// US-026 wired board-mad. US-027 added off-price-print so the registry now
// ships with two detectors as required by PRD §10. US-048 adds the `sources`
// closed-set field so the UI can surface a SOURCES chip per detector.
// Ensemble-OR (Stage 1, suspend-signal report §8.1) was added later — the
// recommended Live/Backtest default that runs both lanes in one pass.

import { describe, expect, it } from "vitest";

import { registry } from "../registry";

describe("detector registry", () => {
  it("contains board-mad after US-026 wiring", () => {
    const entry = registry.get("board-mad");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("board-mad");
    expect(entry.version).toBe("1.5.0");
    expect(entry.displayName).toContain("Board MAD");
    expect(entry.paramsSchema).toBeDefined();
  });

  it("contains off-price-print after US-027 wiring", () => {
    const entry = registry.get("off-price-print");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("off-price-print");
    expect(entry.version).toBe("1.0.0");
    expect(entry.displayName).toContain("Polymarket only");
    expect(entry.paramsSchema).toBeDefined();
  });

  it("contains ensemble-or (Stage 1 from suspend-signal report §8.1)", () => {
    const entry = registry.get("ensemble-or");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("ensemble-or");
    expect(entry.displayName).toContain("Stage 1");
    expect(entry.paramsSchema).toBeDefined();
  });

  it("ships with three detectors (board-mad + off-price-print + ensemble-or)", () => {
    expect(registry.size).toBe(3);
  });

  it("every registered detector declares a non-empty sources array (US-048)", () => {
    for (const entry of registry.values()) {
      expect(entry.sources.length).toBeGreaterThan(0);
      // Closed set; eslint blocks `as` casts, so use a runtime guard.
      for (const src of entry.sources) {
        expect(["bet365", "kalshi", "polymarket"]).toContain(src);
      }
    }
  });

  it("board-mad reads from all three sources (Bet365 + Kalshi + Polymarket)", () => {
    const entry = registry.get("board-mad");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect([...entry.sources].sort()).toEqual(["bet365", "kalshi", "polymarket"]);
  });

  it("off-price-print reads from Polymarket only", () => {
    const entry = registry.get("off-price-print");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect([...entry.sources]).toEqual(["polymarket"]);
  });
});
