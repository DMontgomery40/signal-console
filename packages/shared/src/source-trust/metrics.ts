/**
 * Pure, side-effect-free metric helpers for the Universal Source Trust report.
 *
 * These are the honesty-critical pieces of the report: probability scoring,
 * deterministic settlement of game markets and player props, period-market
 * detection, stat-family normalization, and play-by-play stat reconstruction.
 * They are intentionally NOT exported from the package index, so they never
 * enter the runtime bundle; they exist to be unit-tested and reused by the
 * offline report builder (`scripts/build_universal_source_trust_report.ts`).
 */

export type SettledSample = {
  /** clamped implied probability the source assigned to the YES side */
  p: number;
  /** realized outcome of the YES side: 1 if it happened, 0 otherwise */
  actual: 0 | 1;
};

export type SettledSummary = {
  n: number;
  brier: number | null;
  logLoss: number | null;
  /** fraction where argmax(p,1-p) matched the realized side */
  accuracy: number | null;
  calibrationSlope: number | null;
  calibrationIntercept: number | null;
  meanProb: number | null;
  meanActual: number | null;
};

export function clampProbability(
  value: number | null | undefined
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return 0.0001;
  if (value >= 1) return 0.9999;
  return value;
}

/** Aggregate Brier / log-loss / accuracy / OLS calibration over settled samples. */
export function summarizeSettled(samples: SettledSample[]): SettledSummary {
  const n = samples.length;
  if (n === 0) {
    return {
      n: 0,
      brier: null,
      logLoss: null,
      accuracy: null,
      calibrationSlope: null,
      calibrationIntercept: null,
      meanProb: null,
      meanActual: null,
    };
  }
  let brierSum = 0;
  let logLossSum = 0;
  let correct = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const { p, actual } of samples) {
    brierSum += (p - actual) ** 2;
    logLossSum -= actual * Math.log(p) + (1 - actual) * Math.log(1 - p);
    if ((p >= 0.5 ? 1 : 0) === actual) correct += 1;
    sumX += p;
    sumY += actual;
    sumXX += p * p;
    sumXY += p * actual;
  }
  let slope: number | null = null;
  let intercept: number | null = null;
  if (n >= 10) {
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) > 1e-9) {
      slope = (n * sumXY - sumX * sumY) / denom;
      intercept = (sumY - slope * sumX) / n;
    }
  }
  return {
    n,
    brier: brierSum / n,
    logLoss: logLossSum / n,
    accuracy: correct / n,
    calibrationSlope: slope,
    calibrationIntercept: intercept,
    meanProb: sumX / n,
    meanActual: sumY / n,
  };
}

// --------------------------------------------------------------------------
// Deterministic settlement (from persisted final scores / reconstructed stats)
// --------------------------------------------------------------------------

export type Settlement = { actual: 0 | 1; push: boolean } | null;

/** Moneyline: did `participantKey` win? */
export function settleMoneyline(
  participantKey: string | null,
  winnerKey: string | null
): Settlement {
  if (participantKey == null || winnerKey == null) return null;
  return { actual: participantKey === winnerKey ? 1 : 0, push: false };
}

/**
 * Spread: does `participantKey` cover `line`?
 *
 * Two persisted encodings, distinguished by display label:
 *  - Signed handicap (bet365/polymarket: "Spurs -1.5", "Wolves +1.5"): line is
 *    signed; cover when (teamMargin + line) > 0; push at == 0.
 *  - Margin threshold (kalshi: "Detroit wins by over 16.5 points?"): line is a
 *    positive margin threshold; YES when teamMargin > line (or < line for the
 *    "wins by under" variant); push at == line.
 *
 * Treating a kalshi margin-threshold as a signed handicap silently inverts the
 * outcome for large lines, so the encoding must be detected, not assumed.
 */
