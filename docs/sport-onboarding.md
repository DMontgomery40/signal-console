# Adding a sport

> Operational runbook for onboarding a **new sport** (NFL, NCAAF, NCAAM,
> NHL, MLB, soccer leagues) into Signal Console. This is the doc that
> complements `docs/adding-a-source.md`:
>
> - **`adding-a-source.md`** — new upstream feed (FanDuel, DraftKings) for
>   a sport we already ingest.
> - **`sport-onboarding.md`** (this doc) — a sport we do not yet ingest at
>   all: new play-by-play table, possibly a new participant JSON shape,
>   sport-specific detectors, and the `v_events` `UNION ALL` extension.
>
> The two documents have intentional overlap (both edit `types.ts`, both
> add fixtures and contract tests), but the surface area is different. If
> the new feed is a sportsbook for NBA, read `adding-a-source.md`. If you
> are wiring NFL ticks for the first time, read this one.

A new sport is a **multi-iteration** change. Expect 4–8 stories in
`prd.json`, each gated by the prior. Do not try to land it all in one PR.

---

## 0. Scope check before you start

Before any code lands, answer in the PR description:

- Which **league(s)** does this cover (NFL is one league, NCAAF is
  another, EPL is another)? Each league usually has its own PBP feed and
  its own participant identifier conventions.
- What is the **canonical participant identity** in this sport's gold-DB
  rows? NBA stores team triCode + teamId in `home_participant_json` /
  `away_participant_json`. NFL has the same team/team shape. Soccer has
  it too. Tennis is one-on-one with player ids, **not teams** — that
  needs an explicit shape decision before writing SQL.
- What is the **play-by-play granularity**? NBA emits one row per
  in-game action (shot attempt, foul, timeout) at sub-second resolution.
  NFL emits one row per play (snap → end of play); MLB emits one per
  pitch. The detectors that consume `v_events` assume the PBP is
  reasonably dense — if a new sport is too sparse, board-MAD's per-minute
  bucketing may need rethinking before you ship.
- Does the sport have a **season clock** the dashboard needs to display
  (NFL: quarter + game clock, MLB: inning + outs, soccer: half + added
  time)? The `v_events` column set fixes this — see §3.
- Are there **legal / TOS constraints** on storing PBP for this sport's
  league (NCAA, in particular, is its own conversation)? Owner decision
  before coding.

If any answer is "I'm not sure," surface the question before writing the
ingest module. Schema shape mistakes are expensive once data starts
landing.

---

## 1. Gold-DB schema

