// US-026 wired board-mad. US-027 added off-price-print so the registry now
// ships with two detectors as required by PRD §10.

import { describe, expect, it } from "vitest";

import { registry } from "../registry";

describe("detector registry", () => {
  it("contains board-mad after US-026 wiring", () => {
    const entry = registry.get("board-mad");
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.id).toBe("board-mad");
    expect(entry.version).toBe("1.0.0");
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

  it("ships with two detectors", () => {
    expect(registry.size).toBe(2);
  });
});
