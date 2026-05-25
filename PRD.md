# PRD: Signal Console v2

> **Source plan:** `~/.claude/plans/concurrent-crafting-sedgewick.md` (read it once before starting; this PRD is a full mirror but the plan retains author voice and rationale).
> **Delivery model:** PRD → Ralph autonomous loop. Stop after each phase; review the diff and logs before approving the next.
> **Repo location:** `~/signal-console/` (new sibling repo; old `~/nba-predict/` becomes reference-only after Phase 0).

---

## 1. Introduction / Overview

`~/nba-predict` is a player-prop "Signal Console" intended to give a trading desk a fast tripwire when a player stat looks misallocated. It has accreted into ~73k LOC across `apps/` and `packages/` with five sprawling layers, contradictory thresholds, an admin queue, lazy baseline rebuilds masquerading as live reads, and a 1,246-LOC `SettingsPage`. The owner's read: 75 %+ of the lines are worthless or actively harmful, the app has never loaded cleanly without major errors, port misconfigurations recur, and it tries to load tens of GB on routine button clicks. The 54 GB SQLite tick store at `data/signal-console.sqlite` is, by contrast, gold and must not be touched.

This PRD describes a clean rebuild in a new sibling repo at `~/signal-console/`. The new app is:

- A small, dead-reliable **read-only** API serving small live slices, so trading-desk integrators can rely on it and a front-end can render the last 24 h without scanning the store.
- A focused front-end with **three** primary views: last-24-h list (default), live single-game (opt-in), and a backtest tab with visible Sensitivity and Signal timing controls.
- An entry point for the data team to drop in their own detector (Gaussian non-linear, sport-specific, etc.) without touching the core code.
- Pedantic linting, Pydantic, Zustand, spec-driven + test-driven.
- Sport-agnostic from day 1 (NFL + NCAA football named as first-class), but no speculative scaffolding for sports we are not yet ingesting.
- The 54 GB SQLite is **moved at phase 0** to `~/signal-console/data/signal-console.sqlite` (with `-wal` and `-shm` siblings); the API/UI/cache paths open it read-only thereafter. The old `~/nba-predict/data/...` location becomes reference-only with a loud sentinel.

The "Sensitivity adapter" is not a new algorithm — it is the existing `K_MAD` multiplier on the trailing `median + K·MAD` board-volatility threshold, which the live runtime currently hard-codes to `3` while the research backtest uses `6.0`. The research report says `K=3` produces ~18 fires/game ("sensitive, catches 5 of 6"), `K=6` produces ~9 fires/game (the "calmer" comparison preset). The video plan narrates this verbatim as "It's a dial." Exposing it honestly is the headline feature.

---

## 2. Goals

- **Reliability:** Dead-reliable, lightweight, read-only API path. Zero writes to the gold DB from the API/UI/cache layer.
- **Performance budgets:** Recent (24-h list) < 500 ms warm / < 2 s cold for ~20 games; one game's live view < 300 ms; one market's timeline < 300 ms; backtest 28-day / ~20-game first sweep < 60 s, cached subsequent K change < 1 s; Settings < 100 ms.
- **Focus:** **Three** primary views — Recent (default), Live (opt-in), Backtest (dials). One additional view (Detectors) for registry browsing, and Settings for diagnostics. Nothing else.
- **Headline feature:** The Sensitivity adapter — a continuous Backtest dial with two labelled snap points (`3.0` sensitive/live default, `6.0` calm comparison preset). The Signal timing panel exposes `baselineMode`, `openingBaselineBuckets`, `openingRampCompleteBuckets`, `trailingBuckets`, and `warmupBuckets` with exact elapsed durations from `bucketSeconds` where applicable.
- **Extensibility:** Detector registry; new detector = one file under `packages/detectors/src/<name>/index.ts` + one line in `registry.ts`.
- **Math honesty:** K = 3.0 is the live/Recent/default operating value. K = 6.0 is a Backtest-only calmer preset. Both declared once in `packages/detectors/src/board-mad/config.ts`. K is a compute parameter, never persisted in the gold DB.
- **Stay focused:** the old repo was 73k LOC of bloat; the new one should be small by intent. No hard per-file or total LOC ceiling — judgment over numbers.
- **Sport-agnostic from day one:** NBA + (future) NFL/NCAA football, via SQL CTEs in query modules. No new tables until a second sport's data lands.
- **Hosting:** Local compute (Vite preview UI, Fastify API, SQLite read-only on local disk). Reach via existing Cloudflare Tunnel at `nba-predict.dtmont.com` (parked during Phase 0 cutover, repointed in Phase 1).
- **Gold DB is gold:** Moved once at Phase 0, opened read-only thereafter, never altered by the API path.

---

## 3. Decisions locked

| Decision                 | Choice                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Hosting (compute)        | **Local-only.** Vite preview for UI, Fastify for API, SQLite read-only on local disk.       |
| Hosting (reach)          | **Cloudflare Tunnel** keeps the existing `nba-predict.dtmont.com` subdomain. Tunnel is **parked** during Phase 0's cutover (no public surface, by intent), and **repointed** to the new API on `localhost:32140` in Phase 1, only after smoke passes. Subdomain rename deferred. |
| Repo location            | **New sibling repo** at `~/signal-console/`. Name matches the existing `@signal-console/*` package scope inside `nba-predict`, so utility ports keep their import paths. Old `~/nba-predict` is not deleted. |
| Delivery                 | **PRD → Ralph loop.** This plan file becomes the PRD's architecture spec.                   |
| Stack                    | React 19 + Vite 6 + Tailwind + Tanstack Query + Zustand + Recharts + Zod + Fastify + better-sqlite3. Python sidecar stays Pydantic v2 + nba_api. |
| Gold-DB path             | **Moved at Phase 0 (no crossover)** from `~/nba-predict/data/signal-console.sqlite` to `~/signal-console/data/signal-console.sqlite` (plus `-wal` and `-shm`). Old path gets a sentinel so any accidental old-worker startup fails loudly. |
| Gold-DB write posture    | **Strictly read-only** for the new app's API/UI/cache. Gold DB opened with `?mode=ro` URI + `PRAGMA query_only=ON`; runtime assertion in `packages/db/src/open.ts` fails startup if either is missing. The API path writes **zero rows** to the gold DB across its lifetime. (A future ported ingest writer is the only authorised writer and is scoped, gated, and out of scope for the API path.) |
| Derived state            | A separate **cache DB** at `~/signal-console/data/detector-cache.sqlite`, owned and freely writable by the new app. Keyed by detector id, version, params hash, and a **scoped source watermark hash** (per-game and per-window) computed at compute time. Throwaway; losing it just triggers recompute. |
| Worker / ingest          | Old `nba-predict/apps/worker` is **dead after Phase 0**. No shadow period, no crossover. If live ingest is needed in the next few days, port the minimal slice of the old worker into `~/signal-console/apps/worker/` as **Phase 0.5**, writing to the moved DB path. Otherwise live ingest pauses until Phase 0.5 ships. |
| Sport-agnosticism        | SQL **CTEs in query modules**, referencing the read-only gold DB. No startup-time `CREATE TEMP VIEW` (incompatible with `PRAGMA query_only`). New table additions wait for the second sport's data. |
| Canonical math (K_MAD)   | **K = 3.0** (volume-weighted) is the **live / Recent / default** operating value (matches the video/bakeoff "sensitive: ~18 nudges/game, catches 5 of 6"). **K = 6.0** is a Backtest-only calmer comparison preset (~9 nudges/game; the precise "catches N of 6" number is not asserted unless the current bakeoff artifact supports it). The Backtest dial sweeps continuously between them. Both values declared in `packages/detectors/src/board-mad/config.ts`; the runtime/UI default is the K=3 entry. K is a **compute parameter, not a persisted dimension** — the gold DB has no K column anywhere. |

---

## 4. What dies (do NOT port from `nba-predict`)

- `apps/web/src/features/desk/TraderDeskPage.tsx` — fans out to **13** endpoints on mount (`getAdminCaptureRuns`, `getAdminSources`, `getAdminStorageCoverage`, `getClosedGames`, `getBoardVolatility`, `getDivergence`, `getGames`, `getInstrumentLeadLag`, `getInstrumentTimeline`, `getLiveHealth`, `getMarketAnomalies`, `getReadyHealth`, `getSignalQualityReport`). This is the "60 GB on a button click."
- `apps/web/src/features/settings/SettingsPage.tsx` — 1,246 LOC / 44 KB.
- `apps/web/src/data/api.ts` — 53 KB / 40+ exported `get…` functions; replace with ~10 typed query hooks.
- The 17-file `packages/shared/src/board-anomaly*` cluster — collapse to one TypeScript port of `scripts/board_signal_v2.py` (~180 LOC, clean).
- `packages/shared/src/live-repository.ts` — 3,300 LOC; rewrite as ~6 small query modules under `packages/db/src/queries/`.
- `apps/api/src/services/research-service.ts` (1,437 LOC) and `health-service.ts` (610 LOC) — replace with small per-route service files, cap at ~150 LOC each.
- The market-anomaly score-config PUT endpoint (no end-user, no UI for it that matters).
- Root-level orphans: `Bet365SignalConsole.tsx`, `bet365_nba_signal_console_memo.docx`, `bet365_nba_signal_console_proposal.md`, `output-playwright-bet365-nba.png`, `qa-cases*.png`, `qa-full.png`, `report-fullpage.jpeg`, `tmp-prop-divergence-browser.png`.
- `.docs-archive/2026-05-repo-audit/` — keep on disk in `~/nba-predict` for historical reference; do not import into new repo.
- 7 spec files in `specs/` — collapse to **3**: `product.md`, `runtime.md`, `data-contract.md`.
- The `BOARD_VW_K_MAD = 3` vs `K_MAD = 6.0` divergence — new repo separates them by purpose: **K = 3.0 live default**, **K = 6.0 Backtest calm preset**. Both declared in `packages/detectors/src/board-mad/config.ts`. Neither value is hardcoded anywhere else.
- `apps/worker` admin queue (`drainQueuedAdminActions`, `enqueueBoardVolatilityBaselineRebuild`, `markets-backfill`, `games-backfill`) — there is no admin UI worth keeping. Phase 0.5 (if it ships) brings only the bare ingest loop, no admin queue.
- `scripts/temporary-auth-proxy.mjs`, `scripts/probe-*` — research artifacts, not runtime.

---

## 5. What survives (port carefully, with cleanup)

- **Algorithm reference:** `scripts/board_signal_v2.py:1-220` is the canonical, honest implementation of the board-MAD detector. Port to TypeScript verbatim as the first detector.
- **Schema reference (read-only):** `packages/shared/src/migrations.ts`. New repo never runs migrations; this file is the schema documentation.
- **Math utilities** worth porting (pure functions, no DB coupling): `apps/web/src/lib/game-state.ts`, `time-format.ts`, `market-format.ts`, `source-coverage.ts`, `game-triage.ts`, `divergence-history.ts`, `chart-theme.ts`. Each has tests already.
- **Sidecar:** `apps/nba-sidecar/` ports into `~/signal-console/apps/sidecar/` as part of Phase 0.5 if/when ingest is needed.
- **Codex bug-fix-regression hooks** at `.codex/hooks.json` — adopt the same guard policy in the new repo's `.codex/hooks.json`.
- **The 30 `board_volatility_baselines` rows** — leave them. They are expected-range bands keyed by phase / source / core-family (NOT by K). The new app may read them for an optional UI band overlay; it does not depend on them for any fire decision.

---

## 6. Repo layout

