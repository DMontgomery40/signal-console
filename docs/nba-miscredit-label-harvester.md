# NBA miscredit label harvester — operator runbook

The re-ranker's binding constraint is **labels**, not method (see
`docs/research-2026-05-31d-far-calibration-result.md`: matched recall N_scored=2,
CI≈[0,1]). There is **no official NBA corrections feed** — stat corrections are silent
edits to the same play-by-play action. So the label engine recovers them by **diffing
versioned PBP snapshots**: an action whose credited player changes between snapshots is
a `credited→rightful` transition = a miscredit label.

## The pipeline

```
  live PBP polls / re-captures
        │  append-only snapshots, keyed (game_id, action_number, captured_at)
        ▼
  nba_pbp_revisions  ───────────────────────────────────────────── (gold DB)
        │  listPbpAttributionTransitions: diff consecutive snapshots per action
        ▼
  harvestMiscreditLabels (shared)  ── collapse to NET correction, keep rebounds
        │  scripts/harvest-incident-labels.ts
        ▼
  outputs/nba-quant-lab/harvested_incidents.json
        │  GET /v1/research/harvested-labels
        ▼
  /research → "Harvested miscredit labels"  (credited→rightful + latency)
        │  feed as added incidents to the re-ranker eval
        ▼
  far-calibration / attribution-eval  ── recall CI shrinks as labels accrue
```

## Accrual mechanisms (two)

1. **Live (automatic).** The worker's PBP ingest hook (`apps/worker/src/nba-sidecar.ts`
   → `ingestNbaSidecarPlayByPlay` → `recordNbaPlayByPlayRevisions`) appends a snapshot on
   **every** live PBP poll. While the worker runs against live games, the shadow grows
   with no operator action. This is where in-game corrections are caught.

2. **Post-game (scheduled).** NBA corrections also land **minutes to days** after the
   final. Re-snapshot finished games on a cadence to catch late edits:

   ```
   GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
     pnpm tsx scripts/capture-pbp-revisions.ts --games 0042500317,0042500316,...
   ```

   Append-only + idempotent (`INSERT OR IGNORE` on `(game_id, action_number,
   captured_at)`); a new `captured_at` preserves history. **VERIFY the correction
   horizon before hard-coding a cron** — re-run for ~7 days post-game, then drop the
   game. cdn returns 403 for some game ids (not all are served); failures are per-game
   and non-fatal.

## Extracting labels

```
GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
  pnpm tsx scripts/harvest-incident-labels.ts        # all tracked games
  # [--games 0042500312,...] [--stat rebound]
```

Writes `outputs/nba-quant-lab/harvested_incidents.json` (gitignored) in the incident-
registry shape (`{id, gameId, creditedPlayer, rightfulPlayer, stat, utcTime,
correctionLatencySec, ...}`). **0 labels is expected until ≥2 snapshots exist per action
with a real correction between them** — the shadow is append-only and grows over days.
Consecutive flips on one action collapse to the net correction; cancelled flips
(A→B→A) are dropped.

## Feeding the eval (closed-loop)

`pnpm quant far-calibration` **automatically merges** `harvested_incidents.json` into its
matched-recall incidents (`--harvested` overrides the path) — rebound labels are deduped
against the snapshot registry by `(game_id, credited_last, rightful_last)`, registry wins,
and each spec is tagged `source: registry | harvested`. The report's `incident_sources`
block reports `{n_registry, n_harvested_added, n_harvested_duplicate}`. So once the harvest
runs, every new real label flows into recall on the next far-calibration run with no manual
merge — `capture → harvest → eval` is closed-loop. Each new label tightens the recall CI;
the FAR-on-control side is already calibrated and does not need labels.

## Current state (2026-05-31)

Shadow seeded with 13 games (9 playoff incident games + 4 recent conference-finals games
0042500317/0042500316/0042500315/0042500304). All have a single snapshot so far → 0
transitions → 0 labels (honest). Accrual begins when the worker re-polls live games or
the post-game capture re-runs. The `/research` "Harvested miscredit labels" panel shows
the accruing-empty state with games-scanned until the first correction is recovered.
