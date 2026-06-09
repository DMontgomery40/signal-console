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

| #   | Slice                                                                                                                                    | Status  | Findings                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | board-volatility **state-space**: Python sidecar `volatility.py`/`models.py` ↔ TS `state-space-runtime.ts`/`state-space-config.ts` ↔ web | done    | F-001 ✅fixed                                                                                                                                                                                                                                                                   |
| 2   | board-mad detector: `sweep.ts` ↔ `clientRecompute.ts` ↔ `baseline.ts` ↔ web preview                                                      | done    | F-002 ✅fixed, F-003 ✅fixed                                                                                                                                                                                                                                                    |
| 2b  | board-mad **dial ranges/defaults** …                                                                                                     | done    | F-004 ✅fixed                                                                                                                                                                                                                                                                   |
| 3   | domain schemas (`schemas/core,live,research`) ↔ DB …                                                                                     | partial | F-005 ⛔deferred (dead model retained; the "122 shared strict-mode errors" were NOT pre-existing — bisected to F-012's barrel import surfacing latent debt via a `scripts/tsconfig.json` strictness mismatch; fixed by aligning the scripts tsconfig flags — see F-012 APPLIED) |
| 3b  | domain live/research schemas ↔ DB ↔ API resp                                                                                             | done    | F-006 ✅fixed (volume-break retracted; impliedProbability guard fixed)                                                                                                                                                                                                          |
| 4   | adapters: source identity, market/instrument mapping                                                                                     | partial | F-007 ✅fixed                                                                                                                                                                                                                                                                   |
| 4b  | adapter market-FAMILY mapping + board family-filtering                                                                                   | done    | F-008 ✅ (family thesis RETRACTED per PRD FR-8/owner; book-vs-market naming residual FIXED)                                                                                                                                                                                     |
| 5   | board-anomaly cluster (`shared/board-anomaly/*`): volatility-model / phase / classifier / residual / h0                                  | partial | F-009 ✅fixed on `main` (redundant `state`/`headlineScore` aliases collapsed; `band`/`score` canonical)                                                                                                                                                                         |
| 5b  | board-anomaly reachability: is the cluster live or parallel/dead?                                                                        | done    | F-010 (PROVEN unreachable from live product; alert surface 0 callers, calibrated baseline table write-only; intent = staged-vs-abandoned, needs owner)                                                                                                                          |
| 5c  | board-anomaly residual/h0/classifier MATH internals (only if owner says "staged/keep")                                                   | todo    | (deferred pending F-010 classification)                                                                                                                                                                                                                                         |
| 6   | API routes ↔ web `data/queries` ↔ OpenAPI metadata (field names, units, nullability)                                                     | done    | clean (board/ensemble-or/detectorDefaults match; suspected dup-key was a false alarm, retracted)                                                                                                                                                                                |
| 7   | explainers copy (`packages/ui/src/explainers.ts`) ↔ actual defaults / math / units / code refs                                           | done    | F-011 ✅fixed (6 citations repointed; verify-citations.ts guard + negative control)                                                                                                                                                                                             |
| 8   | nba-sidecar normalizers/models ↔ TS canonical game/state types ↔ DB persisted shapes                                                     | done    | clean (sidecar→worker→DB game-state path live + shapes/status-enum agree; see note below)                                                                                                                                                                                       |
| 9   | detector registry labels/ids ↔ ids used in runtime/UI/DB/bakeoff                                                                         | done    | clean (3 ids consistent across dispatch/routes/UI; versions composed; only stale label is in historical prd.json — see note)                                                                                                                                                    |
| 10  | env var names: `env.ts` ↔ usage ↔ docs ↔ credential-lookup order                                                                         | done    | F-012 ✅fixed (one `resolveOddsApiKey` in env.ts; all 6 reads delegate; resolver + worker-gate negative-control tests)                                                                                                                                                          |

---

## AUDIT COMPLETE (2026-05-30) — all 10 slices covered

12 findings: F-001..F-008 addressed (6 fixed+verified, F-008 retracted-as-correct +
naming residual fixed, F-006 partial-retract+guard-fixed); F-009/F-010/F-011/F-012
documented. Slices 6/8/9 clean. Three false-alarm scares (ensemble dup-key,
recordGameState "dead", detector-id artifact) all retracted after grep-verification.
Tool channel intermittently garbled output near the end (emits "the the the…" /
collapses identifiers to `ln`/`n`) — every finding was confirmed by repeated clean
reads/greps; trust test execution over single greps.

**Open for owner:** F-010 board-anomaly staged-vs-abandoned classification (a
root-cause pass found the cluster partly live via `normalizeBoardText`, so
removal is unsafe; revisit wire-vs-rewrite when live games return).
**Docs:** `audit/HANDOFF-audit-fixes-2026-05-30.md`,
`docs/audit-2026-05-30-enforced-contracts.md`.

> **Status on `main` (2026-06-09):** every fix above has landed. F-011/F-012
> merged via PR #9; F-007/F-008/F-009 applied directly on the PR #9 branch; the
> F-001/F-004/F-006 fixes plus the F-007 contract test and these audit docs were
> ported from `preserve/main-statespace-20260529` in the branch-parity
> consolidation. Only F-010 remains open.

(Slices may split or merge as the work reveals structure. Add rows; never delete
a done row.)

> **Handoff + enforced-contracts docs:** `audit/HANDOFF-audit-fixes-2026-05-30.md`
> (self-contained, for a no-context successor) and
> `docs/audit-2026-05-30-enforced-contracts.md`. Self-review of the fixes closed 4
> test gaps (F-006 guard, F-004 in-range, F-003 stale-note, F-001 fail-not-skip);
> all written and passing. A suspected ensemble-or dup-key was a false alarm from
> corrupted output — retracted after a clean re-read.

## Fixed (verified 2026-05-30; since landed on `main`)

- **F-001** → shared `state-space-bounds.json` contract + introspection tests on
  both real validators (TS Zod + Python pydantic). Negative control proved the
  guard fails on drift. (4 detector tests pass.)
- **F-002** → deleted the dead client-recompute engine + its falsely-green test;
  kept 3 live exports in new `boardMadDetectorIds.ts`. (web tsc clean.)
- **F-003** → corrected the two false "updates in memory / recomputes in memory"
  copy strings; added a stale note beside the dial. (48 web tests pass.)

Verification: `vitest run state-space` (detectors, 4✅), `vitest run BacktestPage
SensitivityDial` (web, 48✅), `pytest test_state_space_bounds_contract.py`
(sidecar, 1✅), `tsc --noEmit` (web, exit 0).

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
  F-001 for the _enforcement_ gap.
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

## Slice 8 — DONE, CLEAN (sidecar pydantic ↔ TS canonical ↔ DB game-state)

Initial suspicion (recordGameStateObservation might be dead) was **DISPROVEN** by
the full evidence once the delayed tool output arrived — do NOT treat it as a
finding. The path is live and the shapes agree:

- **Live wiring:** worker cycle (`index.ts:419-432`, gated on `NBA_SIDECAR_BASE_URL`)
  → `syncNbaSidecarWindow` (`nba-sidecar.ts`) → `ingestNbaSidecarScoreboard` →
  `recordGameStateObservation` (`live-repository.ts`) → `game_states` table. Also
  reached via the `games-backfill` admin action.
- **Shape agreement:** sidecar `normalize_live_scoreboard_payload`/`_boxscore` →
  pydantic `CanonicalGameState` (capturedAt, status, period, clock, homeScore,
  awayScore, startedAt, finalAt, isFinal) ≡ worker `SidecarGameState` interface
  (`nba-sidecar.ts:29-37`, same fields, nullable-optional) ≡ DB `game_states`
  columns (snake_case). No field drop/rename across the boundary.
- **status enum agrees** across all three (pydantic Literal, worker union, TS
  `researchGameStatuses`): scheduled/in-play/final/postponed/cancelled. The sidecar
  `_normalize_status` maps NBA codes 1/2/3 → scheduled/in-play/final; postponed/
  cancelled arrive via the separate "game vanished from scoreboard" path
  (worker test: "cancels vanished if-necessary games"), not via code mapping —
  coherent, not a gap.
- PBP path (`/play-by-play` → `nba_play_by_play_actions`) and the volatility-model
  POST are the other two sidecar consumers; both already covered (slices 1, 3b).

## Slice 9 — DONE, CLEAN (detector registry ids/labels ↔ runtime/UI/DB/bakeoff)

Completed once the full (delayed) output arrived. An interim scare — a garbled Read
showed a nonexistent `detectorId2`/placeholder and a `detectorId:
...baselineMode` line — was confirmed a TOOL ARTIFACT by targeted grep ("NOT
FOUND"); there is NO such code and NO finding.

- **Single source of truth holds.** Registry ids: `board-mad`, `off-price-print`,
  `ensemble-or`. The runner dispatch switch (`detector-runner.ts:378-414`) has
  exactly those three `case` strings → registry ids; no typo'd case falls through.
- **All consumers use the same three literals:** `board.ts`, `backtest.ts`
  (`asserts id is board-mad|off-price-print|ensemble-or` guard rejects unknown ids),
  routes (`off-price-print.ts`, `ensemble-or.ts`, `detectors.ts`), `settings.ts`
  (version-suffix only for `board-mad`), web `boardMadDetectorIds.ts`, web
  `queries.ts` board queryKey. No id string disagrees with the registry.
- **Detector VERSIONS are composed, not hardcoded-divergent:** ensemble version is
  `${ensembleOr.version}+board=${boardMadDetectorVersion}+off=${offPricePrint.version}`
  and the `/v1/detectors` route mirrors that, so the advertised version tracks the
  real component versions.
- **One stale LABEL in a non-code spec doc (not a runtime disconnect):**
  `scripts/ralph/prd.json` describes displayName "Board MAD (whole-board
  volatility)" while the live registry is "Board State-Space (whole-board
  volatility)". prd.json is historical Ralph story spec, not consumed at runtime —
  cosmetic doc drift, noted not filed. (`progress.txt` similarly references the old
  client-recompute era; also historical.)
