import {
  BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  BoardStateSpaceConfigSchema,
  type BoardStateSpaceConfig,
} from "@signal-console/detectors/board-mad/state-space-config";
import type { ExplainerId } from "@signal-console/ui";

type TriggerKey = keyof BoardStateSpaceConfig["trigger"];
type BreadthKey = keyof BoardStateSpaceConfig["breadth"];
type ObservationModelKey = keyof BoardStateSpaceConfig["observationModel"];
type AnchorKey = keyof BoardStateSpaceConfig["anchors"];
type DynamicsKey = keyof BoardStateSpaceConfig["dynamics"];
type SourceTrustKey = keyof BoardStateSpaceConfig["sourceTrust"];
type ScaleKey = keyof BoardStateSpaceConfig["scale"];

type StateSpaceField =
  | {
      readonly section: "trigger";
      readonly key: TriggerKey;
    }
  | {
      readonly section: "breadth";
      readonly key: BreadthKey;
    }
  | {
      readonly section: "observationModel";
      readonly key: ObservationModelKey;
    }
  | {
      readonly section: "anchors";
      readonly key: AnchorKey;
    }
  | {
      readonly section: "dynamics";
      readonly key: DynamicsKey;
    }
  | {
      readonly section: "sourceTrust";
      readonly key: SourceTrustKey;
    }
  | {
      readonly section: "scale";
      readonly key: ScaleKey;
    };

export type StateSpaceGuidedGroupId =
  | "trigger"
  | "breadth"
  | "observationModel"
  | "anchors"
  | "dynamics"
  | "sourceTrust"
  | "scale";

export type StateSpaceGuidedFieldDef = StateSpaceField & {
  readonly id: string;
  readonly groupId: StateSpaceGuidedGroupId;
  readonly label: string;
  readonly help: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly explainerId?: ExplainerId;
};

export const STATE_SPACE_GUIDED_GROUPS: ReadonlyArray<{
  readonly id: StateSpaceGuidedGroupId;
  readonly label: string;
  readonly help: string;
}> = [
  {
    id: "trigger",
    label: "Triggering",
    help: "Entry and exit gates for whole-board alerts.",
  },
  {
    id: "breadth",
    label: "Breadth",
    help: "How raw intensity is normalized when many markets are active.",
  },
  {
    id: "observationModel",
    label: "Observation embedding",
    help: "How extra market-state features such as cross-source disagreement enter the observed volatility score.",
  },
  {
    id: "anchors",
    label: "Anchors",
    help: "Floors and precision guards for historical, opening, and wall-clock anchors.",
  },
  {
    id: "dynamics",
    label: "State dynamics",
    help: "How fast the latent baseline level and short-term trend can move.",
  },
  {
    id: "sourceTrust",
    label: "Source trust",
    help: "How source dominance, agreement, and count make a bucket harder or easier to fire.",
  },
  {
    id: "scale",
    label: "Surprise scale",
    help: "The robust trailing dispersion of the board's own moves that a new bucket is judged against.",
  },
];

