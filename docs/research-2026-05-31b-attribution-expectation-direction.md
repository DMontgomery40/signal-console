# Research note (II) — toward attribution-expectation-violation detection

**Date:** 2026-05-31  **Worktree:** `signal-console-integration`.
**Premise:** follow-up to `research-2026-05-31-miscredit-model-direction.md`. The board-level
negative result said the signal is not in pooled board features. This note goes to the
**event / player** altitude with real pulled data, and reports what four controlled experiments
actually show. Data sources are all live and were used read-only.

## Data access (confirmed, not assumed)
- **NBA PBP + boxscore:** `cdn.nba.com/static/json/liveData/...` — per-event, per-player
  (`personId`, `playerNameI`, `actionType`/`subType`, `clock`, `period`, `timeActual` wall-clock).
- **Per-player prop microstructure:** the gold DB already holds it — e.g. game `0042500312` has
  **626,541 `quote_ticks`** across 1,587 markets (377 rebound props), source = **Kalshi**, with
  `captured_at`, `implied_probability`, `volume`, `best_bid/ask`. Recent incident games carry
  300k–960k ticks each. `market_instruments.participant_key` + `display_label` map player→prop.
- **Odds-API.io** ($200/mo): key in main-repo `.env`; `/v3/bookmakers/selected` = the documented
  spine; **`/historical/events` + `/historical/odds`** exist for games not in gold.

## Four experiments (all on real data)

**Probe 1 — does historical per-player prop microstructure exist at incident windows?** YES,
abundantly (gold DB Kalshi ticks; Odds-API.io historical for gaps). The precision half is
*instrumentable* on the labeled set.

**Probe 2 — confusability prior as a detector (precision/recall/burden vs the full rebound
denominator).** 955 rebounds across 9 incident games, base rate 1.36%. Correction-invariant
structural signatures: "TEAM-rebound + loose-ball foul ≤6s" = **6.9% precision / 30.8% recall**;
"offensive rebound after a miss" = **2.9% / 61.5%** at ~31 flags/game. **Verdict: the confusability
prior is a candidate *generator*, not a detector** — far too blunt alone (the robust_mad failure
one altitude down). Also: incident PBP provenance is mixed (3 as-played-error / 4 disputed-TEAM /
2 corrected / 2 other) — features touching *credited identity* are poisoned; only
correction-invariant, on-court features are admissible.

**Probe 3 — localized prop microstructure at incident windows (own-baseline + field control).**
Where coverage exists (6 recent-playoff incidents), the implicated player's rebound prop moved
**59–170× its own baseline** and **5–806× the field median**. Looked like a strong precision
signal. (5/13 incidents had no/sparse ticks → data-absence / fail-closed.)

**Probe 4 — the decisive control: incident window vs the same player's *ordinary* rebound
windows.** This kills the naive read of Probe 3. Incident-window price movement is **NOT larger**
than the player's ordinary rebounds — median ratio ≈ **0.6**, incident percentile mostly **<30%**
(often below the median). So the Probe-3 spike was **rebound-generic**: any rebound reprices a
rebound prop ~100×; the miscredit windows are not outliers in raw price magnitude (they are, if
anything, *quieter* — consistent with "the rightful player did not get live credit").

## What this rules out, and the sharpened target
Ruled out by controlled experiment: (i) pooled board features (note I), (ii) confusability prior
alone, (iii) localized **price-magnitude** market signal. The surviving, well-defined hypothesis is
a **cross-modal attribution-expectation violation**:

> Given the PBP event and on-court state, predict the *expected* prop response of each plausible
> recipient. A miscredit is a **violation**: the rightful player's prop under-reacts to a rebound
> the PBP (post-correction) attributes to them, and/or the wrongly-credited player's prop
> over-reacts, and/or a **reversal / cross-source divergence** appears when the live credit is
> contested. The signal is the *mismatch between PBP-implied and market-realized attribution*, not
> the magnitude of either.

