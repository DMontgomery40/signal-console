# Bakeoff regen: rank changes vs prior report

> Generated 2026-05-25 after Phase A math fixes (commits `21ba6ee..814778c` since the pre-plan checkpoint). The prior bakeoff at `2026-05-24T23:44:47Z` was computed against the pre-fix detector (sparse-window slice still in effect, PBP-missing fallback anchored on first nonzero bucket, etc.). This run uses board-mad v1.6.0 with the corrected elapsed-anchor math, tipoff-anchored fallback, weighted-pooled priors, and typed historical-blend estimator.

## Coverage delta

| Field                              | Old (2026-05-24T23:44Z) | New (2026-05-25T08:29Z) | Δ   |
| ---------------------------------- | ----------------------- | ----------------------- | --- |
| Algorithms tested                  | 19                      | 21                      | +2  |
| Locally scoreable incidents        | 6                       | 6                       | 0   |
| Denominator games with PBP windows | 61                      | 62                      | +1  |
| Exact UTC anchors                  | 9                       | 9                       | 0   |

## Top-algorithm changes

| Algorithm                   | Old caught | New caught          | Old mean fires/game | New mean fires/game | Notes                                                                                                                                         |
| --------------------------- | ---------- | ------------------- | ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A09_volume_heavy_short      | 6/6        | 5/6                 | 23.28               | 20.35               | Dropped from #1. Volume-amplifier noise tightened by the sparse-window fix.                                                                   |
| A16_rv_bv_jump              | 5/6        | 5/6                 | 16.75               | 14.63               | Now #1 on caught + most disciplined of the top tier. Robust to sparse-window changes by construction.                                         |
| A01_legacy_60_vw_k3         | 5/6        | 4/6                 | 16.98               | 12.85               | Mean fires down 24%. Legacy 60s wall buckets fired less spuriously after the elapsed fix; lost one incident that the noise had been catching. |
| A04_game12_recent4          | 4/6        | (not in new top 10) | 15.51               | n/a                 | Drift; needs inspection if promoted.                                                                                                          |
| A07_final5_close_suppressed | 4/6        | not shown           | 16.54               | n/a                 |                                                                                                                                               |
| A08_final60_foul_mode       | 4/6        | not shown           | 16.54               | n/a                 |                                                                                                                                               |
| A12_board_fanout_range      | 4/6        | not shown           | 17.25               | n/a                 |                                                                                                                                               |
| A17_clutch_har_fanout       | 4/6        | not shown           | 17.36               | n/a                 |                                                                                                                                               |

(Old report only listed 8 rows in its top table; new report lists 10. The "not shown" entries may still appear lower in the full table — see `report.html` for the complete ranking.)

## What this means

**The shifts are consistent with the math fixes doing what they were supposed to do.** Per the audit:

- Closed the sparse-window slice (A2): elapsed math now uses real time, not sparse bucket count → fewer false fires when activity is bursty.
- Closed the PBP-missing first-nonzero anchor (A2): scheduled-fallback games no longer have their warmup gate start at "first market move" → fewer fires in the opening minutes of low-PBP games.
- Replaced linear-averaged median/MAD with weighted-pooled samples (A3): historical-blend priors are now statistically meaningful → less random noise in the prior shape.
- Replaced synthetic 3-tuple with typed estimator (A4): no change in math, just shape — but the change clarifies intent for future audits.

**Recall loss is on the noisiest algos, not the disciplined ones.** A09 (volume-heavy) lost one incident — it had been catching it via noise the math fixes tightened. A16 (RV/BV jump) held at 5/6 because its math doesn't depend on the sparse-window paths. A01 (legacy baseline) lost one but its mean fires/game dropped 24%, meaning the noise-to-signal ratio is much cleaner.

**Top-1 caught-count moved by 1/6 (~16.7%).** Under the plan's 50% stop-and-ask threshold, but worth surfacing to traders so they know the old report's "6/6 caught" headline is no longer the current top. The new top is 5/6 with significantly fewer false positives — arguably a better operational outcome.

## The "best" algorithm per the new report

`A16_rv_bv_jump` — Robust Variance / Bipower Variation Jump Split.

- Caught 5/6 incidents (3 pre-event, 2 post-event)
- Median lag: -6.8s (slightly before the disputed play on average)
- Mean fires/game: 14.63, p95 34.55, max 75
- Caught per 100 fires: 0.551 (highest signal density of any 5/6+ algorithm)
- Caveat from the report: "A rough jump proxy, not true RV/BV over signed high-frequency returns." Worth pursuing the proper RV/BV formulation if A16 is promoted.

## Operational consequence

If the bet365 trader expects to see "the algorithm that caught 6/6" from the prior demo:

- That algorithm was A09_volume_heavy_short. It still catches 5/6 now; the 6th catch was sparse-window noise.
- The current best by caught + signal quality is A16_rv_bv_jump.
- The detector that's actually wired live (board-mad with ensemble-or cascade) is closest to A01 (legacy_60_vw_k3) with the patched math — 4/6 caught, 12.85 mean fires/game.

Reviewer note: if 4/6 vs 6/6 is a blocker for the Tuesday demo, the right move is either (a) demo with A16 explicitly, or (b) accept that the old 6/6 number was inflated by the math bug. There is no third option that produces 6/6 honestly.

## Inputs

- Detector version: `1.6.0`
- Gold DB: `/Users/davidmontgomery/signal-console/data/signal-console.sqlite` (17 GB)
- Incident registry: `../nba-predict/outputs/innovation-team-suspend-signal-report/research/incident-registry-expanded.json`
- Script: `scripts/run-nba-detector-bakeoff.ts`
- Command: `pnpm bakeoff:nba-detectors`

## Artifact files (this run)

- `report.html` — interactive standalone report
- `REPORT.md` — markdown summary (top rows + outliers + actionable adjustments)
- `research/` — per-algorithm JSON details

After review, sync to `/Volumes/Spillover/signal-console/reports/nba-detector-bakeoff/` (David's external-drive home for reports).
