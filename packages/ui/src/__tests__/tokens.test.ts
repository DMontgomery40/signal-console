import { describe, expect, it } from "vitest";
import { colors, motion, typography } from "../tokens";

// Snapshot-only assertions on purpose: the snapshot file (.snap) is the
// allow-listed home for hex literals outside ../tokens.ts. Asserting against
// inline literals here would violate `pnpm verify:no-hex-literals`, so the
// snapshot IS the spec for these values — drift in tokens.ts is caught by
// snapshot diff and reviewed deliberately per US-043 / docs/design-language.md.

describe("tokens (US-043)", () => {
  it("colors snapshot — drift is a deliberate review event", () => {
    expect(colors).toMatchSnapshot();
  });

  it("typography snapshot — drift is a deliberate review event", () => {
    expect(typography).toMatchSnapshot();
  });

  it("motion snapshot — drift is a deliberate review event", () => {
    expect(motion).toMatchSnapshot();
  });

  it("color token object has every documented key", () => {
    const expectedKeys = [
      "surface0From",
      "surface0To",
      "surface1",
      "surface2",
      "surfaceElevated",
      "accentGreen",
      "accentYellow",
      "negative",
      "textHi",
      "textMd",
      "textLo",
    ].sort();
    expect(Object.keys(colors).sort()).toEqual(expectedKeys);
  });
});
