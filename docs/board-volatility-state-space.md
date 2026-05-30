# Board Volatility State-Space Contract

This is the canonical map of the current board-volatility runtime.

## Runtime truth

- The live board lane runs in Python at [apps/nba-sidecar/src/nba_sidecar/volatility.py](/Users/davidmontgomery/signal-console/apps/nba-sidecar/src/nba_sidecar/volatility.py).
- The API builds board observations in [apps/api/src/services/board-volatility-model.ts](/Users/davidmontgomery/signal-console/apps/api/src/services/board-volatility-model.ts) and posts them to the sidecar through the shared detector runtime client in [packages/detectors/src/board-mad/state-space-runtime.ts](/Users/davidmontgomery/signal-console/packages/detectors/src/board-mad/state-space-runtime.ts).
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
- `dynamics`: memory, process noise, and initial state variances for the latent level/trend filter
- `sourceTrust`: source dominance / agreement / count weighting that bounds the surprise-scale multiplier
- `scale`: robust MAD scaling of the filter innovations and the clamp on the resulting surprise scale

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
  - `initialLevelVariance`
  - `initialTrendVariance`
- `sourceTrust`
  - `minMultiplier`
  - `maxMultiplier`
  - `singleSourceDominance`
  - `multiSourceDominanceFallback`
  - `sourceDominancePenalty`
  - `sourceAgreementBonus`
  - `sourceCountBonus`
  - `sourceCountExponent`
- `scale`
  - `madScale`
  - `scaleFloor`
  - `scaleCeiling`
  - `baselineSpreadFloor`

### Surprise scale and source trust

The fire decision standardizes each filter innovation by a robust surprise scale:

- `scale.madScale` turns the median absolute deviation (MAD) of the trailing,
  past-only innovation window into a Gaussian-comparable sigma (1.4826 is the
  Gaussian-consistency constant). That product is the base surprise scale.
- `scale.scaleFloor` and `scale.scaleCeiling` clamp the base surprise scale to
  `[scaleFloor, scaleCeiling]`. The schema enforces `scaleFloor <= scaleCeiling`,
  because if the floor exceeded the ceiling the clamp would silently collapse to
  the ceiling and let surprises fire more easily than the operator asked.
- `scale.baselineSpreadFloor` is a tiny safety floor (default `1e-9`) on the
  prior/baseline spread. It floors the historical-prior scale used to seed and
  anchor the filter (so it can nudge firing through the anchor pull) and it also
  floors the displayed intensity-space threshold-line spread. At the default it
  essentially never binds.

The clamped base scale is then multiplied by a bounded source-trust multiplier
before standardizing the innovation: `z = innovation / (base_scale * multiplier)`.
The multiplier is the `sourceTrust` group's only job. It is centered near 1 for a
balanced multi-source bucket and is clamped to `[sourceTrust.minMultiplier,
sourceTrust.maxMultiplier]`:

- `sourceDominancePenalty` inflates the multiplier (scale up, harder to fire)
  when one source dominates the bucket move.
- `sourceAgreementBonus` and `sourceCountBonus` shrink the multiplier (scale
  down, easier to fire) when independent sources agree, with `sourceCountExponent`
  shaping how the count bonus grows.
- `singleSourceDominance` and `multiSourceDominanceFallback` supply the assumed
  dominance score when the observation does not carry an explicit split.

Source trust only modulates the fire gate. The latent level/trend Kalman update
uses the trust-free base scale as its observation variance, so distrust of a
single book never slows baseline tracking.

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
