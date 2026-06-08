# Literature scratchpad — live NBA stat-misattribution detection

Date: 2026-05-31. Source: a 5-thread deep literature dive (real, fetched, cited) + our own
controlled experiments (notes I & II). Posture: this is **not** detection-from-scratch — the
PBP/on-court confusability prior is already a working **high-recall / low-precision candidate
generator** (30–61% recall, 3–7% precision). Pooled board-volatility, raw localized prop
magnitude, reversal, cross-source, volume are **null/mixed**. The open problem is **precision-lift
/ re-ranking on the existing candidate stream, with honest abstention on illiquid cases**, under
**~15 positives**.

## Statistical posture (resolves "N=15 is hopeless")

~15 positives, but **5,537 market-outlier episodes across 1,294 PBP-window games** as a control
corpus. **Calibrate the false-alarm side (threshold / ARL-to-FAR) on the control corpus; use the
15 positives only to estimate recall with openly-wide CIs.** Never quote an aggregate precision
number off N=15.

## Model directions (each a RE-RANKER on the prior's candidate stream, not a scanner)

**A — Anchored Signed-Paired Microstructure Re-Ranker (build first).** Prior emits
`(t, credited_player, rightful_player, stat, arena)`. Directed two-leg test, each leg z-scored vs
that player's OWN pre-event baseline: credited leg should move _against_ the credited over (market
disbelieves), rightful leg _toward_ the rightful over. Estimator: signed BVC order imbalance
`OI=(V_buy−V_sell)/V` on `quote_ticks` + implied-prob drift; decision: **anchored windowed-SPRT**
(Wald α/β, thresholds γ₁≈P_D/P_FA, γ₀≈(1−P_D)/(1−P_FA)) — per-event because the prior hands us
timestamp+player, NOT open-ended scanning. The **joint (credited↓ AND rightful↑)** coherence is the
discriminator; generic board-wide confirmation stays dead. h≈5 min.

**B — Per-feed bias-calibrated residual.** Reframe Van Bommel–Bornn per-scorekeeper _generosity_
(β*G) / \_home-bias* (β_B) as a **per-FEED/arena bias model**; subtract the arena/home offset → a
genuine one-off wrong-player credit still leaves a large post-calibration residual while chronic
arena generosity is calibrated away (removes systematic false positives). Lean on **arena
generosity over a raw home flag** (generosity is the better-estimated coefficient).

**C — Anchored drift test on the implied-prob residual.** `D_t = PBP-implied fair value − market
implied prob`; post-miscredit D*t shifts. Angelini et al. post-news WLS drift test
`e*{t+h}=g0+g1 t+g2 t²+b·p_τ+u`, weight p(1−p). A correct high-impact credit is "expected news"
(updates without drift); a wrong credit is a "surprise" that misprices and persists ~5 min.
Probability-space → tolerant of thin liquidity.

**D — Fail-closed abstention gate (wraps A–C).** Mondrian/group-conditional per-(player ×
market-family) calibration; Conformal-Risk-Control `+B/(n+1)` forces the threshold conservative as
a group's count shrinks → **ABSTAIN** on thin groups. Honesty: with 15 positives on autocorrelated,
non-exchangeable prop series we CANNOT claim distribution-free P(FA)≤α live — use conformal as the
abstention _structure_, cite ACI / time-series conformal for any streaming guarantee.

### Build first: A + D — why

