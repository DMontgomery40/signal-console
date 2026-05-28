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
type ObservationNoiseKey = keyof BoardStateSpaceConfig["observationNoise"];
type VarianceKey = keyof BoardStateSpaceConfig["variance"];

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
      readonly section: "observationNoise";
      readonly key: ObservationNoiseKey;
    }
  | {
      readonly section: "variance";
      readonly key: VarianceKey;
    };

export type StateSpaceGuidedGroupId =
  | "trigger"
  | "breadth"
  | "observationModel"
  | "anchors"
  | "dynamics"
  | "observationNoise"
  | "variance";

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
    help: "How fast the latent level, trend, and adaptation terms can move.",
  },
  {
    id: "observationNoise",
    label: "Observation noise",
    help: "How source dominance, agreement, and breadth affect measurement trust.",
  },
  {
    id: "variance",
    label: "Variance regime",
    help: "How strongly surprises lift, preserve, and cool the latent volatility regime.",
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
    id: "dynamics-varianceAdaptationBase",
    groupId: "dynamics",
    section: "dynamics",
    key: "varianceAdaptationBase",
    label: "Regime lift base",
    help: "Base size of the volatility-regime update after a positive surprise.",
    min: 0,
    max: 5,
    step: 0.01,
  },
  {
    id: "dynamics-varianceAdaptationScale",
    groupId: "dynamics",
    section: "dynamics",
    key: "varianceAdaptationScale",
    label: "Regime lift scale",
    help: "How strongly shorter memory horizons amplify regime adaptation.",
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    id: "dynamics-varianceAdaptationOffset",
    groupId: "dynamics",
    section: "dynamics",
    key: "varianceAdaptationOffset",
    label: "Regime lift offset",
    help: "Offset term that softens the memory dependence of regime adaptation.",
    min: 0,
    max: 200,
    step: 1,
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
    id: "dynamics-initialVarianceFloor",
    groupId: "dynamics",
    section: "dynamics",
    key: "initialVarianceFloor",
    label: "Initial regime floor",
    help: "Smallest starting latent variance before the first update arrives.",
    min: 1e-9,
    max: 10,
    step: 0.001,
  },
  {
    id: "observationNoise-floor",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "floor",
    label: "Noise floor",
    help: "Base measurement-noise level before source dominance and agreement adjustments.",
    min: 1e-9,
    max: 5,
    step: 0.001,
  },
  {
    id: "observationNoise-minimum",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "minimum",
    label: "Noise minimum",
    help: "Hard lower bound on measurement noise after all bonuses and penalties.",
    min: 1e-12,
    max: 1,
    step: 1e-6,
  },
  {
    id: "observationNoise-singleSourceDominance",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "singleSourceDominance",
    label: "Single-source dominance",
    help: "Dominance score assumed when only one source is present in a bucket.",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "observationNoise-multiSourceDominanceFallback",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "multiSourceDominanceFallback",
    label: "Multi-source dominance fallback",
    help: "Fallback dominance score used when multiple sources exist but no split is available.",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "observationNoise-sourceDominancePenalty",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "sourceDominancePenalty",
    label: "Single-source penalty",
    help: "How much extra doubt to add when one source dominates the bucket.",
    min: 0,
    max: 10,
    step: 0.05,
    explainerId: "settings-state-space-single-source-penalty",
  },
  {
    id: "observationNoise-sourceAgreementBonus",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "sourceAgreementBonus",
    label: "Cross-source bonus",
    help: "How much to trust the bucket more when multiple sources are moving together.",
    min: 0,
    max: 10,
    step: 0.05,
    explainerId: "settings-state-space-cross-source-bonus",
  },
  {
    id: "observationNoise-sourceCountBonus",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "sourceCountBonus",
    label: "Source-count bonus",
    help: "How much extra trust to add as more independent sources participate.",
    min: 0,
    max: 5,
    step: 0.01,
  },
  {
    id: "observationNoise-sourceCountExponent",
    groupId: "observationNoise",
    section: "observationNoise",
    key: "sourceCountExponent",
    label: "Source-count exponent",
    help: "How aggressively the source-count bonus grows as more sources join the bucket.",
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    id: "variance-madScale",
    groupId: "variance",
    section: "variance",
    key: "madScale",
    label: "MAD scale",
    help: "Scale factor used when robust spreads are converted from MAD space.",
    min: 0.001,
    max: 10,
    step: 0.0001,
  },
  {
    id: "variance-floor",
    groupId: "variance",
    section: "variance",
    key: "floor",
    label: "Variance floor",
    help: "Lowest allowed latent variance for the volatility regime.",
    min: 1e-12,
    max: 10,
    step: 1e-6,
  },
  {
    id: "variance-ceiling",
    groupId: "variance",
    section: "variance",
    key: "ceiling",
    label: "Variance ceiling",
    help: "Highest allowed latent variance before the regime saturates.",
    min: 1e-9,
    max: 100,
    step: 0.01,
  },
  {
    id: "variance-decay",
    groupId: "variance",
    section: "variance",
    key: "decay",
    label: "Regime persistence",
    help: "How slowly the elevated regime decays after a wild stretch.",
    min: 0,
    max: 1,
    step: 0.005,
    explainerId: "settings-state-space-regime-persistence",
  },
  {
    id: "variance-bumpCap",
    groupId: "variance",
    section: "variance",
    key: "bumpCap",
    label: "Regime lift cap",
    help: "Upper cap on how large one surprise can count in the regime-lift math.",
    min: 0.001,
    max: 100,
    step: 0.01,
  },
  {
    id: "variance-bumpCenter",
    groupId: "variance",
    section: "variance",
    key: "bumpCenter",
    label: "Regime lift threshold",
    help: "How big a standardized surprise must be before the model raises its internal volatility regime.",
    min: 0,
    max: 20,
    step: 0.1,
    explainerId: "settings-state-space-regime-lift-threshold",
  },
  {
    id: "variance-innovationPower",
    groupId: "variance",
    section: "variance",
    key: "innovationPower",
    label: "Regime lift power",
    help: "How sharply larger surprises count more than smaller ones when lifting the regime.",
    min: 0.25,
    max: 4,
    step: 0.01,
  },
  {
    id: "variance-agreementBase",
    groupId: "variance",
    section: "variance",
    key: "agreementBase",
    label: "Agreement base",
    help: "Base multiplier on regime lift before cross-source agreement adds more weight.",
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    id: "variance-agreementScale",
    groupId: "variance",
    section: "variance",
    key: "agreementScale",
    label: "Agreement scale",
    help: "How much source agreement amplifies the volatility-regime update.",
    min: 0,
    max: 10,
    step: 0.01,
  },
  {
    id: "variance-baselineMadFloor",
    groupId: "variance",
    section: "variance",
    key: "baselineMadFloor",
    label: "Baseline MAD floor",
    help: "Lower bound used when translating the filter threshold back into an intensity-space MAD line.",
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
    case "observationNoise":
      return config.observationNoise[field.key];
    case "variance":
      return config.variance[field.key];
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
    case "observationNoise":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        observationNoise: { ...config.observationNoise, [field.key]: nextValue },
      });
    case "variance":
      return BoardStateSpaceConfigSchema.parse({
        ...config,
        variance: { ...config.variance, [field.key]: nextValue },
      });
  }
  throw new Error("Unhandled state-space field");
}
