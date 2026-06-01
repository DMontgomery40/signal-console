# Enforced contracts established by the 2026-05-30 audit fixes

Reference doc for the invariants the audit fixes put in place. If you touch these
areas, respect (and re-run) the contracts. Full context:
`audit/HANDOFF-audit-fixes-2026-05-30.md` and `audit/findings/F-0xx-*.md`.

## 1. State-space config bounds: one source of truth (F-001)

- **Authority:** `packages/detectors/src/board-mad/state-space-bounds.json` — the
  canonical inclusive `[min,max]` (+`int`) for all 30 board state-space config
  fields.
- **Two validators must match it:** the TS Zod schema
  (`state-space-config.ts` `BoardStateSpaceConfigSchema`) and the Python pydantic
  models (`apps/nba-sidecar/.../models.py`).
- **Enforcement:** `state-space-bounds.contract.test.ts` (TS, introspects the live
  Zod schema) and `test_state_space_bounds_contract.py` (Python, introspects the
  live pydantic fields) both assert equality with the JSON. Change a bound → change
  the JSON → both language schemas must follow or their test goes red.
- **Do NOT** edit a bound in only one language. The old "keep in lockstep" comment
  is now backed by tests, not discipline.

## 2. kMad / Sensitivity range: derived, not hardcoded (F-004)

- The kMad range is `[BOARD_MAD_K_MAD_MIN, BOARD_MAD_K_MAD_MAX]` (= [1,12]),
  defined once in `config.ts` and used by the params schema, the Settings slider,
  detector-defaults, AND the backtest `SensitivityDial` (no bare literals).
- `RotaryDial` reconciles an out-of-range controlled `value` by calling
  `onChange(clamped)` — it never displays a clamped value while the owner holds a
  different one. Consumers MUST persist `onChange` (controlled pattern) or the
  reconcile can loop.

## 3. Detector sources ⊆ domain source universe (F-007)

- The detector `Source` union (`detectors/src/types.ts`) is intentionally a
  **subset** of `marketResearchSourceIds` (`domain/live-types.ts`). It can't be
  type-bound because `domain` already imports `detectors` (one-way dependency).
- **Enforcement:** `packages/shared/src/__tests__/detector-source-contract.test.ts`
  asserts every detector's advertised `sources ⊆ marketResearchSourceIds`. Adding a
  detector source the domain doesn't know fails this test.
- The registry's `sources` is **advertised coverage**, not a runtime filter — the
  live whole-board signal counts sources data-drivenly from the ticks present.

## 4. Board volatility is WHOLE-BOARD by design (F-008 — do not "fix")

- The board state-space signal pools implied-probability deltas from **every**
  market family (moneyline, spread, total, player-prop, …) on purpose. Current
  support: `docs/design-language.md:223` plus owner confirmation; the old root PRD
  is retired and deleted.
- `loadBoardMadTicksForGame` filtering only by `game_id` (no family filter) is
  CORRECT. Adding a family filter would remove signal ("needles"). The breadth
  normalizer (÷ activeMarketCount) exists because it pools all markets.
- `sourceCount`/`sourceDominance`/`sourceDisagreement` are **book-level** (keyed by
  `tick.source`), via the set named `contributingSourceKeys` (renamed from the
  misleading `sourceMarkets`). Distinct from `activeMarketCount` (market-level).
  Caveat: on a legacy gold DB without `source_markets.source`, the loader selects
  `NULL AS source` and source-trust degrades to per-market — current schema has it
  `NOT NULL`, so production is book-level.

## 5. implied_probability is guarded like price_raw (F-006)

- In `live-repository.ts`, the price-resolution COALESCE now guards
  `implied_probability BETWEEN 0 AND 1` symmetrically with `price_raw` (5 sites).
  An out-of-range probability falls through instead of flowing into the
  divergence/disagreement price. Value-preserving for all in-range data.
- Adapters already convert odds→[0,1] before persisting, so this is defense in
  depth. (Reminder: `/v1/live` `volume` is `COALESCE(qt.volume,0)` — non-null by
  design, the schema is correct; do not "make it nullable".)

## 6. Known dead/parallel surface — do not build on it (F-010)

- The board-anomaly subsystem (`shared/board-anomaly/*`, `BoardGameStateVolatility`,
  the listings/fanouts, and `resolveBoardVolatilityBaseline` + the
  `board_volatility_baselines` table) is **unreachable from the live product** —
  green-tested and barrel-exported, but 0 callers in apps/scripts. The worker's
  `board-volatility-baseline-rebuild` admin action writes a table nothing reads.
- Status pending owner classification (staged vs abandoned). Until then, the LIVE
  board signal is the state-space board (`board-mad` / `volatility.py`); build
  there, not in board-anomaly.

## Verification

Full repo gate `pnpm verify` passes (prettier + eslint max-warnings=0 + scripts
tsc + all-package tsc + verify-no-stale-plan/no-hex/queries/citations + every
package's vitest). The F-004 in-range, F-003 stale-note, and F-001
Python-fail-not-skip tests are written and passing; F-006's guard is regression-
safe + inspection-verified (behavioral test for the market-anomaly path remains a
documented follow-up in the handoff)."