This is the user's JEPA-like framing made concrete and testable: model `E[Δprop | PBP event,
on-court, covariates]`, flag the surprise. It also names two untested market dimensions Probe 3/4
did not use: **volume / bet-size** and **cross-source divergence** (Kalshi vs Bet365 disagreeing on
the credit), which are the natural carriers of a contested-attribution signature.

## Honest constraints
- **N = ~6 coverage-complete incidents** is the binding constraint. The single highest-value
  investment is **more labeled incidents** (harvest), not more model cleverness.
- Probe 3/4 used price `|Δp|` only; volume and cross-source divergence are untested.
- Provenance heterogeneity (error/corrected/disputed) must be a first-class feature, not ignored.

## Probe 5 — credited-side reversal + cross-source + volume (the precision gate), provenance-stratified
Ran all three advisor-named dimensions on data in hand, controlled vs the player's ordinary rebounds:
- **Reversal (credited side):** null/uncomputable. The wrongly-credited player is usually a **role
  player** (Champagnie, Merrill, Strus) whose rebound prop barely trades → too few ticks to measure
  a spike-then-reverse. as-played-error (Hartenstein) ratio ≈1.2 (no reversal, as predicted for an
  uncorrected error).
- **Cross-source divergence:** marginal (hart in-window 0.56 vs baseline 0.48); not a separator.
- **Volume (liquid rightful/star side):** mixed — Holmgren shows a clean **10× volume spike (100th
  pctile vs his ordinary rebounds)**, but Wembanyama (×3) and Towns are at/below median.

**Verdict:** at N≈6, **no market observable (price magnitude, reversal, cross-source, volume)
consistently separates miscredits from ordinary rebounds.** Sporadic strong tells exist
(Holmgren volume, Probe-3 magnitudes) but are not consistent and are confounded by (a) tiny N,
(b) **role-player prop illiquidity on the wrongly-credited side**, (c) rebound-generic repricing
on the liquid star side. This is the advisor-pre-authorized "null at this N → labels are the gate."

## Refined conclusion (evidence-grounded answer to the core question)
*What observable market behavior should make an operator believe a play deserves review?* On the
available labeled data, **market behavior alone is not a reliable tell for this incident class.**
The only consistently informative layer is the **play structure + on-court confusability** (which
plausible recipient should have gotten the rebound), which works as a **review-prioritization**
signal — recall 30–61% at ~6–30 candidate rebounds/game — **not** a high-precision alert. The
market layer is at best a weak corroborator, useful where the implicated player's props are liquid
(volume tells like Holmgren), via an **expectation-conditioned residual** (PBP-implied vs realized
prop response), not raw magnitude.

Five controlled experiments on real pulled data ruled out the naive approaches (board features,
confusability-alone, localized magnitude, reversal, cross-source, volume) and localized the binding
constraints: **(1) labels (N)** — the single highest-value investment, harvest running;
**(2) credited-side illiquidity** — structural to role-player miscredits; **(3) raw magnitude is
the wrong statistic** — an expectation residual is required. This is progress: it says precisely
what to build and what not to.

## The fabric to sew in (home for the work)
Build only what the evidence supports; JEPA stays an explicit untrained scaffold.
1. **Loaders (validated-need, reusable):** PBP event-structure + on-court state (from substitutions,
   via cdn.nba.com), player covariates (season rates + current-game minutes/fatigue/pace), and
   per-player prop microstructure aligned to PBP via `timeActual` (gold DB quote_ticks; Odds-API.io
   `/historical/odds` for gaps). These are the substrate for everything below.
2. **Confusability candidate-generator (ships now as prioritization):** ranks each rebound by
   miscredit-risk from correction-invariant on-court/PBP features; operator-facing review queue,
   not an auto-suspend. Honest precision/recall/burden reported (Probe 2).
3. **Expectation-residual harness (the real model target):** `E[Δprop | PBP event, on-court,
   covariates]` per plausible recipient; flag violations (rightful under-reacts / credited
   over-reacts / volume tell), evaluated against incident truth. Gated on more labels.
4. **Harvest pipeline (running):** PBP-verified web stream + (follow-on) programmatic
   PBP-vs-final-boxscore discrepancy mining across the 1,260-game gold corpus, to grow N.
5. **JEPA-like gamestate embedding:** explicit, untrained scaffold/option only — not built.

## Update (2026-05-31, evening) — directed-paired gate + DB attribution shipped
- **Probe 6 (directed signed-paired gate, the core of Approach A):** around each incident, does the
  *rightful* prop drift toward its over while the *credited* prop drifts against? **Mostly ABSTAINS**:
  the wrongly-credited player is usually an illiquid role player (no rebound-prop ticks), so the
  credited leg — the discriminating half — is unobservable at this N. The rightful-star leg, where
  observable, moved in the correct direction (Wembanyama over +0.155 / +0.181 at his corrections),
  consistent-but-not-confirmed. ⇒ the binding gate is **labels + credited-side liquidity**, not model
  cleverness — exactly the control-corpus posture in scratchpad (II)c.
- **Shipped (committed, branch `research/miscredit-attribution-20260531`, not pushed):**
  (a) structured PBP attribution end-to-end — sidecar normalizer → worker → gold DB **migration 15**
  (`person_id`/`player_name`/`sub_type`) → writer → `v_events`; (b) re-ingested the 9 playoff incident
  games via `scripts/backfill-pbp-attribution.ts` (action 416 of 0042500312 now exactly
  `V. Wembanyama / offensive`, not regex-bait); (c) `models.json` emission so the /research Model lab
  shows the real registry.
- **Next (in order):** versioned snapshot-diff **label harvester** (the only label engine; gold PBP keeps
  no revision history); a **per-player prop-tick snapshot feature extension** (Path-B) so the re-ranker
  has its inputs; the **signed-paired re-ranker + conformal abstention** as a Quant Lab plugin **and**
  its /research portal surfaces (API route + ResearchPage section) — front and back.

## Update (2026-05-31, late) — scaffold built; offline re-ranker eval result
Shipped (branch `research/miscredit-attribution-20260531`, not pushed): the **live label harvester**
(migration 16 `nba_pbp_revisions` shadow + worker capture hook + `listPbpAttributionTransitions` to
recover credited→rightful corrections by diffing snapshots), the **re-ranker core**
(`research/attribution.py`, directed signed-paired score + fail-closed abstention, 7 pure tests), and an
**offline gold-backed eval** (`research/attribution_eval.py`, 4 hermetic tests).

**Eval on the 15 registry incidents (gold prop ticks): 33% abstention, 10 scored.** Stratified result —
the directed signature holds for **player→player swaps** (`champagnie→wembanyama` +0.240 / +0.220,
`hartenstein_wallace` +0.095) but is *negative* for **TEAM-rebound disputes** (`holmgren_team` −0.150,
`towns_team` −0.187, `wembanyama_team` −0.125): the speculative "rightful" never got credited, so their
prop falls and the hypothesis correctly does not fire. Credited leg illiquid in 6/10 scored (rightful_only).
N≈2 clean positives, no control ⇒ **encouraging-but-not-validated**; the binding gate remains
**labels + credited-side liquidity**, not model machinery. Implication: stratify candidates (player-swap
vs TEAM-dispute) and treat the TEAM-dispute class as a different (likely market-invisible) problem.
