import { describe, expect, it } from "vitest";

import {
  clampProbability,
  isPeriodMarket,
  matchPbpNameToParticipant,
  normalizeStatFamily,
  reconstructStatsFromPbp,
  settleMoneyline,
  settleSpread,
  settleStatLine,
  settleTotal,
  statForFamily,
  summarizeSettled,
} from "../metrics";

describe("clampProbability", () => {
  it("clamps to open interval and passes through valid", () => {
    expect(clampProbability(0)).toBe(0.0001);
    expect(clampProbability(1)).toBe(0.9999);
    expect(clampProbability(0.5)).toBe(0.5);
    expect(clampProbability(null)).toBeNull();
    expect(clampProbability(Number.NaN)).toBeNull();
  });
});

describe("summarizeSettled", () => {
  it("scores a perfect predictor at brier 0 / accuracy 1", () => {
    const s = summarizeSettled([
      { p: 0.9999, actual: 1 },
      { p: 0.0001, actual: 0 },
    ]);
    expect(s.n).toBe(2);
    expect(s.brier!).toBeLessThan(1e-6);
    expect(s.accuracy).toBe(1);
  });
  it("returns nulls on empty", () => {
    expect(summarizeSettled([]).brier).toBeNull();
  });
});

describe("moneyline settlement", () => {
  it("wins when participant is the winner", () => {
    expect(settleMoneyline("nyk", "nyk")).toEqual({ actual: 1, push: false });
    expect(settleMoneyline("nyk", "bos")).toEqual({ actual: 0, push: false });
    expect(settleMoneyline(null, "bos")).toBeNull();
  });
});

describe("spread settlement (sign + push)", () => {
  const base = {
    homeKey: "nyk",
    awayKey: "bos",
    finalHome: 110,
    finalAway: 100,
  };
  it("home favorite covers -1.5 when winning by 10", () => {
    expect(
      settleSpread({ ...base, participantKey: "nyk", line: -1.5 })
    ).toEqual({
      actual: 1,
      push: false,
    });
  });
  it("away dog with +1.5 loses when losing by 10", () => {
    expect(settleSpread({ ...base, participantKey: "bos", line: 1.5 })).toEqual(
      {
        actual: 0,
        push: false,
      }
    );
  });
  it("favorite does NOT cover a too-large spread", () => {
    expect(
      settleSpread({ ...base, participantKey: "nyk", line: -12.5 })
    ).toEqual({
      actual: 0,
      push: false,
    });
  });
  it("integer line produces a push at the exact margin", () => {
    expect(settleSpread({ ...base, participantKey: "nyk", line: -10 })).toEqual(
      {
        actual: 0,
        push: true,
      }
    );
  });
  it("returns null when participant is neither side", () => {
    expect(
      settleSpread({ ...base, participantKey: "lal", line: -1.5 })
    ).toBeNull();
  });

  it("settles kalshi 'wins by over' as a margin threshold, not a handicap", () => {
    // home won by 10. "wins by over 1.5" => YES; "wins by over 16.5" => NO.
    expect(
      settleSpread({
        ...base,
        participantKey: "nyk",
        line: 1.5,
        displayLabel: "Knicks wins by over 1.5 points?",
      })
    ).toEqual({ actual: 1, push: false });
    expect(
      settleSpread({
        ...base,
        participantKey: "nyk",
        line: 16.5,
        displayLabel: "Knicks wins by over 16.5 points?",
      })
    ).toEqual({ actual: 0, push: false });
    // signed-handicap formula would WRONGLY say cover at line 16.5 (10+16.5>0):
    // this asserts the threshold branch overrides that.
  });
});

describe("total settlement", () => {
  it("over wins above the line, under below, push at equality", () => {
    expect(
      settleTotal({ selection: "over", line: 210.5, finalTotal: 218 })
    ).toEqual({
      actual: 1,
      push: false,
    });
    expect(
      settleTotal({ selection: "under", line: 210.5, finalTotal: 218 })
    ).toEqual({
      actual: 0,
      push: false,
    });
    expect(
      settleTotal({ selection: "over", line: 218, finalTotal: 218 })
    ).toEqual({
      actual: 0,
      push: true,
    });
  });
});

describe("player stat-line settlement", () => {
  it("over/under half-point lines never push", () => {
    expect(settleStatLine({ selection: "over", line: 24.5, stat: 27 })).toEqual(
      {
        actual: 1,
        push: false,
      }
    );
    expect(
      settleStatLine({ selection: "under", line: 24.5, stat: 27 })
    ).toEqual({
      actual: 0,
      push: false,
    });
  });
  it("over integer line pushes at equality", () => {
    expect(settleStatLine({ selection: "over", line: 20, stat: 20 })).toEqual({
      actual: 0,
      push: true,
    });
  });
  it("yes/no use >= threshold without push", () => {
    expect(settleStatLine({ selection: "yes", line: 1, stat: 1 })).toEqual({
      actual: 1,
      push: false,
    });
    expect(settleStatLine({ selection: "no", line: 1, stat: 0 })).toEqual({
      actual: 1,
      push: false,
    });
  });
});

