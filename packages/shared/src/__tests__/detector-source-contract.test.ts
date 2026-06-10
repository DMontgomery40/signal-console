// Detector source contract (audit F-007).
//
// The detector `Source` union (`packages/detectors/src/types.ts`) is a deliberate
// SUBSET of the canonical source universe (`marketResearchSourceIds` in
// `@signal-console/domain`). `detectors` cannot import `domain` to type-bind the
// two (domain already imports detectors' board-mad config, so the dependency is
// one-way and binding it would cycle). This test is the binding instead: it
// proves every source a detector ADVERTISES is a known domain source, and fails
// loudly if a detector ever declares a source the domain universe doesn't know —
// closing the "three definitions of the source set, nothing enforcing agreement"
// gap. It does NOT assert the reverse (domain may legitimately know sources, e.g.
// fanduel/draftkings, that no detector consumes yet). `packages/shared` is the
// host because it is the lowest layer that depends on BOTH detectors and domain.

import { describe, expect, it } from "vitest";

import { registry } from "@signal-console/detectors";
import { marketResearchSourceIds } from "@signal-console/domain";

describe("detector source contract (F-007)", () => {
  const universe = new Set<string>(marketResearchSourceIds);

  it("the source universe is non-empty (guards against an import regression)", () => {
    expect(universe.size).toBeGreaterThan(0);
  });

  for (const [id, detector] of registry) {
    it(`every advertised source of "${id}" is a member of marketResearchSourceIds`, () => {
      expect(detector.sources.length).toBeGreaterThan(0);
      for (const source of detector.sources) {
        expect(universe.has(source)).toBe(true);
      }
    });
  }
});
