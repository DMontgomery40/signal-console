# Codex Math Failure Ledger

Created: 2026-05-25

Purpose: permanent repo memory for detector-math claims that were not true at the time they were made, what the code actually did, the user-facing impact, and the regression that now guards the repair.

This ledger deliberately does not use "inherited from user" as an explanation. The author shown by git may be David's local identity even when an agent wrote the change. Where the exact agent attribution is not proven by a session log in this file, attribution is recorded as unknown or as a repo commit claim, not as a human authorship claim.

## Tuesday Go/No-Go Checklist

| Surface                                        | Status                        | Evidence                                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live/backtest parity for board lane            | GO                            | `apps/api/tests/runner.parity.test.ts` proves game-scope vs window-scope parity and ensemble board lane vs standalone board-mad parity.                                                    |
| Historical priors sane                         | GO                            | `apps/api/tests/board-mad-context.test.ts` proves weighted raw-sample pooling and elapsed opening-window selection.                                                                        |
| Live ensemble/offprice executable              | GO                            | `/v1/ensemble-or/:gameId` and `/v1/off-price-print/:gameId` are live routes through the shared runner. `apps/api/tests/ensemble-or.test.ts` pins route shape, cache hit, auth, and K echo. |
| Live chart uses the same K that produced fires | GO                            | `/v1/ensemble-or` echoes `k`; `apps/web/src/data/queries.ts` requires it with no default; `LivePage` renders no fallback K while loading.                                                  |
| Regenerated bakeoff is truthful                | GO                            | `outputs/nba-detector-bakeoff/REPORT.md` and `outputs/nba-detector-bakeoff/CHANGES.md` were regenerated on 2026-05-25 and explicitly report the old 6/6 headline dropping to 5/6.          |
| Video artifact                                 | NO-GO until C2                | Existing video predates the v1.6.0 bakeoff. Do not use it for Tuesday unless regenerated or removed from the demo package.                                                                 |
| Stale fake-math comments in active code/docs   | GO with historical exceptions | Active hits are negative/historical documentation describing bugs and repairs. `scripts/ralph/**` remains historical handoff/progress material, not current operator truth.                |

## Ledger Entries

### 1. v1.5.0 sparse-window claim was broader than the repair

- Claim made: the v1.5.0 board-mad comment said the trailing/opening-ramp baseline sample was selected by elapsed time rather than sparse non-empty observation slicing. In checkpoint `21ba6ee`, see `packages/detectors/src/board-mad/index.ts:44-48`.
- Actual code behavior at the time: `packages/detectors/src/board-mad/baseline.ts` at checkpoint `21ba6ee` did use elapsed comparisons for entries with `gameElapsedSeconds`, but PBP-missing entries still fell back to `current.bucket - first.bucket` at lines 107-117 and 119-127. That made elapsed time start at the first observed market bucket, not tipoff.
- User impact: quiet or PBP-lag games could still be warmed and baselined from sparse market activity while the product language said elapsed-time math was fixed.
- Repair test: `packages/detectors/src/board-mad/__tests__/baseline.tipoff.test.ts` lines 1-17 define the PBP-missing tipoff-anchor contract, including scheduled-anchor and fail-closed cases.
- Current repair: `packages/detectors/src/board-mad/baseline.ts` lines 123-130 route PBP-missing elapsed through `GameTimingContext.tipoffAnchorUtc` when the runner provides context.

### 2. "8 elapsed minutes" warmup bypassed when PBP was missing