describe("isPeriodMarket", () => {
  it("flags period/half/quarter/OT labels", () => {
    expect(isPeriodMarket("1H Knicks moneyline")).toBe(true);
    expect(isPeriodMarket("1H Over 111.5 total")).toBe(true);
    expect(isPeriodMarket("3Q Hawks +1.5")).toBe(true);
    expect(isPeriodMarket("Knicks OT total")).toBe(true);
  });
  it("does not flag full-game labels", () => {
    expect(isPeriodMarket("Knicks moneyline")).toBe(false);
    expect(isPeriodMarket("Over 217.5 total")).toBe(false);
    expect(isPeriodMarket("Tyrese Maxey points over 24.5")).toBe(false);
  });
});

describe("normalizeStatFamily", () => {
  it("maps per-source vocab to canonical families, combos before singles", () => {
    expect(normalizeStatFamily("Points, Assists & Rebounds O/U")).toBe("pra");
    expect(normalizeStatFamily("Points & Rebounds O/U")).toBe("pr");
    expect(normalizeStatFamily("Points & Assists O/U")).toBe("pa");
    expect(normalizeStatFamily("Assists & Rebounds O/U")).toBe("ra");
    expect(normalizeStatFamily("Steals & Blocks O/U")).toBe("steals-blocks");
    expect(normalizeStatFamily("Field Goals Made O/U")).toBe("fg");
    expect(normalizeStatFamily("Player Threes Milestones")).toBe("threes");
    expect(normalizeStatFamily("Player Points Milestones")).toBe("points");
    expect(normalizeStatFamily("points")).toBe("points");
    expect(normalizeStatFamily("rebounds")).toBe("rebounds");
    expect(normalizeStatFamily("double-double")).toBe("double-double");
    expect(normalizeStatFamily("Triple Double")).toBe("triple-double");
    expect(normalizeStatFamily("points-leader")).toBe("points-leader");
    expect(normalizeStatFamily("Player First Basket")).toBe("first-basket");
    expect(normalizeStatFamily("Spaghetti Market")).toBe("other");
  });
});

describe("PBP name matching", () => {
  it("matches initial + last within a roster, returns null on ambiguity", () => {
    const roster = ["cade-cunningham", "tobias-harris", "kelly-oubre-jr"];
    expect(matchPbpNameToParticipant("C. Cunningham", roster)).toBe(
      "cade-cunningham"
    );
    expect(matchPbpNameToParticipant("K. Oubre", roster)).toBe(
      "kelly-oubre-jr"
    );
    expect(matchPbpNameToParticipant("Z. Nobody", roster)).toBeNull();
    expect(
      matchPbpNameToParticipant("C. Cunningham", [
        "cade-cunningham",
        "cole-cunningham",
      ])
    ).toBeNull();
  });
});

describe("PBP stat reconstruction", () => {
  const actions = [
    {
      actionType: "3pt",
      description: "D. Jenkins 3PT  (3 PTS) (C. Cunningham 1 AST)",
    },
    {
      actionType: "2pt",
      description: "D. Jenkins 20' running Jump Shot (5 PTS) (T. Harris 1 AST)",
    },
    {
      actionType: "2pt",
      description: "MISS J. Harden 7' driving floating Shot - blocked",
    },
    { actionType: "rebound", description: "D. Wade REBOUND (Off:0 Def:1)" },
    { actionType: "block", description: "E. Mobley BLOCK (1 BLK)" },
    { actionType: "steal", description: "C. Cunningham STEAL (1 STL)" },
  ];
  it("reconstructs cumulative points, assists, threes, fg, reb, blk, stl", () => {
    const stats = reconstructStatsFromPbp(actions);
    expect(stats.get("D. Jenkins")).toMatchObject({
      points: 5,
      threes: 1,
      fg: 2,
    });
    expect(stats.get("C. Cunningham")!.assists).toBe(1);
    expect(stats.get("C. Cunningham")!.steals).toBe(1);
    expect(stats.get("T. Harris")!.assists).toBe(1);
    expect(stats.get("D. Wade")!.rebounds).toBe(1);
    expect(stats.get("E. Mobley")!.blocks).toBe(1);
    // missed shot must not count as a made FG
    expect(stats.get("J. Harden")).toBeUndefined();
  });
  it("parses accented names and matches them to ASCII participant keys", () => {
    const stats = reconstructStatsFromPbp([
      {
        actionType: "2pt",
        description: "N. Jokić 9' floating Jump Shot (2 PTS)",
      },
      { actionType: "3pt", description: "L. Dončić 26' 3PT (3 PTS)" },
    ]);
    expect(stats.get("N. Jokić")!.points).toBe(2);
    expect(stats.get("L. Dončić")!.points).toBe(3);
    expect(
      matchPbpNameToParticipant("N. Jokić", ["nikola-jokic", "jamal-murray"])
    ).toBe("nikola-jokic");
  });

  it("statForFamily composes combined families and double-double", () => {
    const line = {
      points: 12,
      rebounds: 11,
      assists: 3,
      threes: 2,
      steals: 1,
      blocks: 0,
      fg: 5,
    };
    expect(statForFamily("pra", line)).toBe(26);
    expect(statForFamily("pr", line)).toBe(23);
    expect(statForFamily("double-double", line)).toBe(1);
    expect(statForFamily("triple-double", line)).toBe(0);
  });
});
