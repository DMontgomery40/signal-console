// Canonical Odds-API.io key resolver contract (audit F-012).
//
// The whole point of F-012: the documented-preferred `ODDSAPI_API_KEY` was
// ignored by four hand-rolled `ODDS_API_KEY ?? ODDS_API_IO_KEY` reads, so an
// operator who set only the preferred key silently disabled the provider. These
// tests are the negative controls that pin the documented order
// (ODDSAPI_API_KEY → ODDS_API_KEY → ODDS_API_IO_KEY) to a single resolver. They
// fail if anyone reintroduces a divergent name list.

import { describe, expect, it } from "vitest";

import { ODDS_API_KEY_ENV_NAMES, resolveOddsApiKey } from "../env";

const EMPTY: NodeJS.ProcessEnv = {};

describe("resolveOddsApiKey (F-012)", () => {
  it("the canonical name list matches the documented order (CLAUDE.md)", () => {
    expect([...ODDS_API_KEY_ENV_NAMES]).toEqual([
      "ODDSAPI_API_KEY",
      "ODDS_API_KEY",
      "ODDS_API_IO_KEY",
    ]);
  });

  it("resolves the documented-PREFERRED key when ONLY ODDSAPI_API_KEY is set (the F-012 bug)", () => {
    // Before the fix this returned null and the provider was silently disabled.
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "pref" })).toBe("pref");
  });

  it("falls back through the documented order", () => {
    expect(resolveOddsApiKey({ ODDS_API_KEY: "second" })).toBe("second");
    expect(resolveOddsApiKey({ ODDS_API_IO_KEY: "third" })).toBe("third");
  });

  it("prefers earlier names over later ones", () => {
    expect(
      resolveOddsApiKey({
        ODDSAPI_API_KEY: "pref",
        ODDS_API_KEY: "second",
        ODDS_API_IO_KEY: "third",
      }),
    ).toBe("pref");
    expect(resolveOddsApiKey({ ODDS_API_KEY: "second", ODDS_API_IO_KEY: "third" })).toBe("second");
  });

  it("an explicit key overrides the environment", () => {
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "env" }, { explicitKey: "explicit" })).toBe(
      "explicit",
    );
  });

  it("treats empty-string keys as absent (no silent empty-key auth)", () => {
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "" })).toBeNull();
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "", ODDS_API_KEY: "real" })).toBe("real");
    expect(resolveOddsApiKey(EMPTY, { explicitKey: "" })).toBeNull();
  });

  it("returns null when no key is present", () => {
    expect(resolveOddsApiKey(EMPTY)).toBeNull();
  });
});
