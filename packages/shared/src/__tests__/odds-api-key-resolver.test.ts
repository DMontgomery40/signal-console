import { describe, expect, it } from "vitest";

import { ODDS_API_KEY_ENV_NAMES, resolveOddsApiKey } from "../env";

describe("resolveOddsApiKey", () => {
  it("declares the documented credential lookup order", () => {
    expect(ODDS_API_KEY_ENV_NAMES).toEqual(["ODDSAPI_API_KEY", "ODDS_API_KEY", "ODDS_API_IO_KEY"]);
  });

  it("resolves the documented-preferred ODDSAPI_API_KEY (the F-012 bug)", () => {
    // The exact regression: a user who sets only the preferred name was a silent
    // provider no-op because the gates checked ODDS_API_KEY/ODDS_API_IO_KEY only.
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "preferred" })).toBe("preferred");
  });

  it("falls back to ODDS_API_KEY when the preferred name is absent", () => {
    expect(resolveOddsApiKey({ ODDS_API_KEY: "legacy" })).toBe("legacy");
  });

  it("falls back to ODDS_API_IO_KEY last", () => {
    expect(resolveOddsApiKey({ ODDS_API_IO_KEY: "io" })).toBe("io");
  });

  it("prefers the earlier name when several are set", () => {
    expect(
      resolveOddsApiKey({
        ODDSAPI_API_KEY: "preferred",
        ODDS_API_KEY: "legacy",
        ODDS_API_IO_KEY: "io",
      }),
    ).toBe("preferred");
  });

  it("honors an explicit override above the environment", () => {
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "preferred" }, { explicitKey: "explicit" })).toBe(
      "explicit",
    );
  });

  it("treats empty strings as unset and returns null when no key is present", () => {
    expect(resolveOddsApiKey({ ODDSAPI_API_KEY: "" }, { explicitKey: "" })).toBeNull();
    expect(resolveOddsApiKey({})).toBeNull();
  });
});
