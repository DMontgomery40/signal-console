import {
  BOARD_STATE_SPACE_CONFIG_DEFAULTS,
  BoardStateSpaceConfigSchema,
  type BoardStateSpaceConfig,
} from "@signal-console/detectors/board-mad/state-space-config";
import type { ExplainerId } from "@signal-console/ui";

type TriggerKey = keyof BoardStateSpaceConfig["trigger"];
type BreadthKey = keyof BoardStateSpaceConfig["breadth"];
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

export type StateSpaceGuidedGroupId = "trigger" | "adaptation" | "sources";

export type StateSpaceGuidedFieldDef = StateSpaceField & {
  readonly id: string;
  readonly groupId: StateSpaceGuidedGroupId;
  readonly label: string;
  readonly help: string;
  readonly explainerId: ExplainerId;
  readonly min: number;
  readonly max: number;
  readonly step: number;
};

export const STATE_SPACE_GUIDED_GROUPS: ReadonlyArray<{
  readonly id: StateSpaceGuidedGroupId;
  readonly label: string;
  readonly help: string;
}> = [
  {
    id: "trigger",
    label: "Triggering",
    help: "How hard it is to enter and leave a board-volatility alert.",
  },
  {
    id: "adaptation",
    label: "Baseline + regime",
    help: "How fast the latent baseline and volatility regime adapt after a real burst.",
  },
  {
    id: "sources",
    label: "Breadth + source trust",
    help: "How much to discount one-market or one-source moves and reward broader agreement.",
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
    explainerId: "settings-state-space-trigger-floor",
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    id: "trigger-enterKScale",
    groupId: "trigger",
    section: "trigger",
    key: "enterKScale",
    label: "Sensitivity slope",
    help: "How strongly the K dial raises or lowers the entry gate.",
    explainerId: "settings-state-space-sensitivity-slope",
    min: 0,
    max: 2,
    step: 0.01,
  },
  {
    id: "trigger-exitRatio",
    groupId: "trigger",
    section: "trigger",
    key: "exitRatio",
    label: "Release ratio",
    help: "Lower values keep the alert active longer after a spike; higher values reset faster.",
    explainerId: "settings-state-space-release-ratio",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "dynamics-levelProcessNoiseBase",
    groupId: "adaptation",
    section: "dynamics",
    key: "levelProcessNoiseBase",
    label: "Baseline agility",
    help: "How quickly the baseline level is allowed to move when the whole game changes character.",
    explainerId: "settings-state-space-baseline-agility",
    min: 0,
    max: 1,
    step: 0.005,
  },
  {
    id: "variance-bumpCenter",
    groupId: "adaptation",
    section: "variance",
    key: "bumpCenter",
    label: "Regime lift threshold",
    help: "How big a standardized surprise must be before the model raises its internal volatility regime.",
    explainerId: "settings-state-space-regime-lift-threshold",
    min: 0,
    max: 20,
    step: 0.1,
  },
  {
    id: "variance-decay",
    groupId: "adaptation",
    section: "variance",
    key: "decay",
    label: "Regime persistence",
    help: "How slowly the elevated regime decays after a wild stretch.",
    explainerId: "settings-state-space-regime-persistence",
    min: 0,
    max: 1,
    step: 0.005,
  },
  {
    id: "breadth-marketCountExponent",
    groupId: "sources",
    section: "breadth",
    key: "marketCountExponent",
    label: "Breadth damping",
    help: "How much to normalize raw intensity when many markets are moving at once.",
    explainerId: "settings-state-space-breadth-damping",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    id: "observationNoise-sourceDominancePenalty",
    groupId: "sources",
    section: "observationNoise",
    key: "sourceDominancePenalty",
    label: "Single-source penalty",
    help: "How much extra doubt to add when one source dominates the bucket.",
    explainerId: "settings-state-space-single-source-penalty",
    min: 0,
    max: 10,
    step: 0.05,
  },
  {
    id: "observationNoise-sourceAgreementBonus",
    groupId: "sources",
    section: "observationNoise",
    key: "sourceAgreementBonus",
    label: "Cross-source bonus",
    help: "How much to trust the bucket more when multiple sources are moving together.",
    explainerId: "settings-state-space-cross-source-bonus",
    min: 0,
    max: 10,
    step: 0.05,
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
