# Signal Console — Semantic Disconnect Audit

Goal: find subtle, non-error-surfacing disconnects across boundaries (UI / DB /
runtime / pydantic / train / eval / analyze) — duplicate-but-divergent logic,
skeleton code wired into live paths, fragile wide surfaces, and concepts that
are defined firmly in one boundary but differently / oppositely / not-at-all in
another. The danger class: silent disagreements that corrupt expensive tuning,
make a good model look bad, or make a bad model look good.

Run as a self-paced `/loop`. One bounded slice per iteration. Findings are
recorded in `audit/findings/`. Severity: **critical** (silently wrong numbers a
user would trust) / **high** / **medium** (fragility, latent) / **low** (cosmetic
/ stale-label). Each finding states the disconnect, the boundary it crosses, the
silent failure mode, and a concrete fix.

## Coverage map (slices)

| # | Slice | Status | Findings |
|---|-------|--------|----------|
| 1 | board-volatility **state-space**: Python sidecar `volatility.py`/`models.py` ↔ TS `state-space-runtime.ts`/`state-space-config.ts` ↔ web | done | F-001 ✅fixed |
| 2 | board-mad detector: `sweep.ts` ↔ `clientRecompute.ts` ↔ `baseline.ts` ↔ web preview | done | F-002 ✅fixed, F-003 ✅fixed |
| 2b | board-mad **dial ranges/defaults** (`config.ts` MIN/MAX/DEFAULT) ↔ UI dial snap/range props ↔ `explainers.ts` copy ↔ params schema | done | F-004 |
| 3 | domain schemas (`schemas/core,live,research`) ↔ DB (`migrations`, `sport-views`) ↔ API req/resp shapes | partial | F-005 |
| 3b | domain `schemas/live.ts` + `research.ts` ↔ DB tables (quote_ticks/game_states/source_markets) ↔ API resp — field/nullability/units | done | F-006 |
| 4 | adapters: `canonical-instruments`, source identity, market/instrument mapping across bet365/kalshi/polymarket/odds-api | partial | F-007 |
| 4b | adapter market-FAMILY mapping (provider ML/Spread/Totals/Player Props → `marketFamilies` enum) + board family-filtering | done | F-008 |
| 5 | board-anomaly cluster (`shared/board-anomaly/*`): volatility-model / phase / classifier / residual / h0 | todo | |
| 6 | API routes ↔ web `data/queries` ↔ OpenAPI metadata (field names, units, nullability) | todo | |
| 7 | explainers copy (`packages/ui/src/explainers.ts`) ↔ actual defaults / math / units / code refs | todo | |
| 8 | nba-sidecar normalizers/models ↔ TS canonical game/state types ↔ DB persisted shapes | todo | |
| 9 | detector registry labels/ids ↔ ids used in runtime/UI/DB/bakeoff | todo | |
| 10 | env var names: `env.ts` ↔ usage ↔ docs ↔ credential-lookup order | todo | |

(Slices may split or merge as the work reveals structure. Add rows; never delete
a done row.)

## Fixed (verified 2026-05-30, not yet committed)

- **F-001** → shared `state-space-bounds.json` contract + introspection tests on
  both real validators (TS Zod + Python pydantic). Negative control proved the
  guard fails on drift. (4 detector tests pass.)
- **F-002** → deleted the dead client-recompute engine + its falsely-green test;
  kept 3 live exports in new `boardMadDetectorIds.ts`. (web tsc clean.)
- **F-003** → corrected the two false "updates in memory / recomputes in memory"
  copy strings; added a stale note beside the dial. (48 web tests pass.)

Verification: `vitest run state-space` (detectors, 4✅), `vitest run BacktestPage
SensitivityDial` (web, 48✅), `pytest test_state_space_bounds_contract.py`
(sidecar, 1✅), `tsc --noEmit` (web, exit 0). Nothing committed/pushed.

## Confirmed-consistent (so future slices don't re-litigate)

- **state-space has a single math implementation.** `volatility.py` (Python
  sidecar) is the only runtime. `packages/detectors/.../state-space-runtime.ts`
  is a thin HTTP client (POST `/api/v1/models/board-volatility/state-space`),
  not a second implementation. No TS/Python math-drift risk for state-space.
- **state-space wire envelope agrees.** Sidecar returns `{ "data": <flat resp> }`
  (`main.py`); TS client reads `json["data"]`. Field names match (`baselineMedian`,
  `baselineMad`, `threshold`, `standardizedInnovation`, `regimeScore`, `warmedUp`,
  `fired`, `bucketStart/End`, `generatedAt`, `gameId`).
- **state-space config bounds match** field-for-field across all 7 groups / 30
  fields between `models.py` (pydantic) and `state-space-config.ts` (Zod). See
  F-001 for the *enforcement* gap.
- **state-space params interface matches** field-for-field (pydantic
  `VolatilityStateSpaceParams` ↔ TS interface).
- **board-mad baseline math is shared, not re-ported.** Both the server sweep
  (`sweep.ts`) and the (now-dead) client recompute import the same
  `resolveBoardMadBaseline` from `@signal-console/detectors`; the `median + k·mad`
  fire rule matches byte-for-byte. The drift risk there is dead-code revival, not
  a live double-implementation — see F-002.

## Open threads to chase in later slices

- **Latent (folded into F-002):** the client recompute's `BoardMadRecomputeParams`
  has no `timingContext`, so if preview is ever revived it would use the legacy
  first-bucket elapsed fallback while the server uses tipoff-anchored game clock
  → silent fire divergence on PBP-lagged games. Re-verify if preview returns.
- **adapters convert odds→[0,1] probability before persisting.** bet365-direct
  (`probabilityFrom{Decimal,American}`), odds-api (`decimalOddsToProbability`),
  polymarket (native [0,1] `point.p`). No raw odds/percentages leak into
  `implied_probability` today → F-006's out-of-range path is latent. Only
  bet365/kalshi/polymarket have producing adapters; fanduel/draftkings are
  enum-only (F-007).
- **game-state / outcome / instrument / source-market boundary is clean.**
  `live.ts` schemas mirror the DB columns field-for-field, and the game-status
  enum agrees between pydantic `CanonicalGameState.status` and TS
  `researchGameStatuses` (`[scheduled, in-play, final, postponed, cancelled]`).
  (Only the DEAD `core.ts` uses a divergent `[scheduled, pre-tip, in-play, final]`
  — extra evidence for F-005.) The quote-tick row is the exception → F-006.
- **state-space historical prior is honestly computed.** Production builds
  `{median, mad}` via `buildBoardMadHistoricalPriors` →
  `weightedMedian`/`weightedMad` on raw pooled intensities (true MAD), correctly
  consumed by `volatility.py`'s `mad * 1.4826`. The `board_volatility_baselines`
  percentile table (`p50..p99`) feeds ONLY the separate board-anomaly residual
  detector. Two parallel baseline systems, no lossy percentile→MAD conversion.
- **MemoryDial / WarmupDial / opening-baseline & opening-ramp controls are
  clean.** All import `BOARD_MAD_*_MIN/MAX/DEFAULT` from `config.ts` and pass them
  straight through (no hardcoded ranges). The Sensitivity dial is the lone
  offender (F-004). Duration labels (`bucketCount × bucketSeconds`) are consistent.
- `BOARD_MAD_BASELINE_MODE_DEFAULT = "opening-ramp"` but the **profile** default
  `BOARD_MAD_PROFILE_DEFAULT = "opening-ramp-live"` — confirm baselineMode vs
  profile naming doesn't desync anywhere (slice 2b / 9).