export const STATE_SPACE_GUIDED_FIELDS: ReadonlyArray<StateSpaceGuidedFieldDef> = [
  {
    id: "trigger-enterOffset",
    groupId: "trigger",
    section: "trigger",
    key: "enterOffset",
    label: "Trigger floor",
    help: "Base surprise needed before the K dial even starts to matter.",
    min: 0,
    max: 5,
    step: 0.05,
    explainerId: "settings-state-space-trigger-floor",
  },
  {
    id: "trigger-enterKScale",
    groupId: "trigger",
    section: "trigger",
    key: "enterKScale",
    label: "Sensitivity slope",
    help: "How strongly the K dial raises or lowers the entry gate.",
    min: 0,
    max: 2,
    step: 0.01,
    explainerId: "settings-state-space-sensitivity-slope",
  },
  {
    id: "trigger-exitFloor",
    groupId: "trigger",
    section: "trigger",
    key: "exitFloor",
    label: "Release floor",
    help: "Minimum surprise level required before an active alert can reset.",
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    id: "trigger-exitRatio",
    groupId: "trigger",
    section: "trigger",
    key: "exitRatio",
    label: "Release ratio",
    help: "Lower values keep the alert active longer after a spike; higher values reset faster.",
    min: 0,
    max: 1,
    step: 0.01,
    explainerId: "settings-state-space-release-ratio",
  },
  {
    id: "breadth-marketCountFloor",
    groupId: "breadth",
    section: "breadth",
    key: "marketCountFloor",
    label: "Market-count floor",
    help: "Minimum active-market count used when normalizing board intensity.",
    min: 1,
    max: 100,
    step: 1,
  },
  {
    id: "breadth-marketCountExponent",
    groupId: "breadth",
    section: "breadth",
    key: "marketCountExponent",
    label: "Breadth damping",
    help: "How much to normalize raw intensity when many markets are moving at once.",
    min: 0,
    max: 1,
    step: 0.01,
    explainerId: "settings-state-space-breadth-damping",
  },
  {
    id: "observationModel-disagreementWeight",
    groupId: "observationModel",
    section: "observationModel",
    key: "disagreementWeight",
    label: "Disagreement weight",
    help: "How strongly cross-source directional disagreement adds to the observed volatility score before filtering.",
    min: 0,
    max: 2,
    step: 0.01,
    explainerId: "settings-state-space-disagreement-weight",
  },
  {
    id: "anchors-priorScaleFallback",
    groupId: "anchors",
    section: "anchors",
    key: "priorScaleFallback",
    label: "Prior-scale fallback",
    help: "Default anchor scale when no historical prior exists yet.",
    min: 0.001,
    max: 5,
    step: 0.001,
  },
  {
    id: "anchors-priorScaleFloor",
    groupId: "anchors",
    section: "anchors",
    key: "priorScaleFloor",
    label: "Prior-scale floor",
    help: "Lower bound on the historical prior scale before precision weighting.",
    min: 1e-9,
    max: 5,
    step: 1e-6,
  },
  {
    id: "anchors-anchorScaleFloor",
    groupId: "anchors",
    section: "anchors",
    key: "anchorScaleFloor",
    label: "Anchor-scale floor",
    help: "Minimum robust spread for opening, game-clock, and wall-clock anchors.",
    min: 1e-9,
    max: 5,
    step: 1e-6,
  },
  {
    id: "anchors-precisionVarianceFloor",
    groupId: "anchors",
    section: "anchors",
    key: "precisionVarianceFloor",
    label: "Precision floor",
    help: "Smallest allowed variance when anchors and the latent state are precision-combined.",
    min: 1e-12,
    max: 1,
    step: 1e-9,
  },
  {
    id: "dynamics-minMemoryBuckets",
    groupId: "dynamics",
    section: "dynamics",
    key: "minMemoryBuckets",
    label: "Minimum memory buckets",
    help: "Hard floor on the memory horizon after bucket sizing and profile math.",
    min: 1,
    max: 20,
    step: 1,
  },
  {
    id: "dynamics-trendDecayNumerator",
    groupId: "dynamics",
    section: "dynamics",
    key: "trendDecayNumerator",
    label: "Trend decay numerator",
    help: "How quickly the latent trend fades as memory lengthens.",
    min: 0.01,
    max: 10,
    step: 0.01,
  },
  {
    id: "dynamics-levelProcessNoiseBase",
    groupId: "dynamics",
    section: "dynamics",
    key: "levelProcessNoiseBase",
    label: "Baseline agility",
    help: "How quickly the baseline level is allowed to move when the whole game changes character.",
    min: 0,
    max: 1,
    step: 0.005,
    explainerId: "settings-state-space-baseline-agility",
  },
  {
    id: "dynamics-levelProcessNoiseScale",
    groupId: "dynamics",
    section: "dynamics",
    key: "levelProcessNoiseScale",
    label: "Memory noise scale",
    help: "Extra level-state process noise that shrinks as memory gets longer.",
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    id: "dynamics-trendProcessNoiseRatio",
    groupId: "dynamics",
    section: "dynamics",
    key: "trendProcessNoiseRatio",
    label: "Trend-noise ratio",
    help: "How much process noise the trend state gets relative to the level state.",
    min: 0,
    max: 5,
    step: 0.01,
  },
  {
    id: "dynamics-initialLevelVariance",
    groupId: "dynamics",
    section: "dynamics",
    key: "initialLevelVariance",
    label: "Initial level variance",
    help: "Starting uncertainty on the hidden baseline level before the game takes over.",
    min: 1e-9,
    max: 100,
    step: 0.01,
  },
  {
    id: "dynamics-initialTrendVariance",
    groupId: "dynamics",
    section: "dynamics",
    key: "initialTrendVariance",
    label: "Initial trend variance",
    help: "Starting uncertainty on the hidden trend state.",
    min: 1e-9,
    max: 100,
    step: 0.01,
  },
  {
    id: "sourceTrust-minMultiplier",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "minMultiplier",
    label: "Max trust (scale floor)",
    help: "Most a fully-agreeing multi-source bucket can shrink the surprise scale (easiest to fire).",
    min: 0.05,
    max: 1,
    step: 0.01,
  },
  {
    id: "sourceTrust-maxMultiplier",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "maxMultiplier",
    label: "Max distrust (scale cap)",
    help: "Most a single-book-dominated bucket can inflate the surprise scale (hardest to fire).",
    min: 1,
    max: 10,
    step: 0.05,
  },
  {
    id: "sourceTrust-singleSourceDominance",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "singleSourceDominance",
    label: "Single-source dominance",
    help: "Dominance score assumed when only one source is present in a bucket.",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "sourceTrust-multiSourceDominanceFallback",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "multiSourceDominanceFallback",
    label: "Multi-source dominance fallback",
    help: "Fallback dominance score used when multiple sources exist but no split is available.",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "sourceTrust-sourceDominancePenalty",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "sourceDominancePenalty",
    label: "Single-source penalty",
    help: "How much a dominant single book inflates the surprise scale (harder to fire).",
    min: 0,
    max: 10,
    step: 0.05,
    explainerId: "settings-state-space-single-source-penalty",
  },
  {
    id: "sourceTrust-sourceAgreementBonus",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "sourceAgreementBonus",
    label: "Cross-source bonus",
    help: "How much agreeing sources shrink the surprise scale (easier to fire) when they move together.",
    min: 0,
    max: 10,
    step: 0.05,
    explainerId: "settings-state-space-cross-source-bonus",
  },
  {
    id: "sourceTrust-sourceCountBonus",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "sourceCountBonus",
    label: "Source-count bonus",
    help: "How much extra trust to add as more independent sources participate.",
    min: 0,
    max: 5,
    step: 0.01,
  },
  {
    id: "sourceTrust-sourceCountExponent",
    groupId: "sourceTrust",
    section: "sourceTrust",
    key: "sourceCountExponent",
    label: "Source-count exponent",
    help: "How aggressively the source-count bonus grows as more sources join the bucket.",
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    id: "scale-madScale",
    groupId: "scale",
    section: "scale",
    key: "madScale",
    label: "MAD scale",
    help: "Multiplier turning the robust MAD of recent innovations into a surprise scale (1.4826 ≈ Gaussian SD).",
    min: 0.001,
    max: 10,
    step: 0.0001,
    explainerId: "settings-state-space-surprise-scale",
  },
  {
    id: "scale-scaleFloor",
    groupId: "scale",
    section: "scale",
    key: "scaleFloor",
    label: "Scale floor",
    help: "Smallest allowed surprise scale, so a near-flat stretch cannot make tiny moves look huge.",
    min: 1e-6,
    max: 5,
    step: 0.001,
    explainerId: "settings-state-space-scale-bounds",
  },
  {
    id: "scale-scaleCeiling",
    groupId: "scale",
    section: "scale",
    key: "scaleCeiling",
    label: "Scale ceiling",
    help: "Largest allowed surprise scale, so sustained chaos still lets a genuine relative outlier through.",
    min: 1e-3,
    max: 100,
    step: 0.01,
    explainerId: "settings-state-space-scale-bounds",
  },
  {
    id: "scale-baselineSpreadFloor",
    groupId: "scale",
    section: "scale",
    key: "baselineSpreadFloor",
    label: "Baseline spread floor",
    help: "Lower bound on the displayed intensity-space baseline spread used to draw the threshold line.",
    min: 1e-12,
    max: 1,
    step: 1e-9,
  },
];

