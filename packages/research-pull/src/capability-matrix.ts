import type { CaptureMode } from "./contract";

/**
 * SOURCE CAPABILITY MATRIX.
 *
 * Three classes describe how a source can be pulled and where its output lives:
 *
 * - `snapshot-eligible`: persisted to the gold DB as canonical research truth
 *   (kalshi, polymarket, bet365, nba).
 * - `artifact-only`: Odds-API.io. A live comparator surface usable for event
 *   discovery / snapshot / updated-delta / live-ws, but NOT a historical
 *   warehouse — its output is an artifact, never canonical gold.
 * - `pending`: draftkings-direct, fanduel-direct. Reachable ONLY via
 *   Odds-API.io today; there is no persisted direct adapter, so a pull resolves
 *   to a pending artifact class and emits no concrete operations.
 */

export const SOURCE_CLASSES = ["snapshot-eligible", "artifact-only", "pending"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/**
 * Planner artifact class. Deliberately distinct from `SourceClass`:
 * `snapshot-eligible` maps to `canonical`, the other two pass through. Keeping
 * two enums + an explicit mapping prevents the "looks like a typo" collapse.
 */
export const ARTIFACT_CLASSES = ["canonical", "artifact_only", "pending"] as const;
export type ArtifactClass = (typeof ARTIFACT_CLASSES)[number];

export type SourceCapability = {
  readonly id: string;
  readonly class: SourceClass;
  /** Capture modes this source can satisfy. */
  readonly supportedModes: readonly CaptureMode[];
  readonly limitations: readonly string[];
};

const ALL_CAPTURE_MODES: readonly CaptureMode[] = ["historical", "repair", "live-capture"];

export const SOURCE_CAPABILITY_MATRIX: readonly SourceCapability[] = [
  {
    id: "kalshi",
    class: "snapshot-eligible",
    supportedModes: ["historical", "repair", "live-capture"],
    limitations: [
      "Direct Kalshi API is the authoritative Kalshi player-prop path; do not substitute Odds-API.io Kalshi coverage.",
    ],
  },
  {
    id: "polymarket",
    class: "snapshot-eligible",
    supportedModes: ["historical", "repair", "live-capture"],
    limitations: [],
  },
  {
    id: "bet365",
    class: "snapshot-eligible",
    supportedModes: ["historical", "repair", "live-capture"],
    limitations: [],
  },
  {
    id: "nba",
    class: "snapshot-eligible",
    supportedModes: ["historical", "repair", "live-capture"],
    limitations: ["NBA sidecar provides game/box state, not sportsbook quotes."],
  },
  {
    id: "odds-api-io",
    class: "artifact-only",
    supportedModes: ["repair", "live-capture"],
    limitations: [
      "Not a historical warehouse: no `historical` capture mode.",
      "Output is an artifact (event discovery / snapshot / updated-delta / live-ws), never persisted as canonical gold.",
      "Kalshi player-prop coverage may lag the direct Kalshi adapter.",
    ],
  },
  {
    id: "draftkings-direct",
    class: "pending",
    supportedModes: [],
    limitations: [
      "Reachable only via Odds-API.io today; no persisted direct adapter.",
      "Resolves to a pending artifact class and emits no concrete operations.",
    ],
  },
  {
    id: "fanduel-direct",
    class: "pending",
    supportedModes: [],
    limitations: [
      "Reachable only via Odds-API.io today; no persisted direct adapter.",
      "Resolves to a pending artifact class and emits no concrete operations.",
    ],
  },
];

const MATRIX_BY_ID = new Map<string, SourceCapability>(
  SOURCE_CAPABILITY_MATRIX.map((row) => [row.id, row]),
);

export function getSourceCapability(id: string): SourceCapability | undefined {
  return MATRIX_BY_ID.get(id);
}

export function isKnownSource(id: string): boolean {
  return MATRIX_BY_ID.has(id);
}

/** snapshot-eligible -> canonical; artifact-only/pending pass through. */
export function classToArtifactClass(sourceClass: SourceClass): ArtifactClass {
  switch (sourceClass) {
    case "snapshot-eligible":
      return "canonical";
    case "artifact-only":
      return "artifact_only";
    case "pending":
      return "pending";
    default: {
      const exhaustive: never = sourceClass;
      return exhaustive;
    }
  }
}

export { ALL_CAPTURE_MODES };