The ingest worker — not this codebase — owns the writable side of the
gold DB. From the API/UI side, the gold DB is read-only (enforced by
`openGoldDb()`'s four guards in `packages/db/src/open.ts`). Schema
extension work happens in the worker repo; this runbook tells the
worker what shape Signal Console expects on the read side.

### 1.1 Required tables for a new sport

For each new sport, the worker must land:

- A **PBP table** named `<sport>_play_by_play_actions` (e.g.
  `nfl_play_by_play_actions`). The required column set is the union of
  what `v_events` projects today (see §3 for the canonical shape):
  - `game_id` (TEXT, FK to `games.id`)
  - `action_number` (INTEGER, monotonic within a game)
  - `action_type` (TEXT, sport-specific vocabulary — "pass", "rush",
    "field_goal_attempt" for NFL; "shot", "foul" for NBA)
  - `period` (INTEGER — quarter for NFL, period for NBA)
  - `clock` (TEXT — game-clock string, "MM:SS" or sport-conventional)
  - `description` (TEXT — human-readable play description)
  - `time_actual` (TEXT — wall-clock ISO 8601 timestamp)
  - `captured_at` (TEXT — when the worker observed the row)
- Rows in the **existing `games` table** with `sport = '<UPPERCASE>'`
  (e.g. `sport = 'NFL'`) and `league = '<UPPERCASE>'`.
- Rows in the **existing `game_states` table** for status tracking
  (`status` values: `scheduled`, `in_progress`, `final`, `postponed`,
  `cancelled`; the latest row per game wins via the correlated subquery
  in `v_games`).
- If the sport's `home_participant_json` / `away_participant_json` shape
  differs from NBA's, document the shape in this runbook (§2.2) so
  callers can parse it.

### 1.2 What does NOT need a new table

- `quote_ticks`, `source_markets`, `market_microstructure_events` — all
  sport-agnostic. The detectors read these regardless of sport. A new
  sport reuses them.
- `game_outcomes` — sport-agnostic; the worker writes a row per finished
  game with sport-appropriate `final_score_home` / `final_score_away`
  values.

### 1.3 Indexes

The worker must create on the new PBP table:

- `idx_<sport>_pbp_game_action` on `(game_id, action_number)` — primary
  read path for `pbp-for-one-game` in `scripts/verify-queries.ts`. If
  this index is missing, the query-plan snapshot in §5.1 will fail with
  a full SCAN on the new table.

---

## 2. Extending `v_games`

`v_games` lives in `packages/db/src/sport-views.ts`. It is the
sport-agnostic projection of the `games` table joined to the latest
`game_states` row.

### 2.1 No-change path (recommended)

If the new sport's `games`-row shape matches NBA — `sport`, `league`,
`scheduled_start`, `home_participant_json`, `away_participant_json`
already populated by the worker, and `game_states.status` carries the
status — `v_games` does **not** need to change. The same CTE projects
both sports.

Verification: `sqlite3 ~/signal-console/data/signal-console.sqlite "SELECT
DISTINCT sport FROM games"` should list every sport the worker ingests.

### 2.2 Shape-divergence path

`v_games` changes only when a new sport's participant JSON cannot be
parsed with the same code path as NBA's. Examples:

- **Team vs. individual.** NBA / NFL / NHL / soccer all store
  `{ "teamId": "...", "triCode": "..." }`. Tennis would store
  `{ "playerId": "...", "country": "..." }`. The column names differ.
- **Roster snapshot vs. team id.** Some leagues' upstreams include a
  lineup snapshot in the participant JSON; others do not.

When the shapes diverge, the change to `sport-views.ts` is one of:

- **Per-sport SQL fragment.** Introduce a helper that returns a
  per-sport `home_participant_json` / `away_participant_json` projection
  and `UNION ALL`s them inside `v_games`. The caller still sees
  uniformly-named columns.
- **JSON passthrough + parser dispatch.** Keep `v_games` projecting the
  raw JSON column unchanged, and add a TypeScript dispatcher (e.g.
  `parseParticipant(sport, json)`) in `packages/db/src/participants.ts`.
  Callers route by `sport`. This is the preferred path when the divergence
  is read-side only — no SQL change at all.

If you take the JSON-passthrough path, update §3 of this doc to point
the future maintainer at the dispatcher.

---

## 3. Extending `v_events`

`v_events` is the cross-sport projection of every play-by-play table.
Today it is NBA-only:

```ts
export const v_events: string = `
  SELECT
    'NBA'             AS sport,
    pbp.game_id       AS game_id,
    pbp.action_number AS action_number,
    pbp.action_type   AS action_type,
    pbp.period        AS period,
    pbp.clock         AS clock,
    pbp.description   AS description,
    pbp.time_actual   AS time_actual,
    pbp.captured_at   AS captured_at
  FROM nba_play_by_play_actions pbp
`;
```

### 3.1 Where the `UNION ALL` goes

For a new sport (worked example: NFL), the change is mechanical:

```ts
export const v_events: string = `
  SELECT
    'NBA'             AS sport,
    pbp.game_id       AS game_id,
    pbp.action_number AS action_number,
    pbp.action_type   AS action_type,
    pbp.period        AS period,
    pbp.clock         AS clock,
    pbp.description   AS description,
    pbp.time_actual   AS time_actual,
    pbp.captured_at   AS captured_at
  FROM nba_play_by_play_actions pbp
  UNION ALL
  SELECT
    'NFL'             AS sport,
    pbp.game_id       AS game_id,
    pbp.action_number AS action_number,
    pbp.action_type   AS action_type,
    pbp.period        AS period,
    pbp.clock         AS clock,
    pbp.description   AS description,
    pbp.time_actual   AS time_actual,
    pbp.captured_at   AS captured_at
  FROM nfl_play_by_play_actions pbp
`;
```

Rules of thumb:

- **Column count and order must match exactly.** SQLite's `UNION ALL`
  is positional, not by-name. The aliases on the right (`AS sport`,
  `AS game_id`, etc.) are advisory for readers; the column types of the
  first SELECT define the result type.
- **The literal sport tag is upper-case and matches the `games.sport`
  enum.** Callers filter via `WHERE sport = 'NFL'`; the literal here is
  the canonical name.
- **Do NOT rename existing columns.** Detectors and API routes
  (`apps/api/src/services/microstructure.ts`, the board-MAD detector
  input pipeline) reference `action_type`, `period`, `clock` by name.
  Renaming for one sport breaks every other sport's reads.
- **If a sport's PBP lacks one of the columns**, project a NULL:
  `NULL AS clock` for sports without a game clock. Callers must handle
  `clock` being optional anyway (NBA quarter breaks emit `clock = ''`).

### 3.2 What if a sport needs a new column?

`v_events` is the lowest common denominator across sports. If you need
sport-specific columns (NFL down-and-distance, MLB ball-strike count),
**do not add them to `v_events`**. Instead:

- Project the sport-specific columns from the underlying PBP table in a
  separate, sport-specific CTE (e.g. `v_events_nfl_extended`).
- Detectors that need the extended columns import the extended CTE
  directly. Detectors that consume the cross-sport shape continue using
  `v_events`.

This keeps the abstraction honest: cross-sport detectors get a
guaranteed-uniform schema; sport-specific detectors opt in to the
sport-specific surface.

---

## 4. Source enum and detector registry

Most of this is the same as `docs/adding-a-source.md` step 5 (the source
union in `packages/detectors/src/types.ts`), but with one extra step
specific to a new sport.

### 4.1 If the sport reuses existing sportsbooks (FanDuel for NBA → NFL)

No `Source` union change. The detectors' `sources` array does not
change. The new sport's `source_markets` rows reference the same
sportsbook source ids.

### 4.2 If the sport ships with a new exchange

Extend the `Source` union in `packages/detectors/src/types.ts` — same
procedure as `adding-a-source.md` §5.

### 4.3 Sport-specific detectors

A sport-specific detector (e.g. an NFL drive-anomaly detector that
reads NFL down-and-distance) lives under
`packages/detectors/src/<detector-name>/` and lists its sports
explicitly in its registry entry:

```ts
export const detector: Detector = {
  id: "nfl-drive-anomaly",
  version: 1,
  sports: ["NFL"], // closed enum; future-tense detectors set this
  sources: ["bet365", "polymarket"],
  // ...
};
```

The registry (`packages/detectors/src/registry.ts`) re-exports the union
of detectors. The Detectors page filters by `sports` when the user has
chosen a sport — a detector that does not list a sport is hidden for
that sport. **board-mad and off-price-print are explicitly sport-agnostic
today**; if you want them sport-gated, add an explicit `sports: ["NBA",
"NFL"]` listing rather than leaving the field absent (absent = all
sports; the chip then reads "ALL SPORTS").

---

## 5. Tests to add

A new sport needs five test layers; cross-sport regressions usually
land in the seam between them.

### 5.1 Query-plan snapshot for the new PBP read path

`scripts/verify-queries.ts` snapshots `EXPLAIN QUERY PLAN` for the five
hottest queries. The `pbp-for-one-game` query reads from
`nba_play_by_play_actions` today; when NFL lands, you have two choices:

- **Add a second snapshot.** Duplicate the `pbp-for-one-game` entry in
  `QUERIES` (rename to `pbp-for-one-game-nba` and add a sibling
  `pbp-for-one-game-nfl`), point each at the respective physical table,
  and commit two snapshots under
  `packages/db/src/queries/__tests__/__snapshots__/`.
- **Use `v_events` directly.** Replace the physical-table query with a
  `WITH v_events AS (...)` wrapper that filters by sport. The snapshot
  then shows the planner walking the `UNION ALL` and applying the sport
  filter. This is the recommended path once two or more sports exist.

In both cases, the new sport's PBP table MUST surface in plan rows as
`SEARCH ... USING INDEX idx_<sport>_pbp_game_action`. A full SCAN of a
non-trivial table (the list lives in `NON_TRIVIAL_TABLES` in
`scripts/verify-queries.ts`) causes `pnpm verify:queries` to exit 1.

Add the new sport's PBP table name to `NON_TRIVIAL_TABLES` when you add
its snapshot. The full SCAN guard is what catches a missing index.

### 5.2 Sport-agnostic detector contract tests

`packages/detectors/src/board-mad/__tests__/canonical.test.ts` is the
spec for board-MAD. The K=6.0 outcomes are anchored to documented NBA
moments. **Do not delete or relax those tests** when adding a new
sport — they are the contract that prevents detector drift.

Instead, add a parallel contract test under
`packages/detectors/src/board-mad/__tests__/canonical-<sport>.test.ts`
with sport-specific anchors. The NFL equivalent is one or more
documented NFL volatility moments (a known late-game line move on a
documented date / game id) — anchor the K=6.0 test to that bucket-start
timestamp, exactly as the NBA test anchors to the Hartenstein bucket.

If the new sport has no documented anomaly to anchor to, add a
**directional** assertion only ("K=3 produces more fires than K=6 on
this fixture") and explicitly say so in the story `notes`. Snapshot
the actual fire count to lock the behavior; a future story replaces
the directional assertion with an anchored one when a real moment is
identified.

### 5.3 Sport-specific detector contract tests

For each sport-specific detector you ship (§4.3), add a contract test
under `packages/detectors/src/<detector-name>/__tests__/canonical.test.ts`
following the same pattern as board-MAD: fixture(s) under
`__tests__/fixtures/`, fire-count assertions at K=3 and K=6 (or
whatever knobs the detector exposes), at least one assertion anchored
to a documented moment.

### 5.4 API route smoke

`apps/api/tests/games.test.ts` (and the routes it exercises) must be
extended to assert:

- `GET /v1/games?sport=NFL` returns rows when NFL games exist (and an
  empty array, **not** a 404, when none do — the route shape is stable
  even with no data).
- `GET /v1/games/<nfl-game-id>` returns a single row with `sport: "NFL"`.
- The OpenAPI doc (`apps/api/openapi.yaml` or equivalent) lists the new
  sport in the `sport` enum.

### 5.5 UI smoke (when a sport ships with a UI affordance)

If the new sport gets its own filter chip, league badge, or page
variant:

- A render test under `apps/web/src/features/.../__tests__/` asserts
  the chip / badge text matches the design language tokens. **No hex
  literals outside `packages/ui/src/tokens.ts`** — verified by
  `pnpm verify:no-hex-literals`.
- A real-mouse screenshot per the UI Verification Protocol in
  `scripts/ralph/CLAUDE.md` — minimum three PNGs (baseline,
  primary-interaction, edge state) at the documented viewport sizes.

---

## 6. Cache invalidation

The board-MAD service caches per-game runs keyed by `(detector, version,
params, source_watermark_hash, game_id)`. For a new sport that reuses
`quote_ticks` (the expected path), the existing
`(cnt, max_id, max_captured_at)` watermark over `quote_ticks` already
covers it. No code change required.

If a sport-specific detector reads from a **different** physical table
(e.g. the new PBP table for an NFL drive detector), the watermark hash
for that detector must include that table's
`(cnt, max_id, max_<timestamp_col>)` triple. The hash function lives in
`apps/api/src/services/board.ts::computeGameWatermarkHash`; extend it
per-detector if the read set diverges.

After adding the new sport, **verify the cache invalidates** by:

1. Running a backtest at the defaults; recording `fires/game`.
2. Inserting a new PBP row for a game in the window (in a sandbox copy
   of the gold DB, not production).
3. Re-running the backtest with identical params; asserting the run
   row's `source_watermark_hash` is different and a recompute fired.

If the hash is the same, the watermark function is missing the new
table — fix that before declaring the sport done.

---

## 7. Worked example — NFL onboarding (minimum-touch path)

Smallest realistic path for adding NFL with one quote-only sportsbook
(FanDuel) and no sport-specific detector. This is 6 stories in
`prd.json`; the bullet list shows the per-story diff shape.

### Story A — Worker: NFL ingest + schema

- Add `apps/worker/src/nfl/` (ingest client, normalization, heartbeat
  handling — same outline as `adding-a-source.md` §1–§3).
- Migration: `CREATE TABLE nfl_play_by_play_actions (...)` with column
  set per §1.1 and the `idx_nfl_pbp_game_action` index per §1.3.
- Fixture file shape (the worker emits one row per snap):

  ```jsonc
  // ~/signal-console/packages/detectors/src/board-mad/__tests__/fixtures/nfl-fixture.json
  // Same envelope as the existing nba-*.json.gz fixtures; the loader is
  // sport-agnostic and reads ticks + game metadata.
  {
    "gameId": "nfl-2026010100",
    "sport": "NFL",
    "league": "NFL",
    "scheduledStart": "2026-01-01T18:00:00Z",
    "homeParticipant": { "teamId": "BUF", "triCode": "BUF" },
    "awayParticipant": { "teamId": "KC", "triCode": "KC" },
    "ticks": [
      {
        "sourceMarketId": "fanduel-nfl-ml-2026010100-buf",
        "capturedAt": "2026-01-01T18:00:00Z",
        "impliedProbability": 0.48,
        "volume": 12345,
        "isHeartbeat": 0,
      },
      // ...
    ],
    "pbp": [
      {
        "actionNumber": 1,
        "actionType": "kickoff",
        "period": 1,
        "clock": "15:00",
        "description": "Kickoff to BUF, returned to BUF 25",
        "timeActual": "2026-01-01T18:01:30Z",
      },
      // ...
    ],
  }
  ```

  Compress with `gzip` and store as `nfl-2026010100.json.gz` next to
  the NBA fixtures. The fixture loader inspects the `sport` field and
  routes accordingly.

### Story B — `v_events` `UNION ALL`

- Edit `packages/db/src/sport-views.ts` per §3.1.
- Re-run `pnpm --filter @signal-console/db test` (existing tests must
  still pass — the CTE is additive).
- `pnpm verify:queries -u` to refresh the `pbp-for-one-game` snapshot
  (or split it per §5.1). Review the diff before committing.

### Story C — Source enum (skip if no new sportsbook)

For NFL with existing sportsbooks: skip. For NFL with a new exchange:
follow `adding-a-source.md` §5.

### Story D — `/v1/games?sport=NFL` smoke

- The route already accepts `sport=` (US-040). No code change.
- Test: `apps/api/tests/games.test.ts` asserts `?sport=NFL` returns
  an empty array against a fixture-backed in-memory DB with no NFL
  rows (200, not 404), and returns rows when NFL games are seeded.
- OpenAPI doc updated to list `NFL` in the `sport` enum.

### Story E — board-MAD contract test for NFL

- Add `packages/detectors/src/board-mad/__tests__/canonical-nfl.test.ts`.
- Anchor at least one K=6.0 assertion to a documented NFL moment
  (referee whistle delay, late-game timeout sequence — owner
  identifies the anchor).
- Tolerance ranges follow the same pattern as the NBA tests: bucket-
  start timestamp + fires/game mean ± 1.0 (volume-weighted) or
  bucket-start timestamp alone (no fires-count assertion if the
  fixture is one game).

### Story F — UI smoke + design-language pass

If the Recent list / Detectors page get an NFL chip:

- Add tokens if a new sport color is needed (no hex literals outside
  `packages/ui/src/tokens.ts`).
- Render test asserts the chip text and tabular-figure formatting.
- Real-mouse screenshots per the UI Verification Protocol.

### Story G — Phase acceptance

- `pnpm verify` exits 0.
- `pnpm verify:no-stale-plan` exits 0.
- `pnpm verify:queries` exits 0 against the moved gold DB (with the
  NFL PBP table either populated or empty — both must work).
- `GET /v1/games?sport=NFL` returns the expected shape.

---

## 8. Checklist (run through before declaring the sport "shipped")

Mark each item before flipping the final story to `passes: true`.

**Schema**

- [ ] Worker creates `<sport>_play_by_play_actions` with all eight
      required columns and the `idx_<sport>_pbp_game_action` index.
- [ ] `games` rows land with `sport = '<UPPERCASE>'` and `league` set.
- [ ] `game_states` rows land per game with a valid `status` value.
- [ ] Participant JSON shape is either NBA-compatible or documented in
      this runbook §2.2 with a parser dispatcher.

**Views**

- [ ] `packages/db/src/sport-views.ts` `v_events` includes a
      `UNION ALL` against the new PBP table (or omits it if the sport
      legitimately has no PBP — rare).
- [ ] Column count and order in the new `UNION ALL` branch matches the
      existing branch exactly. Missing columns are `NULL AS <name>`.
- [ ] `v_games` either unchanged (recommended) or extended per §2.2
      with the divergence documented in this doc.

**Tests**

- [ ] `packages/db/src/queries/__tests__/__snapshots__/` contains a
      query plan for the new sport's PBP read path; the plan shows
      `SEARCH ... USING INDEX idx_<sport>_pbp_game_action`.
- [ ] `NON_TRIVIAL_TABLES` in `scripts/verify-queries.ts` includes the
      new PBP table name.
- [ ] `pnpm verify:queries` exits 0 against a gold DB containing at
      least one game in the new sport.
- [ ] Sport-agnostic detector tests (board-MAD, off-price-print) still
      pass on the new sport's fixture, at K=3 and K=6.
- [ ] For each sport-specific detector: `canonical.test.ts` with at
      least one anchored K=6.0 assertion.
- [ ] `apps/api/tests/` covers `?sport=<NEW>` (rows + empty + bad input).
- [ ] OpenAPI doc lists the new sport in the `sport` enum.

**Cache**

- [ ] `computeGameWatermarkHash` reads from every table the new sport's
      detectors consume.
- [ ] A backtest before and after seeding a new PBP row produces
      different `source_watermark_hash` values (verified by running
      twice and comparing the row in `detector_runs`).

**UI** (only when the sport ships a UI affordance)

- [ ] Tokens added in `packages/ui/src/tokens.ts`; no hex literals
      anywhere else (verified by `pnpm verify:no-hex-literals`).
- [ ] At least three real-mouse PNGs per the UI Verification Protocol
      in `scripts/ralph/CLAUDE.md`, at 1440×900 and 1024×768.
- [ ] Hover/focus/error states screenshotted.

**Gates**

- [ ] `pnpm verify` exits 0.
- [ ] `pnpm verify:no-stale-plan` exits 0.
- [ ] `pnpm verify:queries` exits 0.
- [ ] `pnpm verify:no-hex-literals` exits 0 (only relevant when the
      sport touched the UI).

---

## What this doc does NOT cover

- Adding a new sportsbook to an already-ingested sport — see
  `docs/adding-a-source.md`.
- Sport-specific UI page variants beyond the chip/badge layer (a
  dedicated NFL play view, for example) — those are large enough to
  warrant their own design-language story before coding.
- Decommissioning a sport — different problem; involves grandfathering
  detector cache rows keyed by sport-specific watermarks and
  announcing a deprecation window to API consumers.
- Pricing-data licensing for the new sport (NCAA, in particular) —
  owner decision before ingest goes live.

If your situation hits one of those, surface it in the PR description
and ask for an owner decision before writing code.
