# Live Data Contract

Last verified: 2026-06-07

This is the durable contract for the current Live page, `/v1/live/:gameId`, NBA
play-by-play persistence, and source freshness. Update this file when the live
API response, PBP schema, worker capture modes, or Live page polling model
changes.

## Current Live Surfaces

`GET /v1/live/:gameId` is no longer "raw ticks only". It returns one bounded
market-tick window plus official game activity scoped to the same replay end.

Top-level response:

- `gameId`
- `windowStart`
- `windowEnd`
- `ticks`
- `activity`

`ticks` still come from `quote_ticks` joined to `source_markets` and remain the
market observation lane. They carry `sourceMarketId`, optional `source`,
`capturedAt`, `impliedProbability`, `volume`, `isHeartbeat`, `instrumentId`,
`rawFamily`, and `rawLabel`.

`activity` is official game context:

- `gameState`: latest row in `game_states` with `captured_at <= windowEnd`, or
  `null` when unavailable.
- `playByPlayActionCount`: count of official PBP actions visible at
  `windowEnd`.
- `recentPlayByPlay`: latest visible PBP actions, newest first, currently capped
  to eight rows.

Historical replay must stay time-scoped. A request with `at=` and `window_ms=`
must not mix a past tick window with final score, final status, or corrected PBP
that was not captured by the requested replay end.

## NBA PBP Persistence

The current NBA PBP schema includes player attribution:

- `sub_type`
- `person_id`
- `player_name`

The sidecar exposes these fields in `PlayByPlayAction`; the worker normalizes
them and writes them through `recordNbaPlayByPlayActions`.

There are two persistence paths:

- `nba_play_by_play_actions`: the current latest row per
  `(game_id, action_number)`.
- `nba_pbp_revisions`: append-only revision shadow keyed by
  `(game_id, action_number, captured_at)`.

The revision table exists because official NBA PBP can change after first
capture. `recordNbaPlayByPlayRevisions` writes a new revision only when the
action payload changes. `listPbpAttributionTransitions` reports attribution
changes by comparing `person_id`, fallback `player_name`, and `sub_type`.

`/v1/live/:gameId` reads `nba_pbp_revisions`, not just the current table, for
activity. For each action it selects the latest revision with
`captured_at <= windowEnd`, then filters to actions with `time_actual <=
windowEnd`. This is the replay-safety rule.

## Worker Capture Modes And Freshness

`adapter_runs.capture_mode` is the source-of-truth distinction between live
freshness and historical/discovery work. Valid modes are:

- `live`
- `historical`
- `discovery`

`recordAdapterRun` defaults to `live`; backfill, research pull, discovery, or
other non-live jobs must set the mode explicitly.

`apps/worker/src/heartbeat-emitter.ts` now derives per-source Settings freshness
from successful `adapter_runs` with `capture_mode = 'live'`, not from
`MAX(quote_ticks.captured_at)`. This keeps heartbeat emission bounded on large
tick stores and prevents historical backfills from making a source look freshly
live.

`nba-sidecar` is a special source label:

- Do not show `nba` directly in Settings freshness.
- Show `nba-sidecar` only when the sidecar is configured.
- Prefer the current worker cycle's observed sidecar sync time over an older
  successful adapter-run row.

Live sidecar sync suppresses PBP fetches for scheduled future games. Historical
backfill uses `captureMode: "historical"` and may disable that suppression when
the anchor date is in the past.

## Live Page Polling Contract

The Live page polls these surfaces every 30 seconds when a game id is present:

- `/v1/live/:gameId`
- `/v1/ensemble-or/:gameId`
- `/v1/microstructure/:gameId`
- `/v1/off-price-print/:gameId`
- `/v1/settings`

`/v1/settings` is used to pass the live off-price volume-share threshold into
`/v1/microstructure`. The board threshold shown on the Live chart comes from
`/v1/ensemble-or` response `k`, not from a separate settings fallback.

The UI must keep official game/PBP activity separate from market model output.
Wall-clock market buckets are not basketball game-clock minutes.

## Verification

Focused checks for this contract:

```bash
pnpm --filter @signal-console/api test -- apps/api/tests/live.test.ts
pnpm --filter @signal-console/shared test -- packages/shared/src/__tests__/live-repository.test.ts
pnpm --filter @signal-console/worker test -- apps/worker/src/__tests__/nba-sidecar.test.ts apps/worker/src/__tests__/worker.test.ts
pnpm --filter @signal-console/web test -- apps/web/src/features/live/__tests__/LivePage.test.tsx
```

The full repo gate remains:

```bash
pnpm verify
```
