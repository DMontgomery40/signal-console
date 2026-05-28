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
    varianceAdaptationBase: 0.06,
    varianceAdaptationScale: 0.9,
    varianceAdaptationOffset: 10,
    initialLevelVariance: 1,
    initialTrendVariance: 1,
    initialVarianceFloor: 0.04,
  },
  observationNoise: {
    floor: 0.05,
    minimum: 1e-4,
    singleSourceDominance: 1,
    multiSourceDominanceFallback: 0.5,
    sourceDominancePenalty: 1.2,
    sourceAgreementBonus: 0.45,
    sourceCountBonus: 0.15,
  },
  variance: {
    madScale: 1.4826,
    floor: 1e-4,
    ceiling: 4,
    decay: 0.98,
    bumpCap: 9,
    bumpCenter: 1,
    agreementBase: 0.8,
    agreementScale: 0.4,
    baselineMadFloor: 1e-9,
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
        varianceAdaptationBase: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.varianceAdaptationBase),
        varianceAdaptationScale: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.varianceAdaptationScale),
        varianceAdaptationOffset: z
          .number()
          .min(0)
          .max(200)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.varianceAdaptationOffset),
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
        initialVarianceFloor: z
          .number()
          .min(1e-9)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics.initialVarianceFloor),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.dynamics),
    observationNoise: z
      .object({
        floor: z
          .number()
          .min(1e-9)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.floor),
        minimum: z
          .number()
          .min(1e-12)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.minimum),
        singleSourceDominance: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.singleSourceDominance),
        multiSourceDominanceFallback: z
          .number()
          .min(0)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.multiSourceDominanceFallback),
        sourceDominancePenalty: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.sourceDominancePenalty),
        sourceAgreementBonus: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.sourceAgreementBonus),
        sourceCountBonus: z
          .number()
          .min(0)
          .max(5)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise.sourceCountBonus),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.observationNoise),
    variance: z
      .object({
        madScale: z
          .number()
          .min(0.001)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.madScale),
        floor: z
          .number()
          .min(1e-12)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.floor),
        ceiling: z
          .number()
          .min(1e-9)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.ceiling),
        decay: z.number().min(0).max(1).default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.decay),
        bumpCap: z
          .number()
          .min(0.001)
          .max(100)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.bumpCap),
        bumpCenter: z
          .number()
          .min(0)
          .max(20)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.bumpCenter),
        agreementBase: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.agreementBase),
        agreementScale: z
          .number()
          .min(0)
          .max(10)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.agreementScale),
        baselineMadFloor: z
          .number()
          .min(1e-12)
          .max(1)
          .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance.baselineMadFloor),
      })
      .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS.variance),
  })
  .default(BOARD_STATE_SPACE_CONFIG_DEFAULTS);

export type BoardStateSpaceConfig = z.infer<typeof BoardStateSpaceConfigSchema>;