export function settleSpread(args: {
  participantKey: string | null;
  line: number | null;
  homeKey: string | null;
  awayKey: string | null;
  finalHome: number | null;
  finalAway: number | null;
  displayLabel?: string | null;
}): Settlement {
  const { participantKey, line, homeKey, awayKey, finalHome, finalAway } = args;
  if (
    participantKey == null ||
    line == null ||
    finalHome == null ||
    finalAway == null
  ) {
    return null;
  }
  let teamMargin: number;
  if (participantKey === homeKey) teamMargin = finalHome - finalAway;
  else if (participantKey === awayKey) teamMargin = finalAway - finalHome;
  else return null;

  const label = (args.displayLabel ?? "").toLowerCase();
  if (label.includes("wins by over") || label.includes("wins by under")) {
    if (teamMargin === line) return { actual: 0, push: true };
    const over = teamMargin > line;
    if (label.includes("wins by under"))
      return { actual: over ? 0 : 1, push: false };
    return { actual: over ? 1 : 0, push: false };
  }

  const adjusted = teamMargin + line;
  if (adjusted === 0) return { actual: 0, push: true };
  return { actual: adjusted > 0 ? 1 : 0, push: false };
}

/** Total: over/under `line` against the realized total. */
export function settleTotal(args: {
  selection: string | null;
  line: number | null;
  finalTotal: number | null;
}): Settlement {
  const { selection, line, finalTotal } = args;
  if (selection == null || line == null || finalTotal == null) return null;
  const sel = selection.toLowerCase();
  if (finalTotal === line) return { actual: 0, push: true };
  const over = finalTotal > line;
  if (sel === "over") return { actual: over ? 1 : 0, push: false };
  if (sel === "under") return { actual: over ? 0 : 1, push: false };
  return null;
}

/**
 * Player/team stat O/U-or-threshold settlement against a reconstructed stat.
 * over/under use strict comparison with a push at equality (integer lines);
 * yes/no (milestones, double/triple-double) use >= threshold with no push.
 */
export function settleStatLine(args: {
  selection: string | null;
  line: number | null;
  stat: number | null;
}): Settlement {
  const { selection, line, stat } = args;
  if (selection == null || line == null || stat == null) return null;
  const sel = selection.toLowerCase();
  if (sel === "over") {
    if (stat === line) return { actual: 0, push: true };
    return { actual: stat > line ? 1 : 0, push: false };
  }
  if (sel === "under") {
    if (stat === line) return { actual: 0, push: true };
    return { actual: stat < line ? 1 : 0, push: false };
  }
  if (sel === "yes") return { actual: stat >= line ? 1 : 0, push: false };
  if (sel === "no") return { actual: stat < line ? 1 : 0, push: false };
  return null;
}

// --------------------------------------------------------------------------
// Period / full-game detection
// --------------------------------------------------------------------------

const PERIOD_LABEL =
  /\b(1H|2H|1Q|2Q|3Q|4Q|Q1|Q2|Q3|Q4|OT|[0-9]OT|quarter|half|overtime)\b/i;

/** True when the display label denotes a period/half/quarter/OT sub-market. */
export function isPeriodMarket(
  displayLabel: string | null | undefined
): boolean {
  if (!displayLabel) return false;
  return PERIOD_LABEL.test(displayLabel);
}

// --------------------------------------------------------------------------
// Player-prop stat-family normalization (messy per-source vocab -> canonical)
// --------------------------------------------------------------------------

export type StatFamily =
  | "points"
  | "rebounds"
  | "assists"
  | "threes"
  | "steals"
  | "blocks"
  | "fg"
  | "pra"
  | "pr"
  | "pa"
  | "ra"
  | "steals-blocks"
  | "double-double"
  | "triple-double"
  | "points-leader"
  | "first-basket"
  | "first-rebound"
  | "first-assist"
  | "other";

/** Which reconstructed stat a canonical family settles against (null = not settleable from PBP). */
export const SETTLEABLE_FAMILIES: Record<string, true> = {
  points: true,
  rebounds: true,
  assists: true,
  threes: true,
  steals: true,
  blocks: true,
  fg: true,
  pra: true,
  pr: true,
  pa: true,
  ra: true,
  "steals-blocks": true,
  "double-double": true,
  "triple-double": true,
  "points-leader": true,
};

