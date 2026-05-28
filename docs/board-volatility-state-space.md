# Board Volatility State-Space Contract

This is the canonical map of the current board-volatility runtime.

## Runtime truth

- The live board lane runs in Python at [apps/nba-sidecar/src/nba_sidecar/volatility.py](/Users/davidmontgomery/signal-console/apps/nba-sidecar/src/nba_sidecar/volatility.py).
- The API builds board observations in [apps/api/src/services/board-volatility-model.ts](/Users/davidmontgomery/signal-console/apps/api/src/services/board-volatility-model.ts) and posts them to the sidecar through [apps/api/src/services/volatility-model-sidecar.ts](/Users/davidmontgomery/signal-console/apps/api/src/services/volatility-model-sidecar.ts).
- The live defaults are persisted at [data/detector-defaults.json](/Users/davidmontgomery/signal-console/data/detector-defaults.json).

## Tunable surfaces

- Trader-facing live defaults:
  [apps/web/src/features/settings/SettingsPage.tsx](/Users/davidmontgomery/signal-console/apps/web/src/features/settings/SettingsPage.tsx)
- Backtest replay params and promote-to-live flow:
  [apps/web/src/features/backtest/BacktestPage.tsx](/Users/davidmontgomery/signal-console/apps/web/src/features/backtest/BacktestPage.tsx)
- Detector/defaults schema:
  [apps/api/src/services/detector-defaults.ts](/Users/davidmontgomery/signal-console/apps/api/src/services/detector-defaults.ts)
- Advanced model object schema:
  [packages/detectors/src/board-mad/state-space-config.ts](/Users/davidmontgomery/signal-console/packages/detectors/src/board-mad/state-space-config.ts)

## The `stateSpace` object

All hidden-state coefficients that used to live as Python literals now live in one structured object:

- `trigger`: enter/exit gate shape
- `breadth`: market-count normalization
- `observationModel`: extra observation embedding terms such as cross-source directional disagreement
- `anchors`: prior and anchor precision floors
- `dynamics`: memory, process noise, and variance adaptation
- `observationNoise`: source dominance / agreement weighting
- `variance`: MAD scaling, latent variance bounds, regime bump terms

If a board-model coefficient matters to runtime behavior, it belongs here or in the top-level operator settings object. Do not hide new model coefficients inside Python code without adding them to this contract.

Settings and Backtest now expose every current `stateSpace` field directly in grouped numeric controls. The JSON editor below those controls is the same object for copy/paste and handoff, not a second implementation path.

### Field inventory

- `trigger`
  - `enterOffset`
  - `enterKScale`
  - `exitFloor`
  - `exitRatio`
- `breadth`
  - `marketCountFloor`
  - `marketCountExponent`
- `observationModel`
  - `disagreementWeight`
- `anchors`
  - `priorScaleFallback`
  - `priorScaleFloor`
  - `anchorScaleFloor`
  - `precisionVarianceFloor`
- `dynamics`
  - `minMemoryBuckets`
  - `trendDecayNumerator`
  - `levelProcessNoiseBase`
  - `levelProcessNoiseScale`
  - `trendProcessNoiseRatio`
  - `varianceAdaptationBase`
  - `varianceAdaptationScale`
  - `varianceAdaptationOffset`
  - `initialLevelVariance`
  - `initialTrendVariance`
  - `initialVarianceFloor`
- `observationNoise`
  - `floor`
  - `minimum`
  - `singleSourceDominance`
  - `multiSourceDominanceFallback`
  - `sourceDominancePenalty`
  - `sourceAgreementBonus`
  - `sourceCountBonus`
  - `sourceCountExponent`
- `variance`
  - `madScale`
  - `floor`
  - `ceiling`
  - `decay`
  - `bumpCap`
  - `bumpCenter`
  - `innovationPower`
  - `agreementBase`
  - `agreementScale`
  - `baselineMadFloor`

## Current operator knobs outside `stateSpace`

These stay top-level because traders already reason about them directly:

- `kMadLive`
- `bucketSeconds`
- `baselineMode`
- `openingBaselineBuckets`
- `openingRampCompleteBuckets`
- `trailingBuckets`
- `warmupBuckets`
- `freshCapSeconds`
- `historicalLastGames`
- `historicalAwayWeight`
- `historicalPriorWeight`
- `historicalRampCompleteGameMinutes`
- `trailingGameMinutes`
- `recentWallMinutes`
- `recentWallWeight`

## Bakeoff contract

The bakeoff now evaluates the actual Python runtime as a first-class row, derived from the saved detector defaults instead of a parallel hardcoded comparator:

- script:
  [scripts/run-nba-detector-bakeoff.ts](/Users/davidmontgomery/signal-console/scripts/run-nba-detector-bakeoff.ts)
- tests:
  [scripts/run-nba-detector-bakeoff.test.ts](/Users/davidmontgomery/signal-console/scripts/run-nba-detector-bakeoff.test.ts)

Run it with the sidecar available:

```bash
NBA_SIDECAR_BASE_URL=http://127.0.0.1:9393 NODE_OPTIONS=--max-old-space-size=8192 pnpm bakeoff:nba-detectors
```

That report now includes:

- the current live defaults row
- the packaged baseline-defaults row when it differs
- the persisted `stateSpace` object inside the machine-readable algorithm payload
- the tape-native outlier denominator alongside incident recall

## Ground rules

- Live math belongs to Python.
- Hidden coefficients belong in structured objects, not scattered literals.
- UI copy, docs, and bakeoff rows must describe the same runtime that Recent and Live actually execute.
