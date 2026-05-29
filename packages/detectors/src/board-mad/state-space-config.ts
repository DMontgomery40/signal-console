import { z } from "zod";

export const BOARD_STATE_SPACE_CONFIG_DEFAULTS = {
  trigger: {
    enterOffset: 0.9,
    enterKScale: 0.45,
    exitFloor: 0.75,
    exitRatio: 0.7,
  },
  breadth: {
    marketCountFloor: 1,
    marketCountExponent: 0.5,
  },
  observationModel: {
    disagreementWeight: 0.35,
  },
  anchors: {
    priorScaleFallback: 0.2,
    priorScaleFloor: 0.05,
    anchorScaleFloor: 0.05,
    precisionVarianceFloor: 1e-6,
  },
  dynamics: {
    minMemoryBuckets: 2,
    trendDecayNumerator: 1,
    levelProcessNoiseBase: 0.015,
    levelProcessNoiseScale: 0.18,
    trendProcessNoiseRatio: 0.2,
    initialLevelVariance: 1,
    initialTrendVariance: 1,
  },
  sourceTrust: {
    minMultiplier: 0.5,
    maxMultiplier: 2,
    singleSourceDominance: 1,
    multiSourceDominanceFallback: 0.5,
    sourceDominancePenalty: 1.2,
    sourceAgreementBonus: 0.45,
    sourceCountBonus: 0.15,
    sourceCountExponent: 0.5,
  },
  scale: {
    madScale: 1.4826,
    scaleFloor: 0.05,
    scaleCeiling: 4,
    baselineSpreadFloor: 1e-9,
  },
} as const;

export const BoardStateSpaceConfigSchema = z
  .object({
    trigger: z
      .object({
        enterOffset: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger.enterOffset),
        enterKScale: z
          .number()
          .min(0)
          .max(2)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger.enterKScale),
        exitFloor: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger.exitFloor),
        exitRatio: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger.exitRatio),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.trigger),
    breadth: z
      .object({
        marketCountFloor: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.breadth.marketCountFloor),
        marketCountExponent: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.breadth.marketCountExponent),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.breadth),
    observationModel: z
      .object({
        disagreementWeight: z
          .number()
          .min(0)
          .max(2)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationModel.disagreementWeight),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationModel),
    anchors: z
      .object({
        priorScaleFallback: z
          .number()
          .min(0.001)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.anchors.priorScaleFallback),
        priorScaleFloor: z
          .number()
          .min(1e-9)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.anchors.priorScaleFloor),
        anchorScaleFloor: z
          .number()
          .min(1e-9)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.anchors.anchorScaleFloor),
        precisionVarianceFloor: z
          .number()
          .min(1e-12)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.anchors.precisionVarianceFloor),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.anchors),
    dynamics: z
      .object({
        minMemoryBuckets: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.minMemoryBuckets),
        trendDecayNumerator: z
          .number()
          .min(0.01)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.trendDecayNumerator),
        levelProcessNoiseBase: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.levelProcessNoiseBase),
        levelProcessNoiseScale: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.levelProcessNoiseScale),
        trendProcessNoiseRatio: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.trendProcessNoiseRatio),
        initialLevelVariance: z
          .number()
          .min(1e-9)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.initialLevelVariance),
        initialTrendVariance: z
          .number()
          .min(1e-9)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.initialTrendVariance),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics),
    sourceTrust: z
      .object({
        minMultiplier: z
          .number()
          .min(0.05)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.minMultiplier),
        maxMultiplier: z
          .number()
          .min(1)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.maxMultiplier),
        singleSourceDominance: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.singleSourceDominance),
        multiSourceDominanceFallback: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.multiSourceDominanceFallback),
        sourceDominancePenalty: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.sourceDominancePenalty),
        sourceAgreementBonus: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.sourceAgreementBonus),
        sourceCountBonus: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.sourceCountBonus),
        sourceCountExponent: z
          .number()
          .min(0)
          .max(2)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust.sourceCountExponent),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.sourceTrust),
    scale: z
      .object({
        madScale: z
          .number()
          .min(0.001)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale.madScale),
        scaleFloor: z
          .number()
          .min(1e-6)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale.scaleFloor),
        scaleCeiling: z
          .number()
          .min(1e-3)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale.scaleCeiling),
        baselineSpreadFloor: z
          .number()
          .min(1e-12)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale.baselineSpreadFloor),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.scale),
  })
  .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS)
  .superRefine((value, ctx) => {
    // The robust-MAD surprise scale is clamped to [scaleFloor, scaleCeiling] in
    // volatility.py via _clamp(base_scale, floor, ceiling). If floor > ceiling,
    // _clamp returns the ceiling — silently violating the requested floor and
    // making surprises easier to fire than the operator asked for. Reject the
    // inverted ordering at the schema boundary instead of letting it through.
    if (value.scale.scaleFloor > value.scale.scaleCeiling) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scale", "scaleFloor"],
        message: "scaleFloor must be less than or equal to scaleCeiling",
      });
    }
  });

export type BoardStateSpaceConfig = z.infer<typeof BoardStateSpaceConfigSchema>;