/** Normalize a source's raw_family (and optional raw_label) to a canonical stat family. */
export function normalizeStatFamily(
  rawFamily: string | null | undefined,
  rawLabel?: string | null
): StatFamily {
  const t = `${rawFamily ?? ""} ${rawLabel ?? ""}`.toLowerCase();
  const has = (s: string) => t.includes(s);
  // most-specific combinations first
  if (has("triple double") || has("triple-double")) return "triple-double";
  if (has("double double") || has("double-double")) return "double-double";
  if ((has("point") && has("assist") && has("rebound")) || has("pra")) {
    return "pra";
  }
  if (has("point") && has("rebound")) return "pr";
  if (has("point") && has("assist")) return "pa";
  if (has("assist") && has("rebound")) return "ra";
  if (has("steal") && has("block")) return "steals-blocks";
  if (has("field goal")) return "fg";
  if (has("three")) return "threes";
  if (has("points-leader") || has("points leader")) return "points-leader";
  if (has("first rebound")) return "first-rebound";
  if (has("first assist")) return "first-assist";
  if (has("first basket")) return "first-basket";
  if (has("point")) return "points";
  if (has("rebound")) return "rebounds";
  if (has("assist")) return "assists";
  if (has("steal")) return "steals";
  if (has("block")) return "blocks";
  return "other";
}

// --------------------------------------------------------------------------
// Play-by-play final-stat reconstruction
// --------------------------------------------------------------------------

/** Player-name token pattern, Unicode-aware so "N. Jokić", "L. Dončić" parse. */
const NAME = "[\\p{L}\\p{M}'.\\-]";

/** Strip diacritics so PBP "Jokić" matches the ASCII participant_key "jokic". */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

export type PbpStatLine = {
  points: number;
  rebounds: number;
  assists: number;
  threes: number;
  steals: number;
  blocks: number;
  fg: number; // made field goals (2pt + 3pt)
};

export function emptyStatLine(): PbpStatLine {
  return {
    points: 0,
    rebounds: 0,
    assists: 0,
    threes: 0,
    steals: 0,
    blocks: 0,
    fg: 0,
  };
}

/** "C. Cunningham" -> { initial: "c", last: "cunningham" } for in-roster matching. */
export function splitPbpName(
  name: string
): { initial: string; last: string } | null {
  const m = name.trim().match(/^(\p{L})\.?\s+(.+)$/u);
  if (!m) return null;
  return {
    initial: stripDiacritics(m[1]).toLowerCase(),
    last: stripDiacritics(m[2].trim()).toLowerCase(),
  };
}

/**
 * Match a PBP-style abbreviated name ("C. Cunningham") to a participant_key
 * ("cade-cunningham") drawn from the game's own prop roster. Constrained to the
 * candidate set so first-initial + last-name is reliable; returns null on
 * ambiguity (>1 candidate) or no match.
 */