- Claim made: v1.4.0 described opening holdoff activation as elapsed time rather than market-observation count. In checkpoint `21ba6ee`, see `packages/detectors/src/board-mad/index.ts:50-53`.
- Actual code behavior at the time: the warmup gate used `elapsedSecondsForBucket`, but that helper returned `current.bucket - first.bucket` when `gameElapsedSeconds` was absent. A first market movement at tipoff+5 minutes looked like elapsed zero; a later movement could satisfy the gate based on market-observation wall distance, not real game/tipoff elapsed.
- User impact: live games during PBP feed lag could show warmup behavior inconsistent with the "8 elapsed minutes" operator claim.
- Repair test: `baseline.tipoff.test.ts` covers a no-PBP sparse series at tipoff+5 minutes as not eligible and a later scheduled-anchor case as eligible only by tipoff elapsed.
- Current repair: `apps/api/src/services/detector-runner.ts` lines 112-150 resolves one per-game timing context using PBP `MIN(time_actual)`, scheduled start, or fail-closed `none`; `baseline.ts` consumes that context.

### 3. Historical-blend live estimator laundered summary stats through a fake sample

- Claim made: historical/live blended baseline was presented as a real blended baseline in the v1.3.0/v1.5.0 detector history.
- Actual code behavior at the time: checkpoint `21ba6ee` `packages/detectors/src/board-mad/baseline.ts:218-260` computed two summary estimators, then returned `[med - mad, med, med + mad]` as though it were a sample. `resolveBoardMadBaseline` then ran `median()` and `medianAbsDev()` over that synthetic three-value sample at lines 323-331.
- User impact: reports and comments implied a sample-backed robust statistic, but the live distribution had already been collapsed to two summary numbers. Future maintainers could tune or audit the wrong thing.
- Repair test: `packages/detectors/src/board-mad/__tests__/baseline.elapsed.test.ts:321-327` pins the typed estimator behavior and its weighted-average semantics.
- Current repair: `packages/detectors/src/board-mad/baseline.ts:268-280` documents and types the estimator directly, and lines 428-440 consume `{ median, mad }` without reinterpreting it as a sample.

### 4. Historical-prior fade used sparse bucket index when elapsed seconds were absent

- Claim made: historical-blend prior weight faded by game time.
- Actual code behavior at the time: checkpoint `21ba6ee` `packages/detectors/src/board-mad/baseline.ts:262-275` used `bucketIndex * timing.bucketSeconds` whenever `gameElapsedSeconds` was absent. In a sparse bucket array, `bucketIndex` counted observed buckets, not elapsed game time.
- User impact: historical priors could remain overweighted too long or decay on the wrong clock in sparse/no-PBP paths.
- Repair test: `baseline.tipoff.test.ts` includes historical-blend scheduled-anchor cases that exercise the same tipoff fallback.
- Current repair: `baseline.ts` now obtains elapsed through the same context-aware helper used by warmup and trailing windows.

### 5. combineSidePriors linearly averaged medians and MADs

- Claim made: historical priors represented the configured away/home blend.
- Actual code behavior at the time: checkpoint `21ba6ee` `apps/api/src/services/board-mad-context.ts:196-211` returned `away.median * awayWeight + home.median * homeWeight` and the same for MAD. Medians and MADs are nonlinear estimators; linearly averaging them is not the median/MAD of the intended pooled distribution.
- User impact: prior baselines could be numerically plausible but statistically unsupported, especially when away/home sample counts were imbalanced.
- Repair test: `apps/api/tests/board-mad-context.test.ts:16-87` disambiguates weighted pooling from both plain concat and linear-averaged medians.
- Current repair: `apps/api/src/services/board-mad-context.ts:237-246` documents the weighted raw-sample design; `combineSidePriors` now builds weighted samples instead of averaging summary estimators.

### 6. Historical-prior opening window used first-N sparse buckets

- Claim made: opening historical priors were based on the opening baseline window.
- Actual code behavior at the time: checkpoint `21ba6ee` `apps/api/src/services/board-mad-context.ts:176-189` used `.slice(0, openingBaselineBuckets)` over the sparse bucket array. A prior game with one early bucket and quiet time could contribute later nonzero buckets as if they were still in the opening window.
- User impact: cold-start historical priors could include mid-game intensity while being described as opening-game context.
- Repair test: `apps/api/tests/board-mad-context.test.ts` includes `selectOpeningWindowValues` coverage for elapsed opening-window selection.
- Current repair: `apps/api/src/services/board-mad-context.ts:205-235` selects by elapsed seconds from PBP tipoff instead of sparse bucket count.