```
~/signal-console/
├── apps/
│   ├── api/                # Fastify; ~8 routes; read-only SQLite
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── games.ts           # /v1/games, /v1/games/:id
│   │   │   │   ├── live.ts            # /v1/live/:gameId (current view)
│   │   │   │   ├── board.ts           # /v1/board/:gameId (board fires for one game, given K)
│   │   │   │   ├── microstructure.ts  # /v1/microstructure/:gameId
│   │   │   │   ├── backtest.ts        # POST /v1/backtest (detector + params + window)
│   │   │   │   ├── detectors.ts       # GET /v1/detectors (registry; schemas)
│   │   │   │   ├── settings.ts        # /v1/settings (DB info, error log)
│   │   │   │   └── health.ts          # /v1/health/live, /v1/health/ready
│   │   │   └── services/              # ≤400 LOC each, one per route
│   │   └── tests/                     # vitest + a real-DB smoke
│   ├── web/                # React 19 + Vite 6 + Tailwind + Zustand
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── app/                   # routing + tiny zustand store
│   │   │   ├── features/
│   │   │   │   ├── recent/            # default route (last 24 h)
│   │   │   │   ├── live/              # opt-in current-game live view
│   │   │   │   ├── backtest/          # Sensitivity dial + sweep
│   │   │   │   ├── detectors/         # registry listing + BYO entry point
│   │   │   │   └── settings/          # DB + sources + error log
│   │   │   ├── data/                  # tanstack-query hooks; ~10 functions
│   │   │   └── components/            # tailwind primitives
│   │   └── e2e/                       # playwright; 3 happy paths
├── packages/
│   ├── db/                 # read-only sqlite + typed queries; no schema
│   │   └── src/
│   │       ├── open.ts                # opens with ?mode=ro, sets timeouts
│   │       ├── queries/               # one file per query, ≤200 LOC each
│   │       └── views/                 # SQL view definitions applied to an in-memory clone for dev (never to the gold DB)
│   ├── detectors/          # detector registry + first 2 detectors
│   │   └── src/
│   │       ├── registry.ts
│   │       ├── types.ts               # Detector<TParams> interface
│   │       ├── board-mad/             # K_MAD detector (port of board_signal_v2.py)
│   │       └── off-price-print/       # volume-share + off-price distance
│   ├── domain/             # Zod schemas for wire types only
│   └── ui/                 # tailwind tokens + headless primitives
└── apps/sidecar/           # (phase 0.5, conditional) python sidecar port/wrap if live ingest is needed
```

The new repo should be **small by intent** — the old repo was 73k LOC of bloat (1,246 LOC SettingsPage, 3,300 LOC live-repository.ts). No hard LOC ceiling; focused modules that happen to be long are fine. The anti-pattern is conflated mega-files.

---

## 7. The Sensitivity adapter (mechanics, explicit)

This is the only novel UI element in the rebuild; getting it right is the headline.

**What it is.** A slider on the Backtest tab that adjusts `K_MAD` (the multiplier on the trailing MAD in the board-volatility fire rule `intensity > median(prior elapsed lookback) + K · MAD(prior elapsed lookback)`).

**Range and presets.** Continuous slider `2.0 ≤ K ≤ 8.0`, step `0.25`. Default position is the **live K = 3.0**; the dial exists to explore sensitivity around that anchor. Two labelled snap points matching the video narration:

- **Sensitive — live default** — `K = 3.0` (volume-weighted), ~18 fires/game, video/bakeoff narration "caught 5 of 6".
- **Calm — comparison preset** — `K = 6.0`, ~9 fires/game (the "catches N of 6" number is not labelled in the UI unless the current bakeoff artifact supports it).

**Live preview.** As the slider moves, the page shows:

