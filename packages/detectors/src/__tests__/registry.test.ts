// US-026: board-mad is wired into the detector registry so the Settings UI's
// About section returns a non-empty detector list. off-price-print lands in
// US-027 and adds itself the same way.

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

  it("size is at least 1 and excludes unwired detector ids", () => {
    expect(registry.size).toBeGreaterThanOrEqual(1);
    // off-price-print lands in US-027; assert it is not yet present so a
    // future iteration that lands US-027 has a self-falsifying signal here.
    expect(registry.get("off-price-print")).toBeUndefined();
  });
});
