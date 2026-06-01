# FAR-on-control + matched recall — first falsification result for the re-ranker

Date: 2026-05-31. Closes the falsification loop opened in
[research-2026-05-31c-literature-scratchpad.md](research-2026-05-31c-literature-scratchpad.md)
(Approach A, the anchored signed-paired re-ranker) and
[research-2026-05-31b-attribution-expectation-direction.md](research-2026-05-31b-attribution-expectation-direction.md).
Posture per note C: calibrate the **false-alarm side on the control corpus**; use the
~15 positives only for recall with openly-wide CIs. This note records the first run that
actually does both, through one shared pipeline.

## What was built (the substrate)

The re-ranker scores a `(credited, rightful)` pair, but at inference there is no oracle
`rightful`. The missing layer was the **confusability prior** that proposes candidates:

1. **On-court reconstruction** (`research/oncourt.py`) — infers starters (no boxscore) and
   replays PBP substitutions to know the 5-man unit at every action. Correction-invariant:
   subs/ordering are never re-scored by a stat correction, only the _name on the rebound_ is.
   Verified at scale: **0/163 control games** with starters≠5/team; on-court==5 at **98.85%**
   of 14,345 rebounds (the 1.15% residual is dead-ball substitution bursts, never a live
   rebound).
2. **Candidate generator** (`research/candidates.py`) — every player-credited rebound emits
   `(credited, on-court-teammate)` pairs (~4/rebound, ~300/game) with a causal
   `rebounds_so_far` confusability rank. Teammates only (a misattribution keeps the right
   team's box score).
3. **FAR calibration** (`research/far_calibration.py`, CLI `far-calibration`) — scores every
   candidate pair through the SAME path incidents use, on assumed-negative (non-incident)
   games, and also pushes the known incidents through that identical path for a matched
   TPR-at-FAR.

Data: a dedicated **`far-control` snapshot** (`--control-ticks 200`) — 314 games, **5.6M**
rebound prop-tick rows, **163 non-incident control games** with ticks (38 of them episode-free
"pure control"). Control-game PBP attribution (`person_id`/`sub_type`) was backfilled into the
gold DB from cdn for all 163 games (0 failures) — previously only the 9 playoff incident games
had it.

## Result 1 — FAR on control (the clean standalone result)

163 control games, 14,345 rebounds, `aggregate_drift` legs. **The score is not zero-centred
under the null — 85.6% of control pairs score >0 — so a fire threshold MUST be calibrated on
this empirical control distribution, not against 0.** That requirement vindicates the
control-corpus-calibration design (note C) and is the headline use of this table.

**Caveat on the skew (advisor):** a clean null would be ~symmetric around 0; 85.6%>0 almost
certainly reflects a mechanical confound — the credited player _just recorded a rebound_, which
moves their own prop regardless of any miscredit, and the score is `rightful_drift −
credited_drift`. The empirical FAR calibration absorbs this correctly (the threshold is read off
the skewed control distribution), so the conclusions hold — but the raw score is NOT a clean
"miscredit signature" and cross-player magnitude comparisons of it are meaningless.

| threshold | per-PAIR FAR (all) | per-PAIR FAR (pure) | per-REBOUND FAR (all) | per-REBOUND FAR (pure) |
| --------- | ------------------ | ------------------- | --------------------- | ---------------------- |
| 0.01      | 7.6%               | 6.8%                | 14.1%                 | 12.2%                  |
| 0.02      | 5.7%               | 5.0%                | 11.1%                 | 9.3%                   |
| 0.05      | 3.6%               | 3.2%                | 7.4%                  | 6.5%                   |
| 0.10      | 2.6%               | 2.4%                | 5.1%                  | 4.8%                   |
| 0.20      | 1.6%               | 1.5%                | 3.1%                  | 3.1%                   |

Abstention ~25% on control (illiquid players), notably lower than the ~40% on incidents — the
hard, abstaining cases are exactly the illiquid-rightful incidents. **Per-rebound FAR (max over
~4 candidates) is roughly DOUBLE the per-pair FAR** at every threshold — the multiple-testing
cost of not knowing which teammate is the rightful one.

## Result 2 — matched recall (label-starved; the honest part)

Each player_swap incident pushed through the identical `rebound_candidates → max-over-candidates`
path on the same snapshot (300s match window between the registry event time and the credited
rebound):

- **player_swap (2-legged, the headline path):** 10 scoreable → **5 matched** (a credited rebound
  within 300s) → 5 rightful-on-court → **3 scored** (others abstain, illiquid rightful or no
  snapshot ticks). Rose from 3/2 after ingesting the 2 absent regular-season incident games
  (gap #2).
- **TEAM-credited (gap #3, one-legged coverage):** +5 incidents, all now matchable, 3 scored —
  but **all negative, none fire** (one-legged = the rightful's own drift, not the paired
  signature). They grow the denominator without firing.
- `tpr_per_pair` at 0.02 = **0.167 (1 of 6 scored, incl. TEAM)**; over the player_swap-only
  denominator it is 0.333 (1 of 3). 0 at ≥0.05. **N tiny → CI ≈ [0,1] either way.**
- `rank_by_prior` = [2, 4, 1]; `rank_by_score` = [1, 2] (the liquid player_swap pairs; the prior
  is still not load-bearing).

Two conclusions the run forces (both contradict prior assumptions, so they are recorded):

1. **The `rebounds_so_far` prior is NOT load-bearing.** It does not preferentially rank the
   rightful — in the one clean firing case (`hartenstein→wallace`, score-argmax rank 1) the
   rightful was rank **4** by prior. Pruning candidates to top-1-by-prior would _discard_ the
   only clean hit. Any future prune must rank by something else (role/position/contest
   proximity), not raw rebound count.
2. **The directed SCORE itself ranks the rightful better than the prior** (#1 in one case, #2 in
   the other) — encouraging that the re-ranker points at the right player when there is
   liquidity, but **N forbids any quantitative claim**.

## What this means for the architecture

- The directed-paired re-ranker is **not a standalone alarm**: at the threshold where the one
  firing incident clears (0.02), per-rebound FAR is ~9–11% → ~7 false alarms/game across ~74
  rebounds. It only makes sense as a **precision-lift on a pre-gated stream** (board detector
  fired AND the rebound is confusability-flagged), which is the note-C thesis — now quantified.
- **Recall is label-bound, not method-bound.** Only 5 of 10 player_swap incidents are even
  matchable and 3 scoreable here; the binding constraint is positives + credited-side liquidity,
  exactly the gate identified in the negative-result memo. The versioned PBP-revision harvester
  (`scripts/capture-pbp-revisions.ts` → `listPbpAttributionTransitions` →
  `scripts/harvest-incident-labels.ts`) is the path to more labels over real days, and
  far-calibration now **auto-merges** `harvested_incidents.json` into matched-recall (deduped vs
  the registry, `incident_sources` reports the split) — so accrued labels tighten the recall CI
  with no manual step. See `docs/nba-miscredit-label-harvester.md`.

## Concrete pipeline gaps found (future work, all real)

1. **FIXED — `last_name` mis-parsed descriptive credited strings.** The registry's
   `credited_player` is sometimes a phrase ("J. Champagnie live rebound display", "K. Towns
   (suspected; foul/rebound dispute)") so `last_name` returned the trailing word
   ("display"/"dispute"), silently under-counting the eval denominator. `last_name` now prefers a
   leading "I. Lastname" token (commit "Fix last_name harness bug"), so towns/hart/champagnie
   resolve correctly and the denominator is honest. Remaining gap: carrying a `person_id` on
   incidents would remove name-matching fragility entirely.
2. **FIXED — 2 regular-season incident games (`0022500986` Hauser→Tatum, `0022500788`
   Barnes→Castle) lacked a `games` row** → no PBP (FK target), so they were silently dropped.
   `scripts/ingest-incident-games.ts` now creates the games row from the cdn boxscore and
   backfills PBP; both are recovered (matched-recall 3→5 matched, 2→3 scored).
3. **FIXED (coverage only) — TEAM-credited incidents** (`TEAM (offensive)` etc.). Added
   `team_rebound_candidates` + a TEAM branch in `incident_recall_matched`: a TEAM rebound is
   matched to the on-court players of the rebounding team and scored ONE-LEGGED (credited=TEAM
   has no prop → abstains → just the rightful's own drift). All 5 TEAM-credited registry
   incidents are now matchable (n_incidents 10→15, matched 5→10). But the one-legged scores are
   noise — 3 scored, all NEGATIVE, none fire — so the denominator grows and TPR@0.02 drops
   0.333→0.167 with the same single firing incident. **Confirms it does NOT move the headline**;
   the paired signature is the whole point, and TEAM-credited cases cannot provide it.

## Reproduce

```
GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
  pnpm tsx scripts/export-quant-snapshot.ts --sample 300 --control-ticks 200 \
  --snapshot-id far-control --seed 42
uv run python -m nba_sidecar.research far-calibration \
  outputs/nba-quant-lab/snapshots/far-control \
  --out outputs/nba-quant-lab/far_calibration.json
```

Result artifact: `outputs/nba-quant-lab/far_calibration.json` (gitignored). FAR/recall code is
hermetically tested in `apps/nba-sidecar/tests/test_far_calibration.py`.