- Estimated fires/game across the selected window (recomputed in memory; no DB scan).
- A small timeline per game in the window with fire markers at the chosen K.
- For each of the two PBP-anchored incidents (Reaves/Hayes, Hartenstein) the lead time at the current K (or "no fire" if applicable; the report's honest finding).

**What it does NOT do.**

- Does not change the K used by Live or Recent. Those views always run at the live default **K = 3.0**. The dial in Backtest is for sensitivity exploration *around* the live default, not for re-defining it.
- Does not write to the gold DB. Backtest is in-memory compute; results are cached in the cache DB by `params_hash`.
- Does not promise it's the only knob a sport will ever need. The Detectors tab is where alternate detectors are added.

**Implementation budget.** A 28-day, 30-game sweep at one K value: pre-bucket in a single SQL pass (already index-supported), then resweep K in JS — microseconds per K. End-to-end target < 60 s for the first sweep, < 1 s per subsequent K change.

---

## 8. Math correctness invariants

TDD + SDD principles fail if the math under test is wrong. The new repo honours both K values the project measured but assigns them distinct operational meanings, and locks each via contract tests so they cannot drift.

1. **Canonical live default:** `K_MAD_LIVE = 3.0`, weighting `"volume"` — the sensitive setting from the video/bakeoff: ~18 fires/game, "catches 5 of 6" per that artifact. This is what Recent, Live, and any non-Backtest surface uses. Justification: for a suspend-signal whose miss cost (an exposed bad market) exceeds the per-fire review cost, the higher-recall setting wins.
2. **Backtest calm preset:** `K_MAD_CALM = 6.0` — the calmer comparison from the research report (`scripts/board_signal_v2.py:33`): ~9 fires/game. The "catches N of 6" number is **not** committed to in the plan/UI unless and until a current bakeoff artifact supports it; the dial UI labels the preset by fire-rate only.
3. Both constants live in `packages/detectors/src/board-mad/config.ts`, re-exported as the only K values the API, UI, and cache layer consume. **No other file declares a default for K.**
4. **K is a compute parameter, not a persisted dimension.** The `board-mad` detector iterates `quote_ticks` in time order, buckets by the configured `bucketSeconds`, computes a causal baseline `median(selected prior sample) + K · MAD(selected prior sample)` on the fly, and fires when current bucket intensity exceeds the threshold (after elapsed holdoff `warmupBuckets × bucketSeconds`, with a 300 s fresh-cap on per-market deltas and the `is_heartbeat` / `0.500` opening-anchor sanitations). The live default prior sample is `baselineMode="opening-ramp"`: first active alert checks compare against the opening elapsed duration `openingBaselineBuckets × bucketSeconds` and graduate to rolling memory at `openingRampCompleteBuckets × bucketSeconds`. Backtest and Settings also expose `baselineMode="historical-blend"`, which starts from last-five same-side NBA priors, fades them out by game-clock elapsed time, uses game-clock memory for the current-game baseline, and can add a short wall-clock recent tack-on for timeout/dead-ball betting bursts. **Nothing about K lives in the gold DB**; it is purely a knob inside the detector's compute loop.
5. **The gold DB's `board_volatility_baselines` table is NOT a fire decision store.** Its rows are expected-range bands (p50/p75/p90/p99) keyed by phase / source / core-family for UI band overlays, written by the old worker. The new app may read them for a band overlay; it does **not** depend on them for any fire decision. The `cohortKey` label in `nba-predict`'s TypeScript runtime embeds K only for display purposes (`game-state-volatility.ts:697`, `:880`), not as a persisted key.
6. **Detector contract tests** (`packages/detectors/src/board-mad/__tests__/canonical.test.ts`) run against committed JSON fixture extracts (small slices of `quote_ticks` for the two anchored games — **not** against the gold DB). The tests lock in outcomes at **both** K values:

   - **At K = 6.0** (the report's validated values):
     - **Hartenstein** (event `2026-05-08T03:12:36.8Z`, game `nba-0042500222`): the bucket starting `03:12:00Z` fires; the watcher confirms at bucket-end `03:13:00Z`, which is ≈ T+23 s after the event. Both timestamps are named in the assertion so future readers cannot conflate raw detector output (bucket-start) with watcher confirmation time (bucket-end).
     - **Reaves** (event `2026-05-12T04:51:40.2Z`, games `nba-0042500223` and `nba-0042500224`): **does not fire** on either game id. The report's honest null case for the board lane.
     - **Mean fires per game across the 64-game PBP set:** 9.3 ± 1.0 equal-weight (8.6 volume-weight). Both within tolerance.
   - **At K = 3.0** (the live default; values seeded at Phase 0 by running the canonical implementation on the same fixtures and snapshotting):
     - Hartenstein bucket-start: same `03:12:00Z` (K=3 is more sensitive, so it cannot fail to fire when K=6 fires); test asserts ≥ 1 fire in the in-play window.
     - Reaves: the test snapshots **whatever the canonical implementation produces** at K=3 (the report doesn't measure this; we measure it once at Phase 0 and lock the answer). Any future change is a review event.
     - Mean fires per game: the test snapshots the K=3 number from the 64-game fixture set (directional expectation: ~18, per the video/bakeoff narration).

7. **No silent K change.** Any future change to either canonical K is a deliberate migration: a config-file edit, fresh contract-test snapshots, and a bumped `detector_version` (so existing cache rows for the old K naturally become misses and recompute). There is no runtime config toggle that quietly substitutes a different K.

### 8.1 board-mad math change history

| Version | When | What changed | Why |
| --- | --- | --- | --- |
| 1.0.0 | 2026-05-23 | Initial TypeScript port of `nba-predict/scripts/board_signal_v2.py`. | Bring the canonical board-mad detector into the new repo. |
| 1.1.0 | 2026-05-23 | API path narrowed tick load per-game to the PBP-anchored in-play window. | Pre-narrowing, pre-game ticks polluted the trailing baseline and inflated fire counts ~14-17×. |
| 1.2.0 | 2026-05-24 | Signal timing extracted to `baseline.ts` with explicit opening-ramp mode. | Make the ramp + holdoff knobs tunable without touching the detector loop. |
| 1.3.0 | 2026-05-24 | Historical/live blended baseline added (5-game prior fading to live). | David-requested historical context for cold-start games. |
| 1.4.0 | 2026-05-24 | Opening holdoff redefined as elapsed time (`warmupBuckets × bucketSeconds`), not sparse-bucket count. | Fixed the "8 minutes = 8 sparse market blips" failure mode the live game caught. |
| 1.5.0 | 2026-05-24 | Trailing/opening-ramp baseline sample selected by elapsed time, not sparse-index slice. | Closed the silent silent-noise inflation where "last 20 minutes" actually meant "last 20 nonzero buckets" — quiet games drew baselines from non-quiet windows. |
| 1.6.0 | 2026-05-25 | PBP-missing elapsed fallback anchors on per-game `GameTimingContext.tipoffAnchorUtc` (PBP `MIN(time_actual)` → `games.scheduled_start` → fail-closed). Historical-blend gameValues filter honors the same tipoff anchor. Historical priors combined with weighted-pooled samples (away/home symmetric regardless of sample-size imbalance). `liveValuesForHistoricalBucket` returns a typed `{median, mad}` estimator instead of a synthetic `[m-mad, m, m+mad]` tuple. | Closed the audit's last category of "fake math" — never anchor elapsed on "first nonzero market bucket"; never let one side dominate priors by sample-count accident; never launder summary stats through a fake sample. |

> v1.6.0 ships through the shared `services/detector-runner.ts` introduced in phase A0 (2026-05-25). Live (`/v1/board/:gameId`), the new live ensemble route (`/v1/ensemble-or/:gameId`), the new live off-price route (`/v1/off-price-print/:gameId`), and Backtest all consume the same execution path — no live-vs-backtest math drift surface. The runner's watermark hash includes `clockSource` + `tipoffAnchorUtc`, so a `scheduled`-anchored cache row automatically invalidates when PBP arrives.

---

## 9. Detector output cache (the new app's only writable store)

The gold DB is strictly read-only. Anything the new app needs to "remember" about detector runs lives in a separate writable cache DB owned entirely by this repo.

- **File:** `~/signal-console/data/detector-cache.sqlite` (note the hyphen, to distinguish from the gold `signal-console.sqlite` in the same dir).
- **Owned by:** this repo; safe to delete or recreate at any time.
- **Schema:** managed by simple migrations under `packages/db/src/cache-migrations/`. Sketch:

  ```sql
  CREATE TABLE detector_runs (
    id INTEGER PRIMARY KEY,
    detector_id TEXT NOT NULL,            -- e.g. 'board-mad'
    detector_version TEXT NOT NULL,       -- e.g. '1.0.0'
    params_hash TEXT NOT NULL,            -- sha256 of canonical-JSON of params
    params_json TEXT NOT NULL,            -- raw params for debugging
    source_db_path TEXT NOT NULL,         -- absolute path to gold DB
    source_watermark_hash TEXT NOT NULL,  -- sha256 of scoped watermark tuple (see Freshness model)
    scope TEXT NOT NULL CHECK (scope IN ('game','window')),
    game_id TEXT,
    window_start TEXT,
    window_end TEXT,
    computed_at TEXT NOT NULL,
    compute_ms INTEGER NOT NULL,          -- for SLO regression tracking
    UNIQUE(detector_id, detector_version, params_hash,
           source_watermark_hash, scope, game_id, window_start, window_end)
  );

  CREATE TABLE detector_observations (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES detector_runs(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    bucket_start TEXT NOT NULL,
    bucket_end TEXT NOT NULL,
    fired INTEGER NOT NULL,               -- 0 or 1
    intensity REAL,
    baseline_median REAL,
    baseline_mad REAL,
    detail_json TEXT
  );
  CREATE INDEX idx_detector_obs_run_game
    ON detector_observations(run_id, game_id, bucket_start);
  CREATE INDEX idx_detector_obs_fired
    ON detector_observations(run_id, fired);
  ```

**Freshness model — scoped source watermarks**

A cache hit requires identical `source_watermark_hash`, computed at lookup time from per-scope watermarks. The model deliberately avoids any global invalidation token, because the Phase-0.5 ingest writer (when running) writes ticks across many games; we want per-game / per-window invalidation, not blanket invalidation.

- **Game scope** — for a given `game_id`, the watermark tuple is:
  - `quote_ticks`: `(count, max(id), max(captured_at))` filtered by the game's instrument set.
  - `market_microstructure_events`: `(count, max(id), max(event_timestamp))` filtered by `game_id`.
  - `nba_play_by_play_actions` (or the sport-equivalent table): `max(time_actual)` filtered by `game_id`.
  - `game_states`: `max(captured_at)` filtered by `game_id`.

  The tuple is canonical-JSON'd and SHA-256'd to produce `source_watermark_hash`. Each component is a small read backed by an index; computing the watermark is sub-millisecond per game.

- **Window scope** — the same per-game tuple computed for every game whose `scheduled_start` falls inside the requested window, then combined (concatenated in stable order and SHA-256'd). Adding, removing, or growing any game in the window naturally changes the hash.

Operationally: **closed games** (no new ticks) stay warm because their watermarks don't change; **active games** (ingest writing new ticks) recompute on the next render because their watermark moves. There is no shared/global invalidation step — each cache lookup independently computes its own watermark and compares.

**Reset**

- `pnpm cache:reset` deletes `detector-cache.sqlite`.
- `DELETE /v1/cache` exposed from the API; Settings UI surfaces a "clear cache" button. Affects only the cache DB.

**Backup**

- Not backed up. Derived state. If lost, recompute fills the cache lazily on next access.

---

## 10. Detector registry & "bring your own math"

The "data engineering team wants Gaussian non-linear" use case maps to a registry of named detectors. Each detector is **one TypeScript file** under `packages/detectors/src/<name>/index.ts` exporting:

```ts
import { z } from "zod";
import type { Detector } from "../types";

const Params = z.object({
  bucketSeconds: z.number().int().min(10).max(300).default(60),
  kMad: z.number().min(1).max(12).default(3.0),               // live default
  weighting: z.enum(["volume", "equal"]).default("volume"),   // live default: volume-weighted
  trailingBuckets: z.number().int().min(5).max(60).default(20),
  warmupBuckets: z.number().int().min(2).max(20).default(8),
  baselineMode: z.enum(["trailing", "opening-ramp", "historical-blend"]).default("opening-ramp"),
  openingBaselineBuckets: z.number().int().min(1).max(60).default(4),
  openingRampCompleteBuckets: z.number().int().min(2).max(120).default(20),
  historicalLastGames: z.number().int().min(1).max(20).default(5),
  historicalAwayWeight: z.number().min(0).max(1).default(0.5),
  historicalPriorWeight: z.number().min(0).max(1).default(1),
  historicalRampCompleteGameMinutes: z.number().min(1).max(48).default(12),
  trailingGameMinutes: z.number().min(1).max(48).default(12),
  recentWallMinutes: z.number().min(0).max(20).default(4),
  recentWallWeight: z.number().min(0).max(5).default(1.5),
  freshCapSeconds: z.number().int().min(30).max(3600).default(300),
});

export const detector: Detector<typeof Params> = {
  id: "board-mad",
  version: "1.6.0",
  displayName: "Board MAD (whole-board volatility)",
  paramsSchema: Params,
  run(window, params) {
    /* return { fires: BoardFire[], stats: { firesPerGame, ... } } */
  },
};
```

The UI auto-renders parameter controls from the Zod schema (number → slider, enum → select, boolean → switch). A data engineer adds a new detector by:

1. Dropping a new file under `packages/detectors/src/<name>/index.ts`.
2. Adding its export to `packages/detectors/src/registry.ts` (one line).
3. Running `pnpm verify`.

No UI changes required for a new detector to appear in Backtest and the Detectors tab. Per-sport detectors override the same interface; the registry can hold (e.g.) `board-mad-nba` and `board-mad-nfl` once we know the football aggregate is meaningfully different.

The initial registry ships with **two** detectors:

- `board-mad` — direct port of `scripts/board_signal_v2.py` (~180 LOC).
- `off-price-print` — concentrated-print detector with params `{ minVolumeShare = 0.10, minOffPriceDistance = 0.40 }`, sourcing from `market_microstructure_events` filtered by `game_id` (Polymarket only — the report documents this limit and the UI will say so).

---

## 11. Gold-DB safety (read-only API path, one-time relocation)

The 54 GB tick store is gold. After Phase 0 it lives at `~/signal-console/data/signal-console.sqlite`. The API/UI/cache paths never open it writable.

1. **Open path** (`packages/db/src/open.ts`). Every API/UI gold-DB connection layers four independent guards (any one of them in place should be sufficient; all four together is belt-and-suspenders):
   - URI: `file:${GOLD_DB_PATH}?mode=ro`
   - better-sqlite3 options: `{ readonly: true, fileMustExist: true }`
   - `PRAGMA busy_timeout=5000`
   - `PRAGMA query_only=ON` then read back via `db.pragma("query_only", { simple: true })`; if the value is not `1`, throw `Error("gold DB connection is not query_only")` at startup.

   ```ts
   import Database from "better-sqlite3";
   const url = `file:${path}?mode=ro`;
   const db = new Database(url, { readonly: true, fileMustExist: true });
   db.pragma("busy_timeout = 5000");
   db.pragma("query_only = ON");
   const queryOnly = db.pragma("query_only", { simple: true });
   if (queryOnly !== 1) {
     throw new Error("gold DB connection is not query_only");
   }
   return db;
   ```

   There is no code path in the API/UI/cache that opens the gold DB with default permissions.

2. **The future ingest writer is the only authorised writer.** If Phase 0.5 ports a minimal ingest writer into `~/signal-console/apps/worker/`, that writer opens the gold DB with default WAL permissions for its INSERTs and is the **only** code allowed to do so. It lives in its own package, never shares its DB handle with the API, and is reviewed against the same backup-first procedure.

3. **Relocation procedure (Phase 0, one-shot).** This is the hard cutover. No shadow. No crossover. Procedure documented in `docs/gold-db-relocation.md`. Each step is a manual checkpoint — do **not** wrap this in a single script. Each Bash invocation is reviewed and approved individually. No bypass-permissions.

   ```bash
   # a. Stop the old app's processes — explicit checklist (do NOT just
   #    pkill blindly; identify and stop each one, then verify):
   #    1. In each terminal running `pnpm dev` for nba-predict, send
   #       Ctrl-C and wait for the shutdown log line.
   #    2. If you started anything under nohup/pm2/launchd/systemd, stop
   #       it via that manager's command.
   #    3. Verify nothing matching the project is still running:
   #          ps aux | grep -E "signal-console/(worker|api|web)|tsx .*signal-console|vite .*signal-console" \
   #             | grep -v grep
   #       must show no rows (besides your grep). If any row remains,
   #       stop that PID explicitly (`kill <pid>`).
   #    4. Verify the old API port is closed (replace 4000 with the
   #       value from ~/nba-predict/.env or the `defaultApiPort` constant
   #       in `@signal-console/shared`):
   #          lsof -iTCP:4000 -sTCP:LISTEN
   #       must return empty.
   # b. Park the Cloudflare tunnel — manual step. Stop the cloudflared
   #    service (or set it to a maintenance config) so nothing public
   #    hits the old API. Verify:
   #          curl --fail --max-time 5 https://nba-predict.dtmont.com
   #    should fail (any 5xx / connection error is acceptable). Do NOT
   #    auto-repoint here; phase 1 repoints to localhost:32140 only after
   #    smoke passes.
   # c. Confirm no holders of the gold DB files:
   #          lsof | grep "nba-predict/data/signal-console.sqlite"
   #    must return empty. If anything appears, stop the holder first;
   #    do not proceed.
   # d. Optional safety backup if disk permits (~54 GB free):
   #          df -h ~
   #          sqlite3 ~/nba-predict/data/signal-console.sqlite \
   #              ".backup ~/db-backups/signal-console-$(date +%Y%m%dT%H%M%SZ).sqlite"
   #    Then verify the backup:
   #          sqlite3 ~/db-backups/signal-console-*.sqlite \
   #              "PRAGMA integrity_check;" | grep -qx ok
   # e. Move main + WAL + SHM (same APFS volume → atomic rename):
   #          mkdir -p ~/signal-console/data
   #          mv ~/nba-predict/data/signal-console.sqlite       ~/signal-console/data/
   #          mv ~/nba-predict/data/signal-console.sqlite-wal   ~/signal-console/data/ 2>/dev/null || true
   #          mv ~/nba-predict/data/signal-console.sqlite-shm   ~/signal-console/data/ 2>/dev/null || true
   # f. Integrity check the moved DB:
   #          sqlite3 -readonly ~/signal-console/data/signal-console.sqlite \
   #              "PRAGMA integrity_check;" | grep -qx ok
   #    If this fails, halt; do NOT proceed to step g; consider rolling
   #    back by moving the files back to ~/nba-predict/data/.
   # g. Sentinel at the old path so accidental old-worker startup fails
   #    loudly:
   #          echo "MOVED to ~/signal-console/data/signal-console.sqlite on $(date)" \
   #              > ~/nba-predict/data/MOVED.txt
   #          touch ~/nba-predict/.DEPRECATED
   # h. (Phase 1) Repoint Cloudflare to the new API once smoke passes.
   ```

   The new app's `GOLD_DB_PATH` env / config defaults to `~/signal-console/data/signal-console.sqlite`; the old path is **never** referenced in code.

4. **Future writes** are out of scope for the API/UI. If a future task requires writing to the gold DB outside the ingest writer, it is its own proposal with its own backup procedure; the default answer is no.

---

## 12. WAL / SHM invariants

`data/signal-console.sqlite-wal` and `data/signal-console.sqlite-shm` are sibling files SQLite needs for WAL-mode concurrency. The new app:

- **API/UI never** deletes, renames, moves, checkpoints, or alters the journal mode. Opens with `?mode=ro` + `PRAGMA busy_timeout=5000` + `PRAGMA query_only=ON`. Read-only mode sees through the WAL automatically.
- During the **Phase-0 relocation**, all three files (`-`, `-wal`, `-shm`) are moved together while no writer holds them. SQLite will reconstruct `-shm` on the next open; the `-wal` carries any uncommitted state. The procedure does not run a checkpoint before the move (no writable connection is held); the next regular write inside the future ingest writer will checkpoint naturally.
- A Phase-0.5 ingest writer (if ported) keeps default WAL mode for its writes; the API/UI read-only opens never block writers and writers never block readers (snapshot reads via WAL).

---

## 13. Trading-desk reach

The trading desk's primary near-term use is consuming the API. We host compute locally; reach is via the existing **Cloudflare Tunnel** behind `nba-predict.dtmont.com`. The tunnel is **parked** during Phase 0's cutover and **repointed** to the new `signal-console/apps/api` on `localhost:32140` in Phase 1, only after the Phase-1 smoke (`GET /v1/games`) passes.

- **Subdomain:** keep `nba-predict.dtmont.com` for now. Rename to `signal.dtmont.com` is a Phase-5 cleanup item.
- **OpenAPI:** Fastify with `@fastify/swagger` emits `/openapi.json` automatically. Every route declares Zod schemas → JSON Schema → OpenAPI; the desk codes against the spec, not against route prose.
- **Versioning:** every route is prefixed `/v1/…`. Breaking changes ship as `/v2/…` next to `/v1/…`; no in-place mutation.
- **Auth (Phase 1):** a single shared header `X-Signal-Token` checked at the API edge. Token rotated by editing `~/.signal-console/token` on the laptop (the file is the source of truth, not an env var; rotating it doesn't require restarting Fastify). Phase 2 may add per-team tokens.
- **Rate-limit / kill switch:** the Cloudflare Tunnel can be torn down with one `cloudflared` command; the API has no other public surface, so a leak's blast radius is bounded by the tunnel's lifetime.
- **Desk-stable routes (frozen at v1):** `/v1/games`, `/v1/live/:gameId`, `/v1/board/:gameId`, `/v1/microstructure/:gameId`, `/v1/detectors`. These are the desk's contract.
- **UI-internal routes (may change):** `/v1/backtest` (request shape may evolve), `/v1/settings`, `/v1/health/*`. The OpenAPI doc tags them `internal`; the desk treats them as best-effort.

---

## 14. Sport-agnostic data layer (CTEs in query modules)

The gold DB's NBA-specific tables (notably `nba_play_by_play_actions`) cannot be renamed without breaking the worker. The new repo provides a sport-agnostic abstraction via SQL **CTEs in query modules**, not startup-time `CREATE TEMP VIEW`s.

Why CTEs and not TEMP VIEWs: `PRAGMA query_only=ON` (which the open path enforces for the gold DB) blocks `CREATE TEMP VIEW`. The workarounds (create the views before flipping `query_only`, or attach a writable in-memory schema first) all introduce ordering hazards or extra surface area. CTEs avoid both, keep each query self-contained, and snapshot cleanly in the `EXPLAIN QUERY PLAN` tests.

The shared CTE fragments live in `packages/db/src/sport-views.ts` as exported TypeScript template strings; query modules `import` them. Shape (exact column names verified at Phase-0 query-plan smoke against the gold DB — drift in column names is a one-file fix, not a propagation event):

- `v_games` — projects from `games` (which already has a `sport` column — no need to derive it from `league`): game id, sport, league, scheduled_start, the JSON team identifiers (`home_participant_json`, `away_participant_json`), and a correlated subquery against the **latest** `game_states` row for the game's current status. The exact status column name in `game_states` is verified at Phase 0.
- `v_events` — projects from `nba_play_by_play_actions` with `'NBA'` injected as `sport`. Future: `UNION ALL` whatever football PBP table lands when football ingest exists.

Detector code, API routes, and UI consume the abstracted shape. When the second sport's tables land, the CTE definitions in `packages/db/src/sport-views.ts` grow a `UNION ALL`; query modules and the UI do not change.

---

## 15. API surface (8 routes total)

| Method | Path                          | Reads                                                                  | Bounded by                              |
| ------ | ----------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| GET    | `/v1/games`                   | `v_games` CTE (joins `games`, latest `game_states`)                    | `since=` (default 24 h)                 |
| GET    | `/v1/games/:gameId`           | `v_games` CTE + `game_outcomes`                                        | game id                                 |
| GET    | `/v1/live/:gameId`            | `quote_ticks`, `source_markets` (gold, read-only)                      | game id + last 5 min                    |
| GET    | `/v1/board/:gameId`           | `detector_cache` (hit) or `quote_ticks` + compute (miss; then cached)  | game id + in-play window                |
| GET    | `/v1/microstructure/:gameId`  | `market_microstructure_events` (gold, read-only)                       | game id + `volume_share >= θ`           |
| POST   | `/v1/backtest`                | `quote_ticks`, `market_microstructure_events`, `v_events` + detector compute; cached by `params_hash` | request window (≤ 28 d, ≤ 20 games)     |
| GET    | `/v1/detectors`               | (none — registry only)                                                 | —                                       |
| GET    | `/v1/settings`                | `pragma_*` (gold + cache), log tail                                    | —                                       |
| DELETE | `/v1/cache`                   | `detector_cache` only                                                  | optional `detector_id`, `before` params |
| GET    | `/v1/health/live`             | (none)                                                                 | —                                       |
| GET    | `/v1/health/ready`            | gold DB readiness ping                                                 | —                                       |
| GET    | `/openapi.json`               | (auto-generated)                                                       | —                                       |

Every route validates its query/body with Zod; never an `as` cast. Every service function takes a typed `Logger` and returns a typed payload.

---

## 16. Front-end views

| Route        | Default behavior                                                              |
| ------------ | ----------------------------------------------------------------------------- |
| `/`          | "Last 24 h" — list games + status + fire count, no auto-refresh on first load |
| `/live/:id`  | Opt-in; user must click into a game. 30 s poll. No silent baseline rebuild.   |
| `/backtest`  | Date range + game scope + detector selector + Sensitivity / Signal timing controls + results panel |
| `/detectors` | Registry listing with paramsSchema; "Drop a new file in `packages/detectors/src/`" link |
| `/settings`  | DB path, size, WAL bytes, last sync per source, last 200 error lines, version |

The store (`apps/web/src/app/store.ts`) stays tiny — command palette state and nothing else. Server state lives in Tanstack Query. Form state for the backtest dials lives in the Backtest page component.

---

## 17. Pedantic linting (logic bugs, not whitespace)

`eslint.config.js` ships with these rules at **`error`**:

- `@typescript-eslint/no-floating-promises`
- `@typescript-eslint/no-misused-promises`
- `@typescript-eslint/strict-boolean-expressions`
- `@typescript-eslint/switch-exhaustiveness-check`
- `@typescript-eslint/no-unnecessary-condition`
- `@typescript-eslint/require-await`
- `@typescript-eslint/no-confusing-void-expression`
- `@typescript-eslint/return-await` (`["error", "always"]`)
- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/no-unsafe-{assignment,call,member-access,return,argument}`
- `@typescript-eslint/consistent-type-assertions` (`{ assertionStyle: "never" }`)
- `react-hooks/exhaustive-deps`
- `react-hooks/rules-of-hooks`
- `eslint-plugin-functional` (`no-let`, `no-mutation`) in `packages/detectors/`
- Runtime assertion in `packages/db/src/open.ts`: after opening, read back `PRAGMA query_only`; throw at startup if the value is not `1`.
- Code-review checklist (`.github/PULL_REQUEST_TEMPLATE.md`): "Every new file under `packages/db/src/queries/` has a `WHERE` clause naming `game_id` or a time column" — enforced by review, not by a custom rule, until/unless we see drift.

`tsconfig`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.

Sidecar (when ported in Phase 0.5): Pydantic v2 strict, `mypy --strict`, `ruff check --select ALL --ignore D,COM812,ANN101,ANN102`. Pre-commit gate `uv run pytest`.

---

## 18. CI gates (split: portable vs. local-only)

**`pnpm verify`** — runs anywhere, does NOT require the 54 GB gold DB:

1. `pnpm format:check` (prettier — whitespace only, not "lint")
2. `pnpm lint` (the rules above)
3. `pnpm typecheck`
4. `pnpm test` (vitest unit + detector contract tests against committed fixtures + cache-DB tests against an in-memory SQLite)
5. `pnpm verify:no-stale-plan` — ripgrep over the repo for forbidden strings (see §22)
6. Bug-fix regression guard (port of `nba-predict/.codex/hooks.json`)

**`pnpm verify:gold`** — local-only; requires the moved gold DB at `~/signal-console/data/signal-console.sqlite`:

1. `pnpm verify:queries` — opens the gold DB read-only, runs the 5 hottest queries with `EXPLAIN QUERY PLAN`, fails on full scans or missing expected indexes.
2. `pnpm verify:slos` — fires each route against the gold DB, fails if any exceeds its SLO budget.

CI runs `pnpm verify`. Developers run `pnpm verify:gold` locally before merging anything that touches a query module or detector.

---

## 19. Tests (spec-driven + test-driven)

- **Detector contract tests** (`packages/detectors/src/*/__tests__/*.test.ts`): for a frozen window snapshot, the detector emits a frozen list of fires. These are the spec; they get written first when adding a detector.
- **Query plan snapshot tests** (`packages/db/src/queries/__tests__/*.test.ts`): each query's `EXPLAIN QUERY PLAN` is snapshotted; any change is a deliberate PR review item. Maintenance contract: snapshot diffs are reviewed, not auto-updated; SQLite planner shifts between versions are valid reasons to re-snapshot, but require an explicit `pnpm verify:queries -u` plus a one-line PR note.
- **Route SLO tests** (`apps/api/tests/slo.test.ts`): each route is run against the gold DB and timed; failures are red.
- **E2E** (`apps/web/e2e/*.spec.ts`): three flows — open `/`, open one game's live view, run a backtest with the dial moved.

---

## 20. Settings tab (explicit content)

Three sections, no buttons that mutate (except "clear cache"):

**Database**
- Path
- Size on disk (bytes + human)
- WAL bytes
- Page count, page size
- Last-modified
- Mode (must read `read-only` — failing that, red banner)

**Sources** (only populated when the Phase-0.5 ingest writer is running; otherwise this section shows "ingest paused" with the last known values)
- Heartbeat file: `~/signal-console/apps/worker/data/heartbeat.json`.
- For each of `nba-sidecar`, `bet365 (odds-api)`, `kalshi`, `polymarket`: last successful sync timestamp, last error if any, rate-limit cooldown if any.

**Errors**
- Tail of the last 200 structured log entries from the new API's log file.
- Filter by level.

**About**
- App version, detector versions (from registry), DB schema version.

---

## 21. User Stories (by phase)

### Phase 0 — Scaffold + Hard Cutover + Cache DB + Canonical Contract Tests

#### US-000: Initialise monorepo scaffold
**Description:** As a developer, I need a clean `~/signal-console/` monorepo with pnpm workspaces, Turbo, and the pedantic eslint ruleset configured so all subsequent work has correct guardrails.

**Acceptance Criteria:**
- [ ] `~/signal-console/` is a git repo (`git init` run).
- [ ] `pnpm-workspace.yaml` lists `apps/*`, `packages/*`.
- [ ] `turbo.json` defines `verify`, `build`, `dev` pipelines.
- [ ] `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- [ ] `eslint.config.js` enables all rules listed in §17 at `error`.
- [ ] `pnpm verify` passes on empty scaffold (lint, typecheck, test all no-ops succeed).
- [ ] `.codex/hooks.json` ported from `~/nba-predict/.codex/hooks.json`.
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` includes the "WHERE clause naming `game_id` or a time column" review checklist item.

#### US-001: Implement read-only gold-DB open path
**Description:** As a developer, I need every gold-DB connection in the API/UI/cache to be unforgeable read-only, so the 54 GB tick store cannot be mutated by the API path.

**Acceptance Criteria:**
- [ ] `packages/db/src/open.ts` exports an `openGoldDb(path)` function applying the four guards in §11.1: URI `file:${path}?mode=ro`, `{ readonly: true, fileMustExist: true }`, `PRAGMA busy_timeout=5000`, `PRAGMA query_only=ON`.
- [ ] After opening, function reads back `PRAGMA query_only`; throws `Error("gold DB connection is not query_only")` if value is not `1`.
- [ ] `GOLD_DB_PATH` defaults to `~/signal-console/data/signal-console.sqlite`; the old `~/nba-predict/data/...` path is not referenced anywhere in code (enforced by `pnpm verify:no-stale-plan`).
- [ ] Unit test asserts that attempting `INSERT`, `UPDATE`, `DELETE`, `CREATE TEMP VIEW`, `PRAGMA journal_mode=...` against the returned handle throws.
- [ ] Typecheck/lint passes.

#### US-002: Initialise cache DB schema
**Description:** As a developer, I need the detector-output cache DB schema applied so detector runs can be persisted without touching the gold DB.

**Acceptance Criteria:**
- [ ] `packages/db/src/cache-migrations/0001-init.sql` creates `detector_runs` and `detector_observations` exactly as specified in §9.
- [ ] `packages/db/src/cache-migrations/runner.ts` is idempotent (re-running adds no rows, raises no error).
- [ ] Cache DB file path is `~/signal-console/data/detector-cache.sqlite`.
- [ ] Unit test against in-memory SQLite asserts schema, indexes, and `UNIQUE` constraint.
- [ ] `pnpm cache:reset` script deletes `detector-cache.sqlite` and re-applies migration.
- [ ] Typecheck/lint passes.

#### US-003: Define sport-view CTE template strings
**Description:** As a developer, I need shared CTE fragments (`v_games`, `v_events`) so query modules can be sport-agnostic without depending on `CREATE TEMP VIEW`.

**Acceptance Criteria:**
- [ ] `packages/db/src/sport-views.ts` exports `v_games` and `v_events` as named TypeScript template strings.
- [ ] `v_games` shape includes: game id, sport, league, scheduled_start, `home_participant_json`, `away_participant_json`, current status from latest `game_states` row.
- [ ] `v_events` shape: NBA PBP rows with `'NBA'` injected as `sport`.
- [ ] Comments name the exact source tables and columns; "verified by Phase 0 query-plan smoke" is noted.
- [ ] Typecheck/lint passes.

#### US-004: Execute gold-DB relocation procedure
**Description:** As the owner, I need the gold DB moved from `~/nba-predict/data/` to `~/signal-console/data/` so the new app can open it at its canonical path, with a loud sentinel at the old path.

**Acceptance Criteria:**
- [ ] `docs/gold-db-relocation.md` contains the verbatim procedure from §11.3.
- [ ] Phase-0 runbook is executed manually, step by step, with each step approved individually (no bypass-permissions, no single wrapper script).
- [ ] Old worker / API / web processes are stopped, verified by `ps aux | grep` returning empty.
- [ ] Old API port returns empty for `lsof -iTCP:<port> -sTCP:LISTEN`.
- [ ] Cloudflare tunnel is parked: `curl --fail --max-time 5 https://nba-predict.dtmont.com` fails (any 5xx / connection error acceptable).
- [ ] `lsof | grep "nba-predict/data/signal-console.sqlite"` returns empty before the move.
- [ ] (Optional) safety backup created and `PRAGMA integrity_check` returns `ok` on backup.
- [ ] `mv` of `signal-console.sqlite`, `signal-console.sqlite-wal`, `signal-console.sqlite-shm` to `~/signal-console/data/` succeeds.
- [ ] `sqlite3 -readonly ~/signal-console/data/signal-console.sqlite "PRAGMA integrity_check;"` outputs `ok`.
- [ ] `~/nba-predict/data/MOVED.txt` exists with a moved-on timestamp.
- [ ] `~/nba-predict/.DEPRECATED` exists.
- [ ] `~/nba-predict/data/signal-console.sqlite` no longer exists.

#### US-005: Query-plan smoke against moved gold DB
**Description:** As a developer, I need a `pnpm verify:queries` script that opens the moved gold DB read-only and snapshots `EXPLAIN QUERY PLAN` for the 5 hottest queries so we catch index regressions early.

**Acceptance Criteria:**
- [ ] `pnpm verify:queries` script exists and runs against `~/signal-console/data/signal-console.sqlite` in read-only mode.
- [ ] Snapshots `EXPLAIN QUERY PLAN` for: games-last-24h, ticks-for-one-game-window, microstructure-for-one-game, board-buckets-for-one-game, pbp-for-one-game.
- [ ] Fails on any full table scan or missing expected index.
- [ ] Snapshot files committed under `packages/db/src/queries/__tests__/__snapshots__/`.
- [ ] Re-running `pnpm verify:queries -u` is the only path to update snapshots, and the PR template instructs reviewers to scrutinise such updates.
- [ ] Typecheck/lint passes.

#### US-006: Port `board-mad` detector from `board_signal_v2.py`
**Description:** As a developer, I need a TypeScript port of `scripts/board_signal_v2.py` as the canonical `board-mad` detector, including the rolling-current-game `median + K·MAD` baseline, configurable signal timing, 8-minute elapsed warmup default at 60 s buckets, 300 s fresh cap, and `is_heartbeat`/`0.500` sanitations.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/board-mad/index.ts` exports `detector: Detector<Params>` matching the §10 sketch (id `board-mad`, version `1.0.0`, displayName `"Board MAD (whole-board volatility)"`).
- [ ] `packages/detectors/src/board-mad/config.ts` declares `K_MAD_LIVE = 3.0` and `K_MAD_CALM = 6.0`; these are the **only** declarations of either K value in the repo (enforced by `pnpm verify:no-stale-plan`).
- [ ] Detector iterates `quote_ticks` in time order, bucketed by `bucketSeconds` (default 60), applies the selected signal timing mode, fires when current bucket intensity exceeds threshold, after the elapsed `warmupBuckets × bucketSeconds` warmup, with `freshCapSeconds` per-market delta cap, and the `is_heartbeat`/`0.500` opening-anchor sanitations.
- [ ] Detector defaults match `nba-predict` `BOARD_VW_K_MAD = 3` for the live path with the elapsed-time opening-ramp profile: `kMad=3.0`, `weighting="volume"`, `baselineMode="opening-ramp"`, `openingBaselineBuckets=4`, `openingRampCompleteBuckets=20`, `trailingBuckets=20`, `warmupBuckets=8`, `freshCapSeconds=300`.
- [ ] `eslint-plugin-functional` (`no-let`, `no-mutation`) passes in this package.
- [ ] Total LOC under `packages/detectors/src/board-mad/` is ≤ 250.
- [ ] Typecheck/lint passes.

#### US-007: Commit canonical detector contract test fixtures
**Description:** As a developer, I need committed JSON fixture extracts (small slices of `quote_ticks` for `nba-0042500222` and `nba-0042500223/224` around anchored incident times) so detector contract tests run anywhere without the 54 GB gold DB.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/board-mad/__tests__/fixtures/` contains JSON slices for: Hartenstein game (`nba-0042500222`), Reaves games (`nba-0042500223`, `nba-0042500224`).
- [ ] Each fixture is gzipped if > 100 KB raw; loader transparently decompresses.
- [ ] A `scripts/extract-fixtures.ts` script (one-time, manually run against the local gold DB) documents how each fixture was extracted.
- [ ] Fixtures total < 5 MB.
- [ ] Typecheck/lint passes.

#### US-008: Canonical detector contract tests at K=6.0
**Description:** As a developer, I need contract tests that lock in the report's validated K=6.0 outcomes so future drift in the detector is immediately caught.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/board-mad/__tests__/canonical.test.ts` at K=6.0 asserts:
  - [ ] Hartenstein bucket starting `2026-05-08T03:12:00Z` fires; watcher confirms at bucket-end `03:13:00Z` (≈ T+23 s after event `03:12:36.8Z`).
  - [ ] Reaves event `2026-05-12T04:51:40.2Z` produces **no fires** on either `nba-0042500223` or `nba-0042500224`.
  - [ ] Mean fires per game across the 64-game PBP fixture set: 9.3 ± 1.0 equal-weight, 8.6 volume-weight (both within tolerance).
- [ ] Test names cite event timestamps and bucket timestamps explicitly so future readers cannot conflate detector output (bucket-start) with watcher confirmation (bucket-end).
- [ ] Typecheck/lint passes.

#### US-009: Canonical detector contract tests at K=3.0 (live default)
**Description:** As a developer, I need contract tests at K=3.0 (live default) snapshotting the canonical implementation's actual outputs so any future drift is a deliberate review event.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/board-mad/__tests__/canonical.test.ts` at K=3.0 asserts:
  - [ ] Hartenstein in-play window has ≥ 1 fire (K=3 is more sensitive than K=6, cannot fail to fire when K=6 fires).
  - [ ] Reaves: whatever the canonical implementation produces at K=3 on both game ids is snapshotted; any future change is a review event.
  - [ ] Mean fires per game across the 64-game fixture set: K=3 number snapshotted (directional expectation: ~18 per the video/bakeoff narration).
- [ ] Snapshot files committed under `packages/detectors/src/board-mad/__tests__/__snapshots__/`.
- [ ] Typecheck/lint passes.

#### US-010: Phase 0 acceptance smoke
**Description:** As the owner, I need a single Phase-0 acceptance checklist run before declaring Phase 0 done.

**Acceptance Criteria:**
- [ ] `sqlite3 -readonly ~/signal-console/data/signal-console.sqlite "PRAGMA integrity_check;"` returns `ok`.
- [ ] `openGoldDb()` returns a handle with `query_only=1`.
- [ ] `~/signal-console/data/detector-cache.sqlite` initializes cleanly via `pnpm cache:reset`.
- [ ] `pnpm verify` passes (lint + typecheck + test + verify:no-stale-plan).
- [ ] `pnpm verify:queries` passes (no full scans).
- [ ] Contract tests green at both K values per US-008 and US-009.
- [ ] `~/nba-predict/.DEPRECATED` and `~/nba-predict/data/MOVED.txt` exist; old gold DB file is gone from `~/nba-predict/data/`.

> **Note:** Ingest is paused after Phase 0 until Phase 0.5 ships. The user has confirmed this is acceptable given the current game schedule.

---

### Phase 0.5 — Minimal Ingest Writer (CONDITIONAL — go/no-go gate)

> **Gate:** Phase 0.5 ships **only if** live ingest is needed before Phase 1 stabilises. Default = SKIP; revisit at end of Phase 0.

#### US-050: Decide Phase 0.5 go / no-go
**Description:** As the owner, I need an explicit go / no-go on Phase 0.5 before any worker port begins, with the decision recorded.

**Acceptance Criteria:**
- [ ] At end of Phase 0, owner records decision in `docs/phase-0-5-decision.md`: GO or SKIP with one-line rationale (e.g. "game schedule: NBA Finals Game X tomorrow" or "off-season; skip").
- [ ] If SKIP: Phase 0.5 stories are not started; proceed to Phase 1.
- [ ] If GO: proceed with US-051 through US-053.

#### US-051: Port minimal ingest writer
**Description:** As the owner, I need the smallest viable slice of `~/nba-predict/apps/worker` ported into `~/signal-console/apps/worker/` so ticks resume being written to the moved gold DB.

**Acceptance Criteria:**
- [ ] `~/signal-console/apps/worker/` ports: sidecar sync, Polymarket trade tape; Bet365/Kalshi if their feeds are still healthy.
- [ ] No admin queue, no historical backfill, no market-anomaly score config writer.
- [ ] Total LOC ≤ 800.
- [ ] Worker opens the gold DB at `~/signal-console/data/signal-console.sqlite` with default WAL permissions; it is the **only** code in the new repo that opens the gold DB writable.
- [ ] Worker does **not** share its DB handle with the API.
- [ ] Worker writes heartbeat to `~/signal-console/apps/worker/data/heartbeat.json` (not to the gold DB).
- [ ] Typecheck/lint passes.

#### US-052: Port Python sidecar
**Description:** As the owner, I need the NBA sidecar ported from `~/nba-predict/apps/nba-sidecar/` so the new worker has its scoreboard data source.

**Acceptance Criteria:**
- [ ] Sidecar lives at `~/signal-console/apps/sidecar/` (either direct port or subprocess wrap).
- [ ] Pydantic v2 strict + `mypy --strict` + `ruff check --select ALL --ignore D,COM812,ANN101,ANN102` all pass.
- [ ] `uv run pytest` passes.
- [ ] Sidecar outputs are consumed via the moved gold DB; no new file/IPC channel.

#### US-053: Phase 0.5 acceptance smoke
**Description:** As the owner, I need verification that the new worker is actually writing ticks before declaring Phase 0.5 done.

**Acceptance Criteria:**
- [ ] A fresh worker cycle adds new `quote_ticks` rows (row count grows over time).
- [ ] `~/signal-console/apps/worker/data/heartbeat.json` is being updated with each cycle.
- [ ] `sqlite3 -readonly ~/signal-console/data/signal-console.sqlite "PRAGMA integrity_check;"` returns `ok` (writer doesn't corrupt the DB).
- [ ] The Recent API (Phase 1) serves new ticks within one cache invalidation tick (verified post-Phase-1).

---

### Phase 1 — Read-only API + Recent + Settings + Cloudflare Repoint

#### US-100: Implement `/v1/games` route
**Description:** As an API integrator, I need a `GET /v1/games` route returning the last 24 h of games (by default) with sport, league, scheduled_start, and latest status.

**Acceptance Criteria:**
- [ ] Route at `apps/api/src/routes/games.ts` registers `GET /v1/games`.
- [ ] Query params validated by Zod: `since?: string (ISO duration, default "PT24H")`, `sport?: string`.
- [ ] Reads via `v_games` CTE; bounded by `since`.
- [ ] Returns Zod-typed JSON; never `as` cast.
- [ ] Service module ≤ 400 LOC.
- [ ] Route handler ≤ 250 LOC.
- [ ] Unit test against in-memory or fixture-backed gold DB.
- [ ] Typecheck/lint passes.

#### US-101: Implement `/v1/games/:gameId` route
**Description:** As an API integrator, I need a `GET /v1/games/:gameId` route returning a single game's metadata + outcome.

**Acceptance Criteria:**
- [ ] Route at `apps/api/src/routes/games.ts` registers `GET /v1/games/:gameId`.
- [ ] Reads via `v_games` CTE + `game_outcomes`.
- [ ] Returns 404 with Zod-typed error body if game not found.
- [ ] Typecheck/lint passes.

#### US-102: Implement `/v1/health/live` and `/v1/health/ready`
**Description:** As an operator, I need liveness and readiness endpoints so the Cloudflare tunnel and any external monitor can health-check the API.

**Acceptance Criteria:**
- [ ] `/v1/health/live` returns `200 { ok: true }` always (no DB touch).
- [ ] `/v1/health/ready` returns `200 { ok: true }` only if the gold DB can be opened read-only and a trivial `SELECT 1` succeeds; otherwise `503 { ok: false, reason: "..." }`.
- [ ] Typecheck/lint passes.

#### US-103: Implement `/v1/settings`
**Description:** As a developer, I need a `GET /v1/settings` route returning DB info + log tail so the Settings UI has everything it needs in one call.

**Acceptance Criteria:**
- [ ] Returns: gold DB path, size bytes, WAL bytes, page count, page size, last-modified, mode (must be `read-only`).
- [ ] Returns: cache DB path, size bytes, page count.
- [ ] Returns: last 200 structured log entries from the API's log file.
- [ ] If sources/heartbeat file exists, returns last sync per source; otherwise returns `{ ingestPaused: true, lastKnown: {...} }`.
- [ ] Response time < 100 ms (no scans; only `PRAGMA` reads).
- [ ] Typecheck/lint passes.

#### US-104: Implement `DELETE /v1/cache`
**Description:** As an operator, I need a `DELETE /v1/cache` route to clear the detector cache (gold DB never touched).

**Acceptance Criteria:**
- [ ] Route deletes rows from `detector_runs` (and cascade `detector_observations`).
- [ ] Optional query params: `detector_id?`, `before?` (ISO timestamp).
- [ ] Returns count of deleted run rows.
- [ ] Gold DB is provably untouched (assertion test: gold DB byte size unchanged before/after).
- [ ] Typecheck/lint passes.

#### US-105: Generate `/openapi.json` via `@fastify/swagger`
**Description:** As a trading-desk integrator, I need an auto-generated OpenAPI document at `/openapi.json` so I can code against the spec.

**Acceptance Criteria:**
- [ ] `@fastify/swagger` registered with the Fastify server.
- [ ] Every route declares Zod schemas; schemas auto-convert to JSON Schema → OpenAPI.
- [ ] `GET /openapi.json` returns a valid OpenAPI 3.x document.
- [ ] Internal routes (`/v1/backtest`, `/v1/settings`, `/v1/health/*`) are tagged `internal`.
- [ ] Stable routes (`/v1/games`, `/v1/live/:gameId`, `/v1/board/:gameId`, `/v1/microstructure/:gameId`, `/v1/detectors`) are tagged `desk-stable`.
- [ ] Typecheck/lint passes.

#### US-106: `X-Signal-Token` header check at API edge
**Description:** As an operator, I need a single shared header `X-Signal-Token` validated at the API edge so the public tunnel can't be hit anonymously.

**Acceptance Criteria:**
- [ ] Token source of truth: `~/.signal-console/token` (file, not env var); rotating the file does not require restarting Fastify.
- [ ] Requests missing or with wrong `X-Signal-Token` return `401`.
- [ ] `/v1/health/live` is exempt (so tunnel health checks work).
- [ ] Unit test asserts 401 on missing, wrong, and valid token paths.
- [ ] Typecheck/lint passes.

#### US-107: Recent UI page (`/`)
**Description:** As a desk operator, I need a default `/` page listing last 24 h games with status + fire count, fast on warm cache and acceptable on cold cache.

**Acceptance Criteria:**
- [ ] Route `/` renders a list of games from `GET /v1/games?since=PT24H`.
- [ ] For each game, the "fires" column is filled lazily: look up `detector_cache` for `(board-mad, current board-mad detector version, params_hash(live defaults), source_watermark_hash(game_id), scope='game', game_id)`; on hit, show count from `detector_observations`; on miss, run detector for the in-play window, persist, then show.
- [ ] No auto-refresh on first load (manual refresh button only).
- [ ] Warm cache renders in < 500 ms (measured client-side).
- [ ] Cold cache fills in < 2 s for ~20 games.
- [ ] API errors render as a banner, not a blocking page.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-108: Settings UI page (`/settings`)
**Description:** As an operator, I need a `/settings` page showing detector defaults plus the diagnostic sections in §20 with no mutating buttons except detector-default edits and "clear cache".

**Acceptance Criteria:**
- [ ] Renders Detector defaults section: live sensitivity, prior sample, opening sample/ramp, lookback/holdoff, freshness cap, and PBP buffers.
- [ ] Renders Database section: path, size (bytes + human), WAL bytes, page count, page size, last-modified, mode (red banner if not `read-only`).
- [ ] Renders Sources section: heartbeat file path; per-source last sync, last error, rate-limit cooldown. If no heartbeat, shows "ingest paused" with last-known values.
- [ ] Renders Errors section: tail of last 200 log entries with level filter.
- [ ] Renders About section: app version, detector versions, DB schema version.
- [ ] "Clear cache" button calls `DELETE /v1/cache` and refreshes; gold DB byte size shown is unchanged before/after.
- [ ] Settings full render < 100 ms (no scans).
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-109: Repoint Cloudflare tunnel to new API on `localhost:32140`
**Description:** As the owner, I need the Cloudflare tunnel repointed to the new Fastify API only after a Phase-1 smoke passes, so the desk's `nba-predict.dtmont.com` URL works again.

**Acceptance Criteria:**
- [ ] Phase-0 relocation smoke passed (US-010).
- [ ] Local smoke: `curl -H "X-Signal-Token: $(cat ~/.signal-console/token)" http://localhost:32140/v1/games` returns a valid OpenAPI-described JSON payload.
- [ ] Cloudflare config updated to point `nba-predict.dtmont.com` → `localhost:32140`.
- [ ] `curl -H "X-Signal-Token: ..." https://nba-predict.dtmont.com/v1/games` returns the same payload.
- [ ] `~/nba-predict` does **not** run; old worker remains stopped.
- [ ] Decision recorded in `docs/phase-1-tunnel-repoint.md` with timestamp.

#### US-110: Phase 1 acceptance smoke
**Description:** As the owner, I need a Phase-1 acceptance checklist run before declaring Phase 1 done.

**Acceptance Criteria:**
- [ ] Recent page cold-cache renders < 2 s for ~20 games.
- [ ] Recent page warm-cache renders < 500 ms.
- [ ] First desk `GET nba-predict.dtmont.com/v1/games` (with valid token) returns OpenAPI-described JSON.
- [ ] `pnpm verify` passes; `pnpm verify:gold` passes locally.

---

### Phase 2 — Detector Registry + Live + Board

#### US-200: Detector registry module
**Description:** As a developer, I need a detector registry so new detectors can be added with one file + one line.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/registry.ts` exports a typed map keyed by detector id.
- [ ] `packages/detectors/src/types.ts` defines `Detector<TParams>` interface (id, version, displayName, paramsSchema (Zod), `run(window, params)` function).
- [ ] Adding a detector requires only: a new file at `packages/detectors/src/<name>/index.ts` and one line in `registry.ts`.
- [ ] Typecheck/lint passes.

#### US-201: Port `off-price-print` detector
**Description:** As a developer, I need the second initial detector (`off-price-print`) ported so the registry ships with two examples.

**Acceptance Criteria:**
- [ ] `packages/detectors/src/off-price-print/index.ts` implements the concentrated-print detector.
- [ ] Params: `{ minVolumeShare = 0.10, minOffPriceDistance = 0.40 }`.
- [ ] Reads from `market_microstructure_events` filtered by `game_id`.
- [ ] Documents Polymarket-only limitation in the displayName and in API responses (UI surfaces this in §US-208).
- [ ] Typecheck/lint passes.

#### US-202: Implement `/v1/live/:gameId` route
**Description:** As an API integrator, I need a `GET /v1/live/:gameId` route returning the last 5 minutes of `quote_ticks` + `source_markets` for one game.

**Acceptance Criteria:**
- [ ] Reads bounded by `(source_market_id, captured_at)` index; window = last 5 min.
- [ ] Returns Zod-typed JSON.
- [ ] Response time < 300 ms (cold or warm).
- [ ] Does NOT trigger any baseline rebuild path (no read of `board_volatility_baselines` on this route).
- [ ] Typecheck/lint passes.

#### US-203: Implement `/v1/board/:gameId` route
**Description:** As an API integrator, I need a `GET /v1/board/:gameId` route returning board fires for one game at the live default K=3.0, cached.

**Acceptance Criteria:**
- [ ] Looks up `detector_cache` with `(board-mad, current board-mad detector version, params_hash(live defaults), source_watermark_hash(game_id), scope='game', game_id)`.
- [ ] On hit: returns observations from cache.
- [ ] On miss: runs detector for the game's in-play window, persists, returns.
- [ ] K is the live default `K_MAD_LIVE = 3.0`; no query param overrides K on this route (Backtest is the override surface).
- [ ] Response time: < 300 ms warm; < 2 s cold per game.
- [ ] Typecheck/lint passes.

#### US-204: Implement `/v1/microstructure/:gameId` route
**Description:** As an API integrator, I need a `GET /v1/microstructure/:gameId` route returning microstructure events for one game, filtered by volume share.

**Acceptance Criteria:**
- [ ] Reads `market_microstructure_events` filtered by `game_id` and `volume_share >= θ`.
- [ ] `θ` defaults to `0.10`; query param can override.
- [ ] Response time < 300 ms.
- [ ] Typecheck/lint passes.

#### US-205: Implement `/v1/detectors` route
**Description:** As an integrator, I need a `GET /v1/detectors` route returning the registry (id, version, displayName, paramsSchema as JSON Schema).

**Acceptance Criteria:**
- [ ] Returns array of `{ id, version, displayName, paramsSchema }` from the registry.
- [ ] `paramsSchema` is JSON-Schema-compatible (derived from Zod).
- [ ] No DB reads (registry only).
- [ ] Typecheck/lint passes.

#### US-206: Live UI page (`/live/:id`)
**Description:** As a desk operator, I need an opt-in `/live/:id` page polling at 30 s intervals with no silent baseline rebuild.

**Acceptance Criteria:**
- [ ] User must click into a game from Recent to reach this view (no auto-redirect, no preload).
- [ ] Polls `/v1/live/:gameId` and `/v1/board/:gameId` every 30 s.
- [ ] Initial render < 300 ms.
- [ ] Visible "fires from board-mad at K=3.0" annotation matches contract tests.
- [ ] No silent baseline rebuild path is triggered (verified by absence of any `resolveBoardVolatilityBaseline`-equivalent function in the new code).
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-207: Detectors UI page (`/detectors`)
**Description:** As a data engineer, I need a `/detectors` page listing the registry with each detector's params schema and a link explaining "Drop a new file in `packages/detectors/src/`".

**Acceptance Criteria:**
- [ ] Lists all detectors from `GET /v1/detectors`.
- [ ] For each detector, renders the params schema as a read-only form (number → number, enum → select, etc.).
- [ ] Shows a "How to add a detector" link with the three-step recipe from §10.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-208: Surface `off-price-print` Polymarket-only limit in UI
**Description:** As a desk operator, I need the UI to honestly say that `off-price-print` only sources Polymarket so I don't assume coverage we don't have.

**Acceptance Criteria:**
- [ ] Detector cards in `/detectors` show a "Sources: Polymarket only" tag for `off-price-print`.
- [ ] Live UI fire annotations from `off-price-print` carry a "Polymarket only" footnote.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-209: Phase 2 acceptance smoke
**Description:** As the owner, I need a Phase-2 acceptance checklist run before declaring Phase 2 done.

**Acceptance Criteria:**
- [ ] Live opens without triggering anything that resembles a baseline rebuild.
- [ ] Fires shown on Live match the canonical contract tests (US-008, US-009) at K=3.0.
- [ ] `pnpm verify` + `pnpm verify:gold` pass.
- [ ] Manual smoke: open `/`, click into one game, see Live render with fire markers.

---

### Phase 3 — Backtest + Sensitivity Dial

#### US-300: Implement `POST /v1/backtest` route
**Description:** As an analyst, I need a `POST /v1/backtest` route running a detector over a chosen window + games + params, cached by `params_hash`.

**Acceptance Criteria:**
- [ ] Request body validated by Zod: `{ detector_id, params, window: { start, end }, game_ids?: string[] }`.
- [ ] Window bounded ≤ 28 days; game_ids count ≤ 20 (return 400 with clear message if exceeded).
- [ ] Looks up `detector_cache` with scope='window'; on hit returns cached observations.
- [ ] On miss: one bounded read of `quote_ticks` (and `market_microstructure_events`, `v_events` as needed), runs detector compute, persists run + observations.
- [ ] First sweep on a 28-d / 20-game window completes in < 60 s.
- [ ] Subsequent calls with same `params_hash` (e.g. only window shifts inside cache) return cache hits in < 1 s.
- [ ] Typecheck/lint passes.

#### US-301: Optimize for in-memory K sweep
**Description:** As an analyst, I need the backtest to pre-bucket once in SQL, then re-sweep K in JS in memory, so dial movement is sub-second.

**Acceptance Criteria:**
- [ ] `board-mad` detector exposes a `prebucket(ticks)` function that produces the bucketed intensity series independent of K.
- [ ] `runSweep(buckets, kValues[])` iterates K in memory in microseconds per K value.
- [ ] Backtest service caches the pre-bucketed series and reuses it across K sweeps within one request scope.
- [ ] Typecheck/lint passes.

#### US-302: Backtest UI page (`/backtest`)
**Description:** As an analyst, I need a `/backtest` page with date range + game scope + detector selector + Sensitivity / Signal timing controls + results panel.

**Acceptance Criteria:**
- [ ] Date range picker (start/end ≤ 28 days apart).
- [ ] Game scope: "all games in window" or specific game ids (max 20).
- [ ] Detector dropdown lists registry entries; selecting one renders its params schema.
- [ ] Sensitivity dial: continuous rotary control over `kMad` = 2.0–8.0, step 0.25, **default 3.0**.
- [ ] Volatility-lookback slider: integer `trailingBuckets` = 5–60, step 1, **default 20**, with a visible duration readout computed from `trailingBuckets × bucketSeconds` (for example, 20 buckets × 60 s = 20 min).
- [ ] Opening-holdoff slider: integer `warmupBuckets` = 2–20, step 1, **default 8**, with a visible elapsed duration readout computed from `warmupBuckets × bucketSeconds`.
- [ ] Profile + prior sample controls: live defaults start at `"opening-ramp"`; Backtest and Settings can switch to `"historical-blend"` or legacy `"trailing"`. Historical mode uses last-five same-side priors, 50/50 away/home by default, ramps to current-game-only by 12 game minutes, measures 30 s wall-clock buckets, keeps 12 game minutes of current memory, and can blend in the last 4 wall minutes at 1.5× weight.
- [ ] Two labelled snap points: "Sensitive — live default" at K=3.0; "Calm — comparison preset" at K=6.0.
- [ ] As either recompute dial moves: estimated fires/game updates live (in-memory recompute, no DB scan, < 1 s response).
- [ ] Per-game small timeline shows fire markers at the chosen K.
- [ ] For Reaves/Hayes and Hartenstein incidents (if they fall inside the window), shows lead time at current K or "no fire".
- [ ] First sweep ≤ 60 s on 28-d / 20-game window.
- [ ] Subsequent K changes ≤ 1 s.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-303: Confirm dial does NOT affect Live / Recent
**Description:** As a desk operator, I need a hard guarantee that moving the dial in Backtest does not change what Live or Recent show, so I always know what K is producing the fires I see day-to-day.

**Acceptance Criteria:**
- [ ] Recent and Live pages always render at the live default `K_MAD_LIVE = 3.0`.
- [ ] No state synchronisation between Backtest's dial value and Recent/Live.
- [ ] Unit/integration test: move the Backtest K dial to K=6.0; navigate to Recent; verify all fires are still the K=3.0 set.
- [ ] Typecheck/lint passes.
- [ ] Verify in browser using dev-browser skill.

#### US-304: Phase 3 acceptance smoke
**Description:** As the owner, I need a Phase-3 acceptance checklist run before declaring Phase 3 done.

**Acceptance Criteria:**
- [ ] 28-d / ~20-game first sweep completes in < 60 s.
- [ ] Dial change < 1 s after first sweep.
- [ ] UI matches the video's narrated UX (dial is the visible knob; presets labelled per §7).
- [ ] `pnpm verify` + `pnpm verify:gold` pass.

---

### Phase 4 — Sport-Agnostic Views + NFL Placeholder

#### US-400: Add `sport=` filter to `/v1/games`
**Description:** As an integrator, I need a `sport=` query param on `/v1/games` so future NFL/NCAA football consumers can filter without breaking NBA callers.

**Acceptance Criteria:**
- [ ] `/v1/games?sport=NBA` returns NBA games; `?sport=NFL` returns NFL games (empty until NFL ingest exists, but the route shape is stable).
- [ ] Missing `sport` returns all sports.
- [ ] OpenAPI doc updated.
- [ ] Typecheck/lint passes.

#### US-401: Document "add a sport" runbook
**Description:** As a future data engineer, I need a `docs/sport-onboarding.md` runbook describing exactly how to add a new sport's PBP table to `v_events`.

**Acceptance Criteria:**
- [ ] Runbook lists: where to add the `UNION ALL` in `packages/db/src/sport-views.ts`, how to extend `v_games` for new participant JSON shapes, what tests to add.
- [ ] Includes a worked example (NFL) even though no NFL ingest exists yet.
- [ ] Reviewed by owner.

#### US-402: Phase 4 acceptance smoke
**Description:** As the owner, I need a Phase-4 acceptance checklist run before declaring Phase 4 done.

**Acceptance Criteria:**
- [ ] `/v1/games?sport=NBA` returns NBA-only games.
- [ ] `/v1/games?sport=NFL` returns empty array (200, not 404), since no NFL ingest exists.
- [ ] `docs/sport-onboarding.md` exists and reads coherently.
- [ ] `pnpm verify` passes.

---

### Phase 5 — Final Cleanup

#### US-500: Final reference review of `~/nba-predict`
**Description:** As the owner, I need a final pass over `~/nba-predict` to confirm nothing else is worth porting, then archive or delete.

**Acceptance Criteria:**
- [ ] Owner walks the file list of `~/nba-predict` once more; documents any final salvage items in `docs/nba-predict-archive.md`.
- [ ] Decision recorded: archive (rename to `~/nba-predict-archive/`) or delete.
- [ ] No process in the new repo ever reads from `~/nba-predict/`.

#### US-501: (Optional) Subdomain rename to `signal.dtmont.com`
**Description:** As a polish step, the temporary subdomain `nba-predict.dtmont.com` can be renamed to `signal.dtmont.com`.

**Acceptance Criteria:**
- [ ] Cloudflare DNS + tunnel config updated.
- [ ] Old subdomain returns 301 → new subdomain (or is decommissioned after a notice window).
- [ ] Desk integrators notified; OpenAPI server URL updated.
- [ ] Decision optional — defer if churn isn't justified.

---

## 22. Functional Requirements (numbered)

**Gold DB and storage**
- FR-1: The gold DB is moved exactly once, manually, from `~/nba-predict/data/signal-console.sqlite` to `~/signal-console/data/signal-console.sqlite` (with `-wal` and `-shm` siblings).
- FR-2: The API/UI/cache layer must open the gold DB read-only via `file:${GOLD_DB_PATH}?mode=ro` + `{ readonly: true, fileMustExist: true }` + `PRAGMA busy_timeout=5000` + `PRAGMA query_only=ON`, and must throw at startup if `PRAGMA query_only` reads back as anything other than `1`.
- FR-3: The API path must never delete, rename, move, checkpoint, or alter the journal mode of the gold DB or its WAL/SHM siblings.
- FR-4: The only authorised writer to the gold DB across the new repo is the optional Phase-0.5 ingest writer in `~/signal-console/apps/worker/`.
- FR-5: A sentinel `~/nba-predict/.DEPRECATED` and a `~/nba-predict/data/MOVED.txt` file must exist after Phase 0, and `~/nba-predict/data/signal-console.sqlite` must no longer exist.
- FR-6: The detector cache lives at `~/signal-console/data/detector-cache.sqlite`; owned by this repo; safe to delete; schema per §9.

**Detectors and math**
- FR-7: `packages/detectors/src/board-mad/config.ts` is the **only** file in the repo declaring `K_MAD_LIVE = 3.0` or `K_MAD_CALM = 6.0`. No other file hardcodes either value.
- FR-8: The `board-mad` detector implements `intensity > median(selected prior sample) + K · MAD(selected prior sample)`, after elapsed `warmupBuckets × bucketSeconds` warmup, with `freshCapSeconds` per-market delta cap and the `is_heartbeat`/`0.500` opening-anchor sanitations, in `O(bucket)` time. The default selected prior sample is `baselineMode="opening-ramp"`: it starts from `openingBaselineBuckets × bucketSeconds` elapsed game context and reaches rolling memory at `openingRampCompleteBuckets × bucketSeconds`. `baselineMode="historical-blend"` starts from last-five same-side historical priors, fades by NBA game-clock elapsed time, uses `trailingGameMinutes` for current-game memory, and blends a short `recentWallMinutes` wall-clock tack-on with `recentWallWeight`.
- FR-9: K is a compute parameter; nothing about K is ever persisted in the gold DB.
- FR-10: Detector contract tests must assert: Hartenstein fires at K=6 with bucket-start `2026-05-08T03:12:00Z` and watcher-end `03:13:00Z`; Reaves no-fire at K=6 on both game ids; K=3 snapshots locked for both incidents and 64-game mean.
- FR-11: Any future change to `K_MAD_LIVE` or `K_MAD_CALM` must be accompanied by fresh contract-test snapshots AND a bumped `detector_version` in the detector module.

**API surface**
- FR-12: The API exposes only the routes in §15; no admin queue routes, no PUT for market-anomaly score config.
- FR-13: Every route validates its query/body with Zod; no `as` casts at route boundaries.
- FR-14: The API generates `/openapi.json` automatically via `@fastify/swagger`; desk-stable routes carry the `desk-stable` tag and internal routes carry the `internal` tag.
- FR-15: All routes require header `X-Signal-Token` matching `~/.signal-console/token`, except `/v1/health/live`.
- FR-16: `/v1/board/:gameId` always computes at the live default `K_MAD_LIVE = 3.0`; the route does not accept a K override (Backtest is the override surface).
- FR-17: `POST /v1/backtest` bounds: window ≤ 28 days; ≤ 20 games per request; returns 400 with clear message if exceeded.

**Front-end**
- FR-18: The web app has exactly five routes: `/`, `/live/:id`, `/backtest`, `/detectors`, `/settings`.
- FR-19: Recent (`/`) does not auto-refresh on first load.
- FR-20: Live (`/live/:id`) is opt-in (user must click into a game) and polls at 30 s.
- FR-21: Backtest's Sensitivity dial defaults to `kMad=3.0` with labelled snap points at 3.0 ("Sensitive — live default") and 6.0 ("Calm — comparison preset"); Signal timing defaults to `baselineMode="opening-ramp"`, `openingBaselineBuckets=4`, `openingRampCompleteBuckets=20`, `trailingBuckets=20`, and `warmupBuckets=8`, and displays exact durations from `bucketSeconds`.
- FR-22: Moving the Backtest dials never changes the K or trailing-window values used by Recent or Live (FR-16 enforces this at the API level).
- FR-23: The Backtest first 28-d / 20-game sweep completes in < 60 s; subsequent K or trailing-window changes complete in < 1 s.

**Detector registry**
- FR-24: A new detector requires one new file at `packages/detectors/src/<name>/index.ts` and one new line in `packages/detectors/src/registry.ts`; no other file changes for the detector to appear in `/detectors` and `/backtest`.
- FR-25: The UI auto-renders parameter controls from the Zod paramsSchema (number → slider/number, enum → select, boolean → switch).

**Sport-agnosticism**
- FR-26: Sport-agnostic SQL fragments live as CTE template strings in `packages/db/src/sport-views.ts`; the new repo never executes `CREATE TEMP VIEW`.
- FR-27: `/v1/games` accepts an optional `sport=` filter; missing returns all sports.

**Tests and CI**
- FR-28: `pnpm verify` runs anywhere without the gold DB: lint + typecheck + unit + fixture-based contract tests + cache-DB tests against in-memory SQLite + `pnpm verify:no-stale-plan` + bug-fix regression guard.
- FR-29: `pnpm verify:gold` runs only with the moved gold DB present: query-plan smoke + SLO timing tests.
- FR-30: `pnpm verify:no-stale-plan` ripgreps for forbidden strings: `nba-predict/data/signal-console.sqlite`, `K = 6.0 only`, `source_data_version`, `\bdata_version\b`, `shadow mode`, `old worker keeps writing`. Must return zero hits in scanned files. Scoped allow-list: `docs/gold-db-relocation.md`, `docs/PRD.md` (this file), `docs/relocation/**`, lines marked `(historical, do not use)`. The allow-list lives in `scripts/verify-no-stale-plan.ts`.
- FR-31: Query plan snapshot diffs are reviewed, not auto-updated; updating requires `pnpm verify:queries -u` plus a PR note.

**Auth / tunnel**
- FR-32: The Cloudflare tunnel is parked during Phase 0's cutover (verified by `curl --fail https://nba-predict.dtmont.com` returning an error) and repointed to `localhost:32140` in Phase 1 only after the Phase-1 smoke passes.
- FR-33: Token rotation: editing `~/.signal-console/token` takes effect without restarting Fastify.

**LOC ceiling**
- FR-34: The new repo stays focused. No hard LOC ceiling; the goal is to avoid the old repo's 73k-LOC bloat patterns (mega-files, conflated responsibilities). Judgment over numbers.

---

## 23. Non-Goals (Out of Scope)

- Migrating the gold SQLite store off SQLite as a *format* change.
- Multi-user auth or per-team access controls (`X-Signal-Token` is a single shared header for Phase 1; per-team tokens deferred to Phase 2+).
- Concurrent operation of `~/nba-predict` post-cutover. After Phase 0 the old repo is reference-only; it does not run. No shadow period.
- A second-by-second push API. This rebuild is read-side only on the API path. Phase 0.5 ingest (if it ships) writes ticks on the schedule the worker runs.
- The "trading desk integration contract" — owned by the desk; we expose REST + JSON and respond to requests.
- Backing up the detector cache DB. It is derived state; if lost, recompute fills it lazily.
- Per-K persistence in the gold DB. K is a compute parameter, never a column.
- Lazy baseline rebuild on first board call. The new app's board endpoint computes per-game from `quote_ticks` directly; it does not depend on `board_volatility_baselines` for any fire decision.
- The `nba-predict` admin queue (`drainQueuedAdminActions`, etc.). Not ported. Phase 0.5 worker is bare ingest only.
- Migrating away from SQLite to DuckDB / Postgres. Deferred until measured pain.
- Per-sport detector forks before a second sport's data exists.

---

## 24. Design Considerations

- **Design language:** see `docs/design-language.md` for the full palette, typography, motion, and component rules. Lineage: bet365 (palette + typographic restraint), Linear (type craft), NYT election needle (the dial as a moment). Tokens declared once in `packages/ui/src/tokens.ts`; no hex literals outside that file.
- UI uses Tailwind tokens + headless primitives in `packages/ui/`. Recharts for charts, themed to the design language (1 px lines, no gridlines, hover-only labels). Recent + Live + Backtest each ship one focused view; no kitchen-sink dashboard.
- Recharts theme: ported from `nba-predict/apps/web/src/lib/chart-theme.ts`.
- Date/time formatting: ported from `nba-predict/apps/web/src/lib/time-format.ts`.
- Market formatting: ported from `nba-predict/apps/web/src/lib/market-format.ts`.
- Source coverage badges: ported from `nba-predict/apps/web/src/lib/source-coverage.ts`.
- Game triage logic: ported from `nba-predict/apps/web/src/lib/game-triage.ts`.
- Divergence history helpers: ported from `nba-predict/apps/web/src/lib/divergence-history.ts`.
- Each port keeps its existing tests.
- The Backtest dial UX matches the video plan narration at `~/markdown-video-experiment/projects/signal-console-explainer/plan.json` — "It's a dial" remains the control metaphor for both primary knobs.

---

## 25. Technical Considerations

- Stack: React 19, Vite 6, Tailwind, Tanstack Query, Zustand (tiny — command palette state only), Recharts, Zod, Fastify, better-sqlite3. Python sidecar (Phase 0.5) stays Pydantic v2 + nba_api.
- LOC budgets per file are guidance, not gates. Route handlers ~250, service modules ~400, query modules ~200, detector modules ~350 are reasonable targets — exceed them if the module is focused. No hard total ceiling; the anti-pattern to avoid is conflated mega-files like the old repo's 3,300-LOC live-repository.ts.
- EXPLAIN-validated: `quote_ticks` per-game time-window queries use `idx_quote_ticks_unique_observation (source_market_id, captured_at)` and a covering subquery on `idx_source_markets_game_instrument`. Indexes for "lightweight" already exist; the win is calling fewer endpoints.
- Backtest pre-bucket-once pattern: pre-bucket in a single SQL pass, re-sweep K in JS. Microseconds per K value enables sub-second dial response.
- Cache freshness model is per-game / per-window scoped via watermarks (no global invalidation token); active games recompute on next render, closed games stay warm.

**SLO targets (measured against the moved gold DB on the owner's laptop):**

| Operation                              | Budget                                        | Implementation                          |
| -------------------------------------- | --------------------------------------------- | --------------------------------------- |
| Recent (24-h list), warm cache         | < 500 ms                                      | One query, one index, plus per-game cache hits |
| Recent (24-h list), cold cache         | < 2 s for ~20 games                           | Same query + per-game detector compute on miss; cached after |
| Open one game's live view              | < 300 ms                                      | Bounded `(source_market_id, captured_at)` range scan + detector recompute on each render |
| Click into one market's timeline       | < 300 ms                                      | Same composite index                    |
| Backtest K-sweep over 28 d, ~20 games  | < 60 s first sweep; < 1 s for cached params  | One bounded read of `quote_ticks`, then in-memory K iteration; cache by `params_hash` |
| Settings page                          | < 100 ms                                      | `pragma_page_count` on gold DB + cache DB, log tail, no scans |
| First contentful paint, no API config  | works                                         | API errors render as banners, not blocks |
| API cold start                         | < 2 s                                         | `pnpm --filter @signal-console/api dev` |
| Web preview FCP with API responding    | < 1 s                                         | `pnpm --filter @signal-console/web preview` |

---

## 26. Risks & mitigations

- **Phantom risk: changing K invalidates persisted baselines.** Earlier drafts of this plan assumed `K_MAD` was a persisted dimension of `board_volatility_baselines`. It is not. `board_volatility_baselines` stores expected-range bands keyed by phase / source / core-family; the K value appears only in a display-label string (`cohortKey`), not as a column. The `board-mad` detector computes its baseline on the fly per-game. No risk; the earlier draft was wrong.
- **Ingest gap during cutover.** Stopping the old worker before the Phase-0 move leaves a window where no new ticks are written. Owner has confirmed this is acceptable given the current game schedule. Phase 0.5 ports a minimal ingest writer to close the gap if/when needed.
- **Move integrity (WAL/SHM).** Moving the gold DB requires all three files (`-`, `-wal`, `-shm`) to travel together while no writer holds them. The procedure stops the worker first and verifies via `lsof` before moving. `integrity_check` after the move is the green-light; any failure halts cutover and triggers a rollback (move files back).
- **Cloudflare downtime during cutover.** The tunnel is parked during the move. Acceptable: the desk doesn't have a continuous read SLA yet, and a few minutes of 502 is preferable to serving stale or inconsistent data.
- **Worker keeps writing while we read (post Phase 0.5).** `better-sqlite3` with `?mode=ro` and `PRAGMA busy_timeout=5000` handles concurrent writers transparently; long readers will not block writers because WAL allows snapshot reads.
- **Cache staleness while the Phase-0.5 worker writes.** Each cache row carries a `source_watermark_hash` computed from per-game watermarks. Active games recompute on the next render because their watermark moves; closed games stay warm. No global invalidation step.
- **Gold-DB schema assumption drift.** The PRD describes `v_games` and `v_events` CTEs based on the worker's current schema. Exact column names are verified by `pnpm verify:queries` at Phase 0; drift is a single-file fix in `packages/db/src/sport-views.ts`.
- **Phantom risk: lazy baseline rebuild on first board call.** That code lives in the old repo, which does not run after Phase 0. The new app's board endpoint computes per-game from `quote_ticks` directly; no rebuild path exists.
- **DB outgrowing SQLite.** Out of scope. Query layer is small enough (~6 files) that a swap to DuckDB or Postgres later is bounded. Defer until measured pain.
- **Bus factor on the detector port.** Detector contract tests are the spec; if a future port disagrees with the Python reference, the snapshot failure is the diff to review.

---

## 27. Verification at the end of each phase

- `pnpm verify` (lint + typecheck + unit + fixture tests; no gold DB required). Then `pnpm verify:gold` locally for query-plan + SLO checks against the moved DB.
- `pnpm verify:no-stale-plan` — ripgrep across the repo for forbidden strings (see FR-30). Must return zero hits.
- `du -sh ~/signal-console/data/signal-console.sqlite` is stable across phases except where Phase 0.5 ingest is explicitly running. The API path must never change the byte count.
- **Phase 0:** confirm `~/nba-predict/.DEPRECATED` exists, `~/nba-predict/data/MOVED.txt` exists, and `~/nba-predict/data/signal-console.sqlite` no longer exists; confirm `sqlite3 -readonly ~/signal-console/data/signal-console.sqlite "PRAGMA integrity_check;"` returns `ok`.
- `pnpm --filter @signal-console/api dev` cold start in < 2 s.
- `pnpm --filter @signal-console/web preview` first contentful paint < 1 s with API responding.
- A manual smoke per phase: open `/`, open one game, open Backtest, move the dials, open Settings.
- **Phase 0.5 (if shipped):** confirm new worker's heartbeat file is being updated and `quote_ticks` row count grows over time.

---

## 28. Success Metrics

- **Phase 0 done:** `integrity_check` returns `ok` on moved DB; read-only open returns `query_only=1`; contract tests green at both K values; old path has the sentinel; byte-equivalent DB is gone from there.
- **Phase 1 done:** Recent cold-cache < 2 s for ~20 games, warm < 500 ms; the desk's first `GET nba-predict.dtmont.com/v1/games` (with valid token) returns OpenAPI-described JSON.
- **Phase 2 done:** Live opens without triggering anything that resembles a baseline rebuild; fires match the canonical contract tests at K=3.0.
- **Phase 3 done:** 28-d / ~20-game first sweep < 60 s; dial changes < 1 s; UI matches the video's narrated UX.
- **Phase 4 done:** `/v1/games?sport=NBA` and `?sport=NFL` (empty) both work; `docs/sport-onboarding.md` exists.
- **Phase 5 done:** `~/nba-predict` archived or deleted; no process in the new repo references the old path.
- **Code health:** Modules stay focused; no LOC ceiling enforced. Old-repo anti-patterns (mega-files, conflated responsibilities) are absent.
- **Math honesty:** `pnpm verify:no-stale-plan` returns zero hits for `K = 6.0 only` and related forbidden strings.

---

## 29. Open Questions

- Should `/v1/board/:gameId` accept an optional K override behind a `desk-only` tag, or strictly remain at K_MAD_LIVE? **Current decision: strictly K_MAD_LIVE.** Revisit only if the desk explicitly asks for it and we can serve it from the cache by `params_hash`.
- Should the `off-price-print` detector eventually ingest Bet365 / Kalshi prints alongside Polymarket? Out of scope for v1 (Polymarket-only); the UI surface (US-208) documents the limitation.
- Should the K=3 64-game-mean snapshot in US-009 commit to a directional inequality (e.g. `>= 14`) or just an exact snapshot? **Current decision: exact snapshot.** Drift triggers a review.
- Should we ship per-team `X-Signal-Token` values in Phase 2? Depends on whether the desk asks for distinct call-audit. Default = single shared token.
- Phase 5 subdomain rename (`nba-predict.dtmont.com` → `signal.dtmont.com`) — defer until churn is justified.

---

## 30. Reference files (read; do not blindly copy)

- `~/nba-predict/scripts/board_signal_v2.py` — algorithm spec for `board-mad`. The Python is the canonical reference; the TS port must match it numerically on the committed JSON fixtures.
- `~/nba-predict/packages/shared/src/board-anomaly/game-state-volatility.ts:24-340` — TypeScript reference for the same algorithm. Its `BOARD_VW_K_MAD = 3` constant matches the new repo's live default (K = 3.0). The new repo also supports K = 6.0 as the Backtest calm comparison preset; neither value is hardcoded outside `packages/detectors/src/board-mad/config.ts`.
- `~/nba-predict/packages/shared/src/board-volatility-baselines.ts` — read for **what `board_volatility_baselines` actually stores** (expected-range bands by phase / source / core-family; no K dimension). Do not treat it as a fire-decision source.
- `~/nba-predict/packages/shared/src/migrations.ts` — schema documentation.
- `~/nba-predict/packages/shared/src/live-repository.ts` — query examples worth porting (extract small ones; do not import the file).
- `~/nba-predict/apps/web/src/lib/{game-state,time-format,market-format,source-coverage,game-triage,divergence-history,chart-theme}.ts` — pure utilities to port wholesale with their tests.
- `~/nba-predict/outputs/innovation-team-suspend-signal-report/REPORT.md` — the design rationale; the new repo's `docs/why-board-and-tape.md` is a 10× compression of this.
- `~/markdown-video-experiment/projects/signal-console-explainer/plan.json` — narration source for the Backtest dial labels and explainer copy.
- `~/nba-predict/.codex/hooks.json` — the regression-coverage guard to port.

---

## 31. After this PRD is approved

1. Run `/ralph` skill → emit `~/signal-console/prd.json`.
2. Kick the Ralph autonomous loop from the new repo.
3. Stop the Ralph loop after each phase; review the diff and logs before approving the next. Phases 0 and 0.5 are infrastructure changes (DB move, sentinel, optional ingest port) and warrant manual review before Phase 1's tunnel repoint.
4. `~/nba-predict` does **not** keep running — it is reference-only from the moment Phase 0's cutover completes.