export function matchPbpNameToParticipant(
  pbpName: string,
  candidateKeys: string[]
): string | null {
  const parsed = splitPbpName(pbpName);
  if (!parsed) return null;
  const matches: string[] = [];
  for (const key of candidateKeys) {
    const parts = key.toLowerCase().split("-");
    if (parts.length < 2) continue;
    const first = parts[0];
    const last = parts.slice(1).join("-").replace(/-/g, " ");
    const lastNoSuffix = last.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "").trim();
    const candLast = parsed.last.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "").trim();
    if (
      first.startsWith(parsed.initial) &&
      (lastNoSuffix === candLast || last === parsed.last)
    ) {
      matches.push(key);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Reconstruct per-player final stats from one game's PBP action descriptions.
 * Points/assists come from cumulative "(N PTS)" / "(N AST)" tallies (max seen);
 * rebounds from cumulative "(Off:x Def:y)"; threes/fg/steals/blocks by counting
 * attributed made-shot / steal / block actions. Keyed by raw PBP name.
 */
export function reconstructStatsFromPbp(
  actions: Array<{ actionType: string | null; description: string | null }>
): Map<string, PbpStatLine> {
  const stats = new Map<string, PbpStatLine>();
  const get = (name: string) => {
    let s = stats.get(name);
    if (!s) {
      s = emptyStatLine();
      stats.set(name, s);
    }
    return s;
  };
  const leadName = (desc: string): string | null => {
    const m = desc.match(new RegExp(`^(\\p{L}\\.?\\s+${NAME}+?)(?=\\s)`, "u"));
    return m ? m[1].trim() : null;
  };

  for (const { actionType, description } of actions) {
    if (!description) continue;
    const desc = description;

    // cumulative points for the scorer
    const ptsM = desc.match(
      new RegExp(`^(\\p{L}\\.?\\s+${NAME}+?)\\s.*\\((\\d+)\\s+PTS\\)`, "u")
    );
    if (ptsM) {
      const s = get(ptsM[1].trim());
      s.points = Math.max(s.points, Number(ptsM[2]));
    }
    // cumulative assists for the assister (appears in trailing paren group)
    const astM = desc.match(
      new RegExp(`\\((\\p{L}\\.?\\s+${NAME}+?)\\s+(\\d+)\\s+AST\\)`, "u")
    );
    if (astM) {
      const s = get(astM[1].trim());
      s.assists = Math.max(s.assists, Number(astM[2]));
    }
    // cumulative rebounds "(Off:x Def:y)"
    const rebM = desc.match(/\(Off:(\d+)\s+Def:(\d+)\)/);
    if (rebM && actionType === "rebound") {
      const name = leadName(desc);
      if (name) {
        const s = get(name);
        s.rebounds = Math.max(s.rebounds, Number(rebM[1]) + Number(rebM[2]));
      }
    }
    // made shots (not MISS) -> fg, and threes
    const isMiss = /^MISS\b/i.test(desc) || /\bMISS\b/.test(desc.slice(0, 20));
    if (!isMiss && (actionType === "2pt" || actionType === "3pt")) {
      const name = leadName(desc);
      if (name) {
        const s = get(name);
        s.fg += 1;
        if (actionType === "3pt") s.threes += 1;
      }
    }
    if (actionType === "steal") {
      // "... STEAL (X.Lastname N STL)" or steal credited to leading name
      const stlM = desc.match(
        new RegExp(`\\((\\p{L}\\.?\\s+${NAME}+?)\\s+(\\d+)\\s+STL\\)`, "u")
      );
      if (stlM) {
        const s = get(stlM[1].trim());
        s.steals = Math.max(s.steals, Number(stlM[2]));
      } else {
        const name = leadName(desc);
        if (name) get(name).steals += 1;
      }
    }
    if (actionType === "block") {
      const blkM = desc.match(
        new RegExp(`\\((\\p{L}\\.?\\s+${NAME}+?)\\s+(\\d+)\\s+BLK\\)`, "u")
      );
      if (blkM) {
        const s = get(blkM[1].trim());
        s.blocks = Math.max(s.blocks, Number(blkM[2]));
      } else {
        const name = leadName(desc);
        if (name) get(name).blocks += 1;
      }
    }
  }
  return stats;
}

/** Combined-stat value for a canonical family from a reconstructed stat line. */
export function statForFamily(
  family: StatFamily,
  line: PbpStatLine
): number | null {
  switch (family) {
    case "points":
      return line.points;
    case "rebounds":
      return line.rebounds;
    case "assists":
      return line.assists;
    case "threes":
      return line.threes;
    case "steals":
      return line.steals;
    case "blocks":
      return line.blocks;
    case "fg":
      return line.fg;
    case "pra":
      return line.points + line.rebounds + line.assists;
    case "pr":
      return line.points + line.rebounds;
    case "pa":
      return line.points + line.assists;
    case "ra":
      return line.rebounds + line.assists;
    case "steals-blocks":
      return line.steals + line.blocks;
    case "double-double":
      return doubleTripleCount(line) >= 2 ? 1 : 0;
    case "triple-double":
      return doubleTripleCount(line) >= 3 ? 1 : 0;
    default:
      return null;
  }
}

function doubleTripleCount(line: PbpStatLine): number {
  return [
    line.points,
    line.rebounds,
    line.assists,
    line.steals,
    line.blocks,
  ].filter((v) => v >= 10).length;
}