export function readStateSpaceFieldValue(
  config: BoardStateSpaceConfig,
  field: StateSpaceGuidedFieldDef,
): number {
  switch (field.section) {
    case "trigger":
      return config.trigger[field.key];
    case "breadth":
      return config.breadth[field.key];
    case "observationModel":
      return config.observationModel[field.key];
    case "anchors":
      return config.anchors[field.key];
    case "dynamics":
      return config.dynamics[field.key];
    case "sourceTrust":
      return config.sourceTrust[field.key];
    case "scale":
      return config.scale[field.key];
  }
  throw new Error("Unhandled state-space field");
}

export function defaultStateSpaceFieldValue(field: StateSpaceGuidedFieldDef): number {
  return readStateSpaceFieldValue(BOARD_STATE_SPACE_CONFIG_DEFAULTS, field);
}

export function writeStateSpaceFieldValue(
  config: BoardStateSpaceConfig,
  field: StateSpaceGuidedFieldDef,
  nextValue: number,
): BoardStateSpaceConfig {
  switch (field.section) {
    case "trigger":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        trigger: { ...config.trigger, [field.key]: nextValue },
      });
    case "breadth":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        breadth: { ...config.breadth, [field.key]: nextValue },
      });
    case "observationModel":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        observationModel: { ...config.observationModel, [field.key]: nextValue },
      });
    case "anchors":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        anchors: { ...config.anchors, [field.key]: nextValue },
      });
    case "dynamics":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        dynamics: { ...config.dynamics, [field.key]: nextValue },
      });
    case "sourceTrust":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        sourceTrust: { ...config.sourceTrust, [field.key]: nextValue },
      });
    case "scale":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        scale: { ...config.scale, [field.key]: nextValue },
      });
  }
  throw new Error("Unhandled state-space field");
}