### 7. Ensemble historical-blend backtests skipped board priors

- Claim made: ensemble-or backtests could evaluate the board lane with the same nested board parameters as standalone board-mad.
- Actual code behavior at the time: checkpoint `21ba6ee` `apps/api/src/services/backtest.ts:128-131` only built historical priors when `dispatch.boardMadParams` was present. The standalone board-mad dispatch set `boardMadParams` at lines 226-233; the ensemble dispatch at lines 249-266 did not, so nested historical-blend board params received empty priors.
- User impact: ensemble-or backtest results could diverge from standalone board-mad with the same board params, undercutting the live/backtest parity story.
- Repair test: `apps/api/tests/runner.parity.test.ts:216-280` proves game/window parity and ensemble board-lane equivalence to standalone board-mad.
- Current repair: `apps/api/src/services/detector-runner.ts:364-376` sets `boardMadParams: params.board` for ensemble-or, so historical priors are built by the shared runner for both standalone and nested board paths.

### 8. Live Stage-1 cascade initially labeled raw microstructure as off-price detector output

- Claim made: Live paired board-mad with off-price prints.
- Actual code behavior at the time: checkpoint `21ba6ee` `apps/web/src/features/live/LivePage.tsx:254-260` fetched `/v1/board` and `/v1/microstructure`. The UI used raw microstructure events on the chart, not the `off-price-print` detector's threshold logic.
- User impact: the live demo could show off-price markers that were not executable detector fires and did not honor `minOffPriceDistance`.
- Repair test: `apps/api/tests/ensemble-or.test.ts` covers the live ensemble route; `apps/web/src/features/live/__tests__/LivePage.test.tsx` covers LivePage consuming `/v1/ensemble-or` and rendering K from that response.
- Current repair: `apps/web/src/features/live/LivePage.tsx:270-336` uses `useEnsembleOr`, maps lane-tagged offprice fires, and renders K from the same ensemble response.

### 9. Client-side K fallback could hide a stale or downgraded ensemble API

- Claim made: the Live chart's threshold line used the same K that produced ensemble fires.
- Actual code behavior after B-followup #2: `apps/web/src/data/queries.ts` temporarily used `k: z.number().default(3.0)` for `/v1/ensemble-or`, so a stale response without `k` would silently draw 3.0 again.
- User impact: this could reintroduce the exact K source-of-truth race the review was closing, but only when API/client versions drifted or the route regressed.
- Repair test: `apps/api/tests/ensemble-or.test.ts:231-246` sets `kMadLive: 7.25` and asserts the route echoes `7.25`.
- Current repair: `apps/web/src/data/queries.ts:227-236` requires `k` with no Zod default, and `apps/web/src/features/live/LivePage.tsx:322-336` renders no fallback number while loading.

### 10. The old bakeoff/video artifacts were generated on stale detector math

- Claim made: the old bakeoff/video were usable proof for the Tuesday detector story.
- Actual code behavior at the time: the report generated on 2026-05-24 predated the v1.6.0 math fixes. It reported a 6/6 headline for A09 that depended partly on the old noisy/sparse behavior.
- User impact: using the old artifacts would overstate current recall and hide the false-positive reduction caused by the repair.
- Repair test: `outputs/nba-detector-bakeoff/CHANGES.md` compares old and new rankings and explicitly says A09 dropped from 6/6 to 5/6, while A16 is the new top 5/6 algorithm.
- Current repair: `outputs/nba-detector-bakeoff/REPORT.md` was regenerated on 2026-05-25 against board-mad v1.6.0. The video remains no-go until regenerated or removed.
