---
name: tests
description: "Skill for the Tests area of signal-console. 99 symbols across 18 files."
---

# Tests

99 symbols | 18 files | Cohesion: 100%

## When to Use

- Working with code in `apps/`
- Understanding how default_state_space, observation, test_state_space_scores_regime_entry_without_paging_every_bucket work
- Modifying tests-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/nba-sidecar/tests/test_volatility.py` | default_state_space, observation, test_state_space_scores_regime_entry_without_paging_every_bucket, test_state_space_trigger_config_is_operator_tunable, fire_count (+18) |
| `apps/api/tests/board.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readObservations (+8) |
| `apps/api/tests/fanout.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readArray (+2) |
| `apps/api/tests/cache.test.ts` | startApp, rowCounts, extractCount, isRecord, asRecord (+1) |
| `apps/api/tests/detectors.test.ts` | startApp, isRecord, asRecord, isUnknownArray, fetchDetectorRows (+1) |
| `apps/api/tests/games.test.ts` | startApp, isRecord, ids, sports, tagsForGet |
| `apps/api/tests/live.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readTicks |
| `apps/api/tests/microstructure.test.ts` | startApp, isRecord, isUnknownArray, asRecord, readEvents |
| `apps/api/tests/settings.test.ts` | startApp, isRecord, asRecord, tagsForGet, bm |
| `apps/api/src/server.ts` | buildServer, resolvePort, resolveHost, start |

## Entry Points

Start here when exploring this area:

- **`default_state_space`** (Function) — `apps/nba-sidecar/tests/test_volatility.py:64`
- **`observation`** (Function) — `apps/nba-sidecar/tests/test_volatility.py:68`
- **`test_state_space_scores_regime_entry_without_paging_every_bucket`** (Function) — `apps/nba-sidecar/tests/test_volatility.py:81`
- **`test_state_space_trigger_config_is_operator_tunable`** (Function) — `apps/nba-sidecar/tests/test_volatility.py:103`
- **`fire_count`** (Function) — `apps/nba-sidecar/tests/test_volatility.py:116`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `default_state_space` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 64 |
| `observation` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 68 |
| `test_state_space_scores_regime_entry_without_paging_every_bucket` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 81 |
| `test_state_space_trigger_config_is_operator_tunable` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 103 |
| `fire_count` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 116 |
| `test_state_space_keeps_historical_prior_early_then_fades` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 147 |
| `test_state_space_uses_opening_anchor_controls_in_opening_ramp_mode` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 170 |
| `test_state_space_uses_game_and_wall_memory_in_historical_blend_mode` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 203 |
| `test_state_space_source_count_exponent_is_operator_tunable` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 234 |
| `test_state_space_source_trust_makes_single_book_moves_harder_to_fire` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 287 |
| `last_z` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 314 |
| `test_state_space_disagreement_weight_is_operator_tunable` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 339 |
| `test_state_space_threshold_stays_on_the_same_raw_intensity_axis_as_fires` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 394 |
| `test_state_space_endpoint_keeps_visible_thresholds_below_fired_intensity` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 437 |
| `test_state_space_endpoint_returns_observable_contract` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 480 |
| `test_state_space_config_accepts_the_packaged_defaults` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 574 |
| `test_state_space_config_rejects_out_of_range_values` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 603 |
| `test_state_space_standardized_innovation_is_calibrated_to_unit_scale` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 628 |
| `calib_observation` | Function | `apps/nba-sidecar/tests/test_volatility.py` | 636 |
| `buildServer` | Function | `apps/api/src/server.ts` | 46 |

## How to Explore

1. `gitnexus_context({name: "default_state_space"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