Targets the measured failure (precision, not recall); reuses the trusted prior for recall;
degrades to ABSTAIN exactly where data is thin. Role-player illiquidity: credit flows
rightful→credited and the credited player is often the illiquid one, so the **credited leg is
frequently thin → lean on the rightful leg + correlated markets** (combos, team-rebound totals,
the rightful's other props); ABSTAIN only when BOTH legs are unobservable. **Scoring rule: no ticks
in the window = ABSTAIN = not a miss.** Volume clock floored AND capped per player. SPRT thresholds

- abstention quantile calibrated on the 5,537-episode control corpus.

## Labels — the pivotal data finding

**There is NO official NBA stat-corrections feed.** Corrections are _silent edits_ to the official
line; **the silent edit IS the label, its timestamp IS the correction latency.** Our gold DB
**cannot recover historical labels**: `nba_play_by_play_actions` is `UNIQUE(game_id, action_number)`
written `INSERT OR IGNORE` (`migrations.ts:641`, `scripts/backfill-pbp.py`), so a corrected re-fetch
for the same action is silently dropped, not versioned. Therefore:

1. **Stand up a snapshot-diff harvester (going-forward).** Re-snapshot CDN liveData
   (`cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{game_id}.json`) on a schedule for
   ~7 days post-game (VERIFY the horizon); persist EVERY revision keyed `(game_id, action_number,
captured_at)` in a versioned shadow table; diff `personId`/`description` across `captured_at` →
   any attribution moving off one player onto another (or a count decremented) = a ground-truth
   miscredit-correction label with latency = Δcaptured_at.
2. nba_api PlayByPlayV2 / BoxScoreTraditionalV2 re-snapshotting (richer `PLAYER1/2/3_ID`).
3. CDN liveData in-flight revisions as the lowest-latency signal.

## Two cheap Step-0 fixes that unblock everything

1. **Restore `personId/playerName/subType/qualifiers`** in `apps/nba-sidecar/.../normalizers.py`
   (stripped ~:387-394) and surface through `packages/db/src/sport-views.ts:v_events` (+ a column
   on `nba_play_by_play_actions`) → exact credited↔rightful pairing instead of regex on free text.
2. **Versioned PBP shadow table** keyed `(game_id, action_number, captured_at)` (drop the
   `INSERT OR IGNORE` immutability for the shadow) so the snapshot-diff label harvester accumulates
   ground truth immediately.

## Falsification (per-mechanism; N forbids aggregate precision claims)

- A: falsified if, on the liquid-enough incident subset, credited/rightful props do NOT diverge in
  the predicted directions beyond own-baseline noise; as a re-ranker, falsified if Stage-2
  divergence is conditionally independent of the label given the prior (no precision lift at equal
  recall). D: falsified if abstention doesn't concentrate illiquid cases. FAR: falsified if the
  control-calibrated threshold over-fires on known-clean control windows. B: falsified if the
  arena offset doesn't shrink the FP set. C: falsified if it fires equally on correct high-impact
  credits and true miscredits. Harvester: falsified if 7-day diffing surfaces no credited→rightful
  transitions for reporting-confirmed corrections.

## Reading list (load-bearing first)

1. Van Bommel & Bornn, scorekeeper bias — https://arxiv.org/abs/1602.08754 · journal PDF
   https://www.matthewvanbommel.com/files/adjusting_for_scorekeeper_bias_in_nba_box_scores.pdf
2. Bayesian two-stage rebounding (PBP-native, no tracking) — https://pmc.ncbi.nlm.nih.gov/articles/PMC12671482/
3. VPIN/BVC — https://www.stern.nyu.edu/sites/default/files/assets/documents/con_035928.pdf ·
   BVC info detection https://ideas.repec.org/a/eee/jbfina/v103y2019icp113-129.html
4. Angelini et al., in-play prediction-market drift — https://centaur.reading.ac.uk/98329/
5. Xie–Zou–Xie–Veeravalli, Quickest Change Detection survey — https://arxiv.org/abs/2104.04186
6. Conformal Risk Control — https://arxiv.org/html/2208.02814v4 · Mondrian/Kandinsky —
   https://arxiv.org/html/2502.17264v1
7. Wald SPRT — https://nowak.ece.wisc.edu/ece830/ece830_fall11_lecture9.pdf
   Supporting: nba_api https://github.com/swar/nba_api · Westbrook rescinded rebound (label semantics)
   https://www.thescore.com/nba/news/729134 · Establish The Run per-arena differentials
   https://establishtherun.com/dinkmeyer-leverage-scorekeeper-bias/ · Croxson & Reade
   https://onlinelibrary.wiley.com/doi/abs/10.1111/ecoj.12033
   Phase-2 backstops (silent/never-corrected): NEWMA https://arxiv.org/abs/1805.08061 · BOCD
   https://arxiv.org/abs/0710.3742 · covariate-shift conformal https://arxiv.org/abs/1904.06019

## Honesty flags

- Van Bommel–Bornn models assists/blocks, NOT rebounds — framework ported by analogy; the rebound
  prior must be re-estimated and validated independently.
- "0/15" (note I) vs the bakeoff's "2/15 state-space live defaults" are DIFFERENT configs/versions —
  do not conflate.
- No distribution-free conformal α guarantee live on autocorrelated prop series — conformal is
  abstention structure only; ACI/time-series conformal is the honest streaming path.
- The 7-day correction-window horizon is from general reporting, not a fetched NBA policy — verify
  before hard-coding.
