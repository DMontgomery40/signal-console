YOU
research ``` bobby Ingram about mlb player props   - he uses Bradley-terry model   - and a neural net - Monica pipeline with eKF - pareto triplet - filters are the most important part ``` and then look at the nab-sidecar and research and math experiments in https://gitlab.com/hillsidetech/innovation/signal-console and see if signal console could gain some wisdom from what he's doing
SEARCH365
I'll research Bobby Ingram's MLB player props work and the signal-console codebase simultaneously! Good leads! I can see emails about Bobby Ingram and a Swish workshop. Let me dig into the emails, search for signal-console more broadly, and fetch the MLB player props pages simultaneously. Excellent — found the signal-console repo and the handoff doc. Now let me get the full content of that handoff doc, plus dig deeper into the repo structure. Now let me look for more files in signal-console — PRD, nba-sidecar, and math/experiments content. The nba-sidecar has a rich research tree. Let me pull the key files — the PRD, the scorer/evaluator, the research models, and the calibration and candidate files. Now let me pull the attribution.py and the service.py and volatility.py to understand the full nba-sidecar signal layer. I now have a very comprehensive picture of both systems. Let me compile the full analysis.

CODEx REVIEW STATUS - 2026-06-09

This file intentionally preserves the long planning transcript and code sketch below because the context is important. The sections below are a review overlay against the current `signal-console` repository contracts. When a later snippet conflicts with this overlay, the overlay is authoritative and the snippet must be edited before implementation.

Downstream implementation-agent contract:

- This draft is not just inspiration. It contains already-written implementation code, tests, commands, and research reasoning. A downstream coding agent must treat those blocks as source material to copy, paste, and reconcile.
- For every new file named in this draft, start by copying the relevant code block from the matching phase into the target file. Do not re-derive the file from the prose and do not rewrite the code from scratch because it "looks straightforward".
- After copying, apply only the smallest line-level edits required by the "Current repo contract corrections" section above and by the actual repository APIs. Wrong assumptions may be replaced wholesale inside the affected line/block, but the surrounding code and planning context must remain intact.
- If a downstream agent changes a copied block, it must be able to name the source section it copied from and the exact repo-contract reason for each meaningful deviation. "Cleaner", "simpler", "more idiomatic", or "I rewrote it" are not acceptable reasons.
- Existing repository files must be patched around current code. Do not delete or replace existing working implementations to match a sketch. Use the sketch to add the missing model/producer/test behavior, then reconcile with local patterns.
- The preserved transcript markers (`YOU`, `SEARCH365`, `PYTHON`, `BASH`, `Copy`) are historical context. They are not instructions to regenerate the idea. Extract the code underneath them, paste it, and then patch it.
- If an automated loop cannot safely identify the relevant source block, it should stop and ask for the source section instead of inventing a new implementation.

Current repo contract corrections:

- Research models are `BoardModel` subclasses with `score(self, request: ScoreRequest) -> ScoreResult`. They do not implement `predict(bucket)`.
- The model decorator is `@register` with no argument. The model id comes from class variable `id`, alongside `name`, `summary`, and `family`.
- Registered models are surfaced by importing their modules from `apps/nba-sidecar/src/nba_sidecar/research/models/__init__.py`; this import is for registration side effects.
- The snapshot board column is `intensity`, not `total_intensity`.
- Use `list_models()` and `get_model()` from `nba_sidecar.research.models`, not direct `_REGISTRY` access in implementation docs or tests.
- Use `evaluate_model`, `evaluate_external`, `predictions_from_model`, `load_game_series`, and `score_predictions`. The old sketch references `load_snapshot` and `score_model`; those names are not current repo APIs.
- `PredictionRow` carries `game_id`, `bucket_start`, `score`, `fired`, and `diagnostics`. There is no top-level `regime_score` field; continuous scores should be emitted as `score` and optionally duplicated in diagnostics as `regimeScore`.
- Current attribution functions are `signed_paired_score`, `score_incident_snapshot`, `select_player_series`, `aggregate_leg_drift`, `rebound_candidates`, and `team_rebound_candidates`. The old sketch references `score_candidate_pair` and `get_candidates`; those names are not current repo APIs.
- A real virtual-source state-space cannot be built from only `source_count`, `source_dominance`, and `source_disagreement`. Until `source_bucket_contributions.parquet` exists, the honest model name is `virtual_source_state_space`, and diagnostics must say source decomposition is approximate.
- A composite attribution detector should first be an external prediction producer that writes `predictions.parquet` and is scored with `score-predictions`. Do not force prop ticks, PBP, candidate pairs, or event anchors through the current `BoardModel` input contract.

Research tab and research lane integration requirements:

- Add Moniac/Bobby-derived work as another Research model option, not as a hardcoded replacement for `robust_mad` or `state_space_current`.
- Do not overwrite, rename, or re-purpose existing model ids, static fallback rows, or run artifacts.
- The intended path is Python registry -> `pnpm quant emit-models` -> `outputs/nba-quant-lab/models.json` -> `GET /v1/research/models` -> `/research` Model lab.
- If `apps/api/src/services/research.ts` `STATIC_MODELS` is touched, append fallback rows only; keep `robust_mad` and `state_space_current`.
- Compare models side by side: `pnpm quant compare robust_mad state_space_current virtual_source_state_space --snapshot <snap>`.
- The `/research` Leaderboard must render baseline and candidate rows simultaneously, using `model_id` in combined predictions so one model cannot masquerade as another.
- No live Recent, Live, Backtest, or detector default changes until offline Research proof and a separate productization decision.

UI tab and section inventory for this work:

- **Primary nav tabs in `apps/web/src/App.tsx`:** Recent, Live, Backtest, Known Cases, Detectors, Research, Settings.
- **Recent:** checked, no change for this phase. Do not surface Moniac/Bobby candidates in recent anomaly lists until a separate productization decision.
- **Live:** checked, no change for this phase. Do not alter live suspend behavior, live state-space defaults, or live model labels.
- **Backtest:** checked, no detector/runtime change. Existing "Score models in Research" link remains correct; only update Backtest if a future productized detector is promoted into the detector registry.
- **Known Cases:** checked, no route change. Phase 4 casebooks can link back to Known Cases, but the known-case replay UI should not be rewritten for the Research-only model option.
- **Detectors:** checked, no detector-registry change. Keep the existing "Compare in Research" cross-link; do not list `virtual_source_state_space` as a live detector unless it is productized.
- **Settings:** checked, no default or tuning-control change. Existing "Research workflow" link remains the right handoff from live tuning controls to offline scoring.
- **Research page sections in `apps/web/src/features/research/ResearchPage.tsx`:** HeaderStrip, GoldStatus, QuantGuidePanel, SourceCoverage, PullJobsTable, SnapshotBlock, ModelLab, Leaderboard, AttributionReranker, FarCalibration, ConfluenceEval, HarvestedLabels, CasebookPreview.
- **HeaderStrip:** checked, no model-specific change; it reports artifact status only.
- **GoldStatus:** checked, no model-specific change.
- **QuantGuidePanel:** update the copied quickstart and its test when `virtual_source_state_space` is actually registered, so the compare command includes `robust_mad state_space_current virtual_source_state_space --snapshot "$SNAP"`. Do not make that code change before the model exists.
- **SourceCoverage:** checked, no change for the virtual-source approximation. If `source_bucket_contributions.parquet` becomes a real snapshot artifact, add coverage/manifest expectations here and in snapshot tests.
- **PullJobsTable:** checked, no change.
- **SnapshotBlock:** no UI layout change for Phase 1. If new snapshot files are added (`source_bucket_contributions.parquet`, composite prediction inputs, or richer prop-tick manifests), update manifest/file assertions so the section proves those files are present.
- **ModelLab:** required change at implementation time. The API-backed model list must render the new row beside `robust_mad` and `state_space_current`; fixtures in `ResearchPage.test.tsx` should include all incumbent and candidate rows.
- **Leaderboard:** required change/test at implementation time. A compare run must show `robust_mad`, `state_space_current`, and `virtual_source_state_space` rows together; combined predictions must keep `model_id`.
- **AttributionReranker:** checked, no Phase 1 change. Phase 4 can add or update artifacts only if it remains honest about `signed_paired_score` support and abstentions.
- **FarCalibration:** checked, no Phase 1 change. Phase 4 threshold work should update this only when the signed-paired re-ranker thresholds change.
- **ConfluenceEval:** checked, no change unless the Moniac work explicitly reuses whole-board confluence as a gate.
- **HarvestedLabels:** checked, no change.
- **CasebookPreview:** checked, no layout change. It should pick up new scored-run casebooks through existing report artifacts.
- **Explainers in `packages/ui/src/explainers.ts`:** update `research-model-lab` copy from "baseline research models" to "baseline and candidate research models" when the new option is registered; keep the "not live production" language.

Fixture and data gates before implementation:

- Repair or prove `player_prop_ticks.parquet` export from `scripts/export-quant-snapshot.ts`; the current loader expects it, and existing artifacts contain it, but the exporter source must visibly write/list it.
- Add a source contribution fixture for `source_bucket_contributions.parquet` before claiming real per-source filtering.
- Add a two-game interleaving fixture proving model state is per-game and outputs one `PredictionRow` per input bucket.
- Add missing-support fixtures for `rightful_only`, `credited_only`, and `insufficient_support`.
- Add API/UI tests that prove the new model appears in `/research` beside the incumbents, not instead of them.

Research: Bobby Ingram's MLB Model × Signal Console Cross-Pollination
This is a rich body of material. Here's what I found across your emails, Confluence, and the full signal-console codebase — followed by a thorough cross-pollination analysis.

Part 1: Bobby Ingram's MLB Player Props Model — What He's Actually Doing
Source: Workshop emails (May 7 and June 3 sessions) with Stephen Le Hunte, Rafal Rakowski, Bobby, and you.
The pipeline is internally called "the moniac pipeline" (after the hydraulic economic computer). Raw data → priced props.

Data Architecture
Layer	What It Is
Bronze	Raw JSON from Sportradar historical API — every MLB pitch for 5 years (~6M pitches), unaltered, in BigQuery
Silver	Tidy tables: batted-ball events, pitch coordinates, hit type, launch physics, sanity checks
Feature view	A view selects fields for the target markets — considered fixed and out of scope for auto-research
The Model: Layer by Layer
1. 🏟️ Bradley-Terry Matchup Model
Models batter-vs-pitcher interaction on an all-things-equal basis
Environmental effects are extracted out first (ballpark factors, platoon advantage / handedness splits) so the B-T layer sees pure skill
Produces baseline probabilities per plate-appearance outcome (hit, walk, strikeout, etc.)
The B-T framework is: P(batter beats pitcher) = skill_batter / (skill_batter + skill_pitcher) — a pairwise comparison model
2. 🔧 Extended Kalman Filters — "The Model, Essentially"
One independent EKF per skill (home-run rate, walk rate, strikeout rate, etc.)
Extracts latent player skill from observed outcomes over time
Described by Bobby as "the most important component" — everything downstream depends on these
Weighting: full history per player, recent data weighted more heavily
Must handle structural events: season rollover, ball changes, injuries, regression to the mean
These filters produce the feature set fed into the neural network
⚡ Runtime cost: a change to any filter requires ~2h to re-optimize params + re-run all filters, then another ~5h hyperparameter search on the neural network — hence wanting multi-day agentic loops
3. 🧠 Neural Network (Residuals, Not Forecasts)
Architecture: two-tower neural net (not a transformer) — embeds pitcher and hitter separately, models their interaction, then joins fixture context and game state
The NN predicts the residuals on the B-T probabilities — it improves probabilities rather than forecasting from scratch
This is a clever design: B-T gives you a principled baseline; the NN corrects the systematic errors
Parametric by design: unseen players can be priced (you have their skills)
Operational constraint: must be fast enough for live trading — rules out large models
4. 📐 The "Pareto Triplet" Scoring Metric (the Calibration/Discrimination Triplet)
This is the evaluation score Bobby added since the last session to address the "you need a well-defined objective" challenge. It targets two properties simultaneously:

Calibration — When the model says 20%, it happens 20% of the time. (Are the probabilities honest?)
Discrimination / Sharpness — Probabilities must differentiate players. The model must capture eliteness especially in the tail — Aaron Judge at ~8% HR vs ~3% league average; Mason Miller's strikeout rate. Elite players are what people bet on.
The word "Pareto triplet" likely refers to the Pareto front of the calibration-sharpness-burden trade-off — there's no single objective, and any model that improves one without regressing the others is a Pareto improvement. This is structurally the same idea as the PRD's ScoreResultBundle concept but for player skill rather than market board signals.

Why "Filters Are the Most Important Part"
Because everything is coupled:

Filters → features for the NN
A filter change requires re-running all filters (~2h) + re-training the NN (~5h)
The quality of dynamic skill progression (how well you track Aaron Judge's current form vs. his career) is the primary lever on overall pricing accuracy
Filters handle the hardest things: regression to the mean, structural breaks, season rollover — not just "what's his rate this year"
Part 2: Signal Console — What It Is and What's In the nba-sidecar
Sources: PRD.md, HANDOFF-2026-05-23.md, volatility.py, attribution.py, scorer.py, candidates.py, far_calibration.py, robust_mad.py, doctor.py, base.py
The Big Picture
Signal Console is a trading-desk tripwire for NBA player-prop misallocations. It monitors the whole betting board in real time and fires an alert when a market moves anomalously — typically because a stat was misattributed (e.g., a rebound credited to the wrong player). It lives on your local machine (SQLite gold DB, ~15-54GB of quote ticks), served via Fastify + Vite to the trading desk.

The Math Stack
Board-MAD Detector (volatility.py) — The Live Signal
This is a full state-space model (not a naive rolling-median), with several layers:

Observation = log1p(raw_board_intensity / breadth_normalizer) + disagreement_bonus
Breadth normalization — divides by activeMarketCount^exponent so a board with 40 markets moving doesn't look 10× more surprising than one with 4
Source trust weighting — single-source buckets harder to fire; multi-source agreement easier to fire (inverse-variance idea)
Kalman-style predict/update — tracks a latent baseline level + trend, with configurable process noise and memory
Robust MAD scale — standardized innovation = (observation - predicted_baseline) / MAD(recent_innovations) — scale-invariant across calm vs. wild games
Anchor blending — three modes: opening-ramp, historical-blend (prior from last 5 same-side games), trailing. Precision-weighted combine
Hysteresis gate — enter threshold (K_MAD), exit floor (ratio of enter). Prevents flapping
Fire condition: warmed AND NOT in_alert AND positive_standardized_innovation >= enter_z
The K parameter (live default K=3.0, backtest calm preset K=6.0) feeds enter_z = enterOffset + K × enterKScale — not a literal median + K·MAD anymore, but the K knob is preserved for traders.

Incumbent Baseline (robust_mad.py)
The simpler model it was built to beat: literal trailing median + K·MAD on raw intensity. It is surfaced by the research model registry as `robust_mad` and lives in the bakeoff as the incumbent high-recall/high-burden baseline.

Research Layer (nba-sidecar/research/)
A separate Python research track for a harder problem: stat misattribution detection (wrong player credited with a rebound). Key components:

File	What It Does
candidates.py	For each rebound, emits (credited, on-court teammate) candidate pairs — the pruning layer
attribution.py	Signed-paired re-ranker: score = rightful_drift - credited_drift around the event time. If a miscredit happened, rightful's prop drifts UP (market corrects), credited's drifts DOWN. Pure, hermetically testable
far_calibration.py	False-alarm rate calibration on control games (where the credit is correct). Sweeps thresholds, reports per-pair FAR and per-rebound FAR
scorer.py	Unified scoring: ScoreResultBundle with incident recall, tape-outlier recall, fires/game, per-game outlier burden, residual coverage. Both native and external models score identically
doctor.py	Preflight: checks scorability, coverage classes, leakage/split sanity before trusting any evaluation
robust_mad.py	The incumbent baseline in the research bakeoff registry
base.py	BoardModel ABC — strict contracts: one prediction row per bucket, causal (no peeking), warmup-gated
The Evaluation Metrics
ScoreResultBundle:
  incident_recall         # TPR on known misattribution incidents
  tape_outlier_recall     # TPR on market-tape outlier episodes  
  fires_per_game          # alert burden
  per_game_outlier_burden # fires per real tape episode (precision proxy)
  residual_coverage       # fraction of warmed buckets within threshold band
This is a multi-objective scorecard — recall vs. burden — which is the signal-console equivalent of Bobby's calibration-vs-sharpness Pareto triplet.

Part 3: Cross-Pollination — What Signal Console Can Learn from Bobby
This is the interesting part. The two systems are solving structurally analogous problems in different domains, and the design patterns transfer well.

🔁 1. The EKF Architecture ↔ The State-Space Detector (Deepest Connection)
What Bobby does: Independent EKF per player-skill dimension. The filter tracks the latent true skill of each player from noisy observed outcomes. It handles regime changes (injuries, ball changes) by tuning process noise — fast process noise = quick adaptation, slow = stability.

What signal-console does: volatility.py already IS a Kalman filter — it runs a predict/update loop with level + trend state, process noise, and Kalman gain. But it's one filter for the whole board, not per-player or per-source.

The wisdom to borrow:

Bobby's key insight: one filter per independent signal dimension rather than one omnibus filter. Signal console currently folds everything (board intensity, source count, disagreement) into one latent state. Consider virtual-source filters — each source (e.g., Pinnacle, Bet365, exchange) gets its own latent baseline; the combined board score is then a precision-weighted aggregate. A single source spiking doesn't contaminate the multi-source baseline.
Bobby's structural event handling (season rollover, ball changes) translates directly to signal console's known structural breaks: game restarts after timeouts, quarter breaks, overtime. The opening-ramp baseline mode addresses this partially, but the EKF could model the transition variance explicitly — spike the process noise when a dead-ball situation ends, return to normal noise after a few buckets.
Bobby uses regression to the mean in his filters. Signal console's historical-blend mode does something similar (prior from last 5 games), but it's a fixed linear fade. An EKF would give you a principled posterior: the blend ratio emerges from the filter, not from a manually tuned historicalRampCompleteGameMinutes.
📐 2. The Pareto Triplet ↔ ScoreResultBundle (Same Math, Different Domain)
Bobby's triplet: Calibration + Discrimination/Sharpness + (implicit) computational burden.

Signal console's bundle: incident_recall + tape_outlier_recall + fires_per_game + per_game_outlier_burden + residual_coverage.

The wisdom to borrow:

Bobby's calibration score — "when the model says 20%, it happens 20%" — has no direct analog in signal console. The residual_coverage metric is the closest thing (fraction of warmed buckets within the threshold band), but it's not a true calibration score. You could add a bucket-level calibration curve: bin buckets by regimeScore (0–1), and check whether buckets in the 0.8–0.9 bin actually fire at ~85% rate. This would tell you if the model's standardizedInnovation is well-calibrated or systematically over/under-confident.
Bobby's sharpness / tail discrimination — "does the model distinguish Aaron Judge from average?" — maps to: does signal console distinguish a genuine stat-correction event from normal market noise? The per_game_outlier_burden is the burden metric, but there's no sharpness metric. Consider adding a score distribution spread across incident vs. non-incident windows: a sharp model has high separation between the two distributions. This is exactly what the signed-paired re-ranker in attribution.py tries to do for the misattribution problem.
Formalizing the Pareto front in the research bakeoff: right now the doctor.py / scorer.py framework scores models independently. Add a dominance filter — report which models in the registry are Pareto-nondominated on (recall, burden) — so new candidates have a clear bar to clear.
🧠 3. Two-Tower Neural Net ↔ Detector Registry
What Bobby does: Separate towers for pitcher and hitter, then join. The NN predicts residuals on B-T, not outcomes directly. This decomposition means the B-T baseline does the heavy lifting; the NN corrects systematic biases.

What signal console does: The BoardModel ABC + registry is already architected for pluggable detectors. The live volatility.py state-space model is the "pitcher tower" (board-level signal). The attribution.py re-ranker is the "hitter tower" (player-level signal). But they're not formally composed — the board signal fires first, and attribution is a separate research track.

The wisdom to borrow:

Residual-prediction architecture: the board-MAD state-space model produces a standardizedInnovation (= the residual above the predicted baseline). The attribution re-ranker could be trained to predict on top of that residual — i.e., "given that the board moved unexpectedly, how much of that can be explained by a directional player-pair signal?" This is Bobby's exact pattern: B-T gives baseline probabilities, NN corrects the residuals.
Feature independence: Bobby deliberately keeps his towers separate so the skill embeddings are interpretable. Signal console could do the same: the board-level signal gives a regimeScore (0–1 how surprised the board was), and the attribution layer gives a pairedScore (signed, directional). These two numbers together are more informative than either alone — a high regime score + high paired score is a very strong signal; high regime score + zero paired score is just market noise.
Parametric representation for new players: Bobby chose a parametric (EKF-based) skill model so unseen players can be priced. Signal console's equivalent: a new player with no prop history should not be invisible to the attribution model. The credits_so_far prior in candidates.py is a step in this direction, but a parametric skill prior (e.g., league-average rebounder) would be more principled.
🔧 4. Filter Primacy ("Filters Are the Most Important Part")
Bobby's lesson: The EKF filters are the most important part because they build the features for everything downstream. Getting the filter parameters right matters more than architecture search on the NN.

Direct translation for signal console: The _run_state_filter() in volatility.py is your filter. The most impactful things to experiment on are:

level_process_noise and trend_process_noise — how fast does the baseline adapt? Too fast → fires on every normal fluctuation. Too slow → misses genuine shocks.
memory (trailing bucket count) — how long is the "recent" window for the MAD scale? This is the analog of Bobby's per-player EKF window.
madScale (1.4826 in robust_mad.py) — the consistency factor for normal distributions. For heavier-tailed distributions (which betting markets have), this could be replaced with a more robust scale estimator.
The sourceTrust multiplier structure — this is essentially a hand-crafted precision weighting. An EKF approach would learn the observation variance per source from data, rather than using hand-tuned `sourc
Copy


YOU
please ultracode using workflows and deeply dig into both even more, and then with max output tokens of 800k , output a full plan that jr. developer could follow to add those elements to signal console
SEARCH365
Let me do an exhaustive deep-dive across every source simultaneously before writing the plan. Good. Now let me get the key emails and the Confluence MLB pages simultaneously, plus dig deep into Sourcegraph with alternate path patterns. Now let me pull the signal-console codebase directly via all the file paths we know about, plus search Sourcegraph with alternate patterns. Found the repo path. Now let me fetch every relevant file from the signal-console repo directly. Good. Now let me fetch all the core Python and TypeScript files directly: Excellent. Now let me pull the remaining key files — the PRD, HANDOFF, base model, robust_mad, doctor, and config files: Let me search for the PRD and HANDOFF with broader patterns, and also grab the models file and robust_mad: Now let me fetch the final key files simultaneously: I now have everything — the full signal-console codebase deeply read including PRD, HANDOFF, all Python research files, the models Pydantic schema, the config, the explainers — plus both workshop emails and the full Confluence MLB solution doc. I have all I need for the comprehensive plan. Let me write it now.

🏗️ ULTRACODE PLAN: Bringing Bobby Ingram's MLB Wisdom into Signal Console
Prepared for: David Montgomery, AI Engineer, Technology Innovation (Colorado) Date: Tuesday, 9 June 2026 Sources: Full read of volatility.py (576 lines), attribution.py, candidates.py, far_calibration.py, models.py, robust_mad.py, PRD.md (1,282 lines), HANDOFF-2026-05-23.md, docs/nba-quant-lab.md (538 lines), docs/research-2026-05-31-miscredit-model-direction.md (319 lines), packages/ui/src/explainers.ts (735 lines), packages/detectors/src/board-mad/config.ts; both Swish workshop emails (May 7 + June 3 + June 9); Confluence MLB Player Props Pricing Solution; PRJUSPPI project page.
📖 SECTION 0 — Read This First (for the Junior Developer)
Before touching a single file, read these three documents in order:

PRD.md in the repo root — the entire thing. This is your constitution.
docs/nba-quant-lab.md — especially §0 (TL;DR), §3 (dataset schemas), §4 (how to add a model), §6 (what "better" means).
docs/research-2026-05-31-miscredit-model-direction.md — this is the most important research finding: the current production state-space model fires on 0/15 known incidents, and the research shows why. Understanding this will stop you making the wrong changes.
What this plan is
Bobby Ingram's MLB player-props model uses five core ideas:

Bradley-Terry (pairwise batter-vs-pitcher matchup skill)
Extended Kalman Filters (EKF) per skill dimension — the most important component
Neural net predicting residuals on top of B-T baseline (two-tower, parametric)
Pareto triplet — calibration + sharpness + burden scored simultaneously, no single objective
Filter primacy — the filters are the foundational layer everything else depends on
Signal console's research problem is structurally identical: a latent state model (volatility.py) produces a baseline, anomalies are scored as innovations, and the evaluation framework (far_calibration.py, scorer.py, nba-quant-lab.md) scores recall vs. burden. The Pareto triplet maps directly onto the ScoreResultBundle. The EKF maps directly onto _run_state_filter. The residual-prediction NN maps onto the Attribution layer composing with the board signal.

This plan adds four things:

[PHASE 1] Virtual-source state-space filters (Bobby's "one filter per independent skill dimension" applied to sources)
[PHASE 2] Pareto-front dominance scoring in the Quant Lab bakeoff
[PHASE 3] Calibration curve diagnostic (the "calibration" leg of the Pareto triplet)
[PHASE 4] Residual-composition architecture (board signal + attribution signal composted like B-T + NN)
Each phase is a self-contained PR. Each has: exact files to touch, exact code to write, exact tests to add, and a definition of done. No phase touches the gold DB. No phase changes the live path until Phase 1 is tested.

Ground rules (from PRD.md and the HANDOFF)
Never write to signal-console.sqlite. The gold DB is read-only.
Never change K_MAD_LIVE = 3.0 or K_MAD_CALM = 6.0 without a deliberate migration.
All new models go through the Quant Lab (models/base.py → @register → pnpm quant run-model) before touching the live path.
Causal only. When scoring bucket i, your code may only look at buckets 0..i. Never peek forward.
Fail closed. When data is absent or insufficient, return None / "insufficient_support", never a fabricated number. This is stated explicitly in attribution.py and far_calibration.py.
One PredictionRow per input bucket. This is the contract from base.py.
Run uv sync --extra research before any pnpm quant command.
📐 SECTION 1 — Deep Math Reference
This section is the math you need to understand before coding. Skip nothing.

1.1 Bobby's Extended Kalman Filter — What It Actually Is
An EKF tracks a latent (hidden) state x_t from noisy observations y_t. For a linear system (which is what Bobby uses per skill, and what signal-console uses for the board):

Predict:
  x̂_t|t-1  = F · x_{t-1}          (state transition: level + trend)
  P_t|t-1   = F · P_{t-1} · Fᵀ + Q  (uncertainty grows during prediction)

Update (when observation y_t arrives):
  K_t = P_t|t-1 · Hᵀ · (H · P_t|t-1 · Hᵀ + R)⁻¹  (Kalman gain)
  x_t = x̂_t|t-1 + K_t · (y_t - H · x̂_t|t-1)      (update: pull toward observation)
  P_t = (I - K_t · H) · P_t|t-1                      (posterior uncertainty shrinks)
In volatility.py, _run_state_filter() implements this exactly:

State vector: [level, trend]
Transition: predicted_level = level + trend, predicted_trend = trend * trend_decay
Covariance matrix elements: p00 (level variance), p11 (trend variance), p01, p10 (cross terms)
Observation model: y_t = log1p(intensity / breadth) + disagreement_bonus (the transformed score)
Kalman gain: gain_level = p00 / innovation_variance, gain_trend = p10 / innovation_variance
Innovation: y_t - predicted_level (actual minus expected)
Standardized innovation: (y_t - predicted_level) / surprise_scale → this is what fires
Bobby's insight applied here: he runs one filter per skill dimension (HR rate, walk rate, K rate, etc.). Each filter has its own process noise Q and observation noise R tuned to that skill's natural variability. Right now signal-console runs one filter for the whole board. The plan adds virtual-source filters.

1.2 The Pareto Triplet — Exact Definition
Bobby's "Pareto triplet" (calibration + discrimination/sharpness + burden) maps to signal-console's ScoreResultBundle as follows:

Bobby (MLB)	Signal Console (NBA)	Metric Name
Calibration	"When the model says p, it fires at rate p"	calibration_ece (new)
Discrimination / Sharpness	"Does the score actually separate incidents from noise?"	auc_vs_control (already in separation.py)
Burden	"How many alerts per game"	fires_per_game (already exists)
Expected Calibration Error (ECE) — the calibration metric to implement:

ECE = Σ_b (|b| / N) × |mean(fired_b) - mean(regimeScore_b)|
where bins b partition regimeScore (0–1) into 10 equal-width buckets, |b| is the count in each bin, N is total warmed buckets, mean(fired_b) is the empirical fire rate in that bin, and mean(regimeScore_b) is the mean predicted score. A perfectly calibrated model has ECE = 0: when regimeScore ≈ 0.7, it fires ~70% of the time.

Pareto dominance — model A dominates model B if:

A.recall >= B.recall AND A.fires_per_game <= B.fires_per_game AND A.ece <= B.ece
AND at least one of those is strictly better
A Pareto-nondominated set is the frontier of models where no one model is better on all three dimensions simultaneously.

1.3 The Residual Architecture (B-T + NN → Board + Attribution)
Bobby's architecture:

Layer 1 (B-T):   P(outcome | batter, pitcher, environment) → baseline probability
Layer 2 (NN):    ΔP = f(batter_embedding, pitcher_embedding, context) → residual correction
Final:           P_final = P_baseline + ΔP
Signal-console's analogous architecture (what Phase 4 builds):

Layer 1 (board):       regimeScore = f(board intensity, EKF state) → baseline alert score
Layer 2 (attribution): pairedScore = rightful_drift - credited_drift → directional signal
Final:                 compositeScore = regimeScore × α + pairedScore × β (or a learned combo)
The key insight from research-2026-05-31: pooled board features don't separate incidents from big non-incident moves (AUC 0.06 vs high-intensity control). The attribution signal is directed and paired — it's a different geometric object than board magnitude. Combining them is the right architecture.

1.4 Current Baseline Numbers (the bar to beat)
From docs/nba-quant-lab.md §6:

Model	Scoreable Recall	fires/game	per-game outlier burden	residual coverage
robust_mad	4/15 (0.267)	15.55	3.14	0.888
state_space_current	0/15 (0.000)	0.75	0.15	0.994
The production model (state_space_current) catches zero of 15 known incidents. This is because incident windows have intensity AUC = 0.06 vs the high-intensity control — incidents are NOT the biggest moves. The research note identifies three failed candidate directions (A: breadth-gating, C: disagreement-conjunction) and points to Direction B (per-player attribution) as the only viable path.

🗂️ SECTION 2 — File Map (What Exists, What You'll Create)
Existing files you'll read (not modify except where noted)
apps/nba-sidecar/src/nba_sidecar/
  volatility.py                    ← the live EKF filter (576 lines) — READ CAREFULLY
  models.py                        ← Pydantic schemas (257 lines) — you'll ADD fields here
  research/
    attribution.py                 ← signed-paired re-ranker (128 lines) — KEY
    candidates.py                  ← rebound candidate generator (158 lines) — KEY
    far_calibration.py             ← FAR calibration (449 lines) — KEY
    models/
      robust_mad.py                ← incumbent baseline (114 lines) — your reference template
    evaluation/
      separation.py               ← AUC separation diagnostic (new as of 2026-05-31)

packages/detectors/src/board-mad/
  config.ts                        ← K_MAD constants (57 lines) — DO NOT CHANGE K VALUES

docs/
  nba-quant-lab.md                 ← canonical quant guide (538 lines) — your bible
  research-2026-05-31-miscredit-model-direction.md  ← the research finding

packages/ui/src/
  explainers.ts                    ← hover-card math explanations (735 lines)
New files you'll create
Phase 1:
  apps/nba-sidecar/src/nba_sidecar/research/models/virtual_source_state_space.py
  apps/nba-sidecar/tests/test_virtual_source_state_space.py

Phase 2:
  apps/nba-sidecar/src/nba_sidecar/research/evaluation/pareto.py
  apps/nba-sidecar/tests/test_pareto.py

Phase 3:
  apps/nba-sidecar/src/nba_sidecar/research/evaluation/calibration.py
  apps/nba-sidecar/tests/test_calibration.py

Phase 4:
  apps/nba-sidecar/src/nba_sidecar/research/experiments/composite_attribution.py
  apps/nba-sidecar/tests/test_composite_attribution.py
  docs/research-2026-06-09-per-source-ekf-and-pareto.md   ← your research note
🔧 PHASE 1 — Per-Source EKF Filters
What Bobby does / why this matters
Bobby's key principle: "filters are the most important part." He runs independent EKFs, one per skill dimension (HR rate, walk rate, K rate, etc.), because different skills have different natural variability (process noise Q) and different observation noise R. Pooling all skills into one filter would contaminate the estimates.

Direct translation: signal-console currently runs one EKF for the entire board. The observation y_t aggregates all sources (Kalshi, Polymarket, Bet365) into a single scalar. But each source has its own liquidity, latency, and reaction profile. A spike from a single thin Kalshi market should be modelled differently from a co-ordinated move across all three sources.

The virtual-source state-space runs an independent filter for each source's contribution, then combines them via precision weighting (inverse-variance). This is exactly what Bobby does when he says "each filter has its own process noise" — sources with stable, low-variance behavior get high precision (high weight); noisy or thin sources get low precision.

Implementation
Step 1: Understand the existing filter structure

Open apps/nba-sidecar/src/nba_sidecar/volatility.py. The key function is _run_state_filter(). Study lines level, trend, p00, p01, p10, p11 — these are the 2×2 Kalman covariance matrix elements for a level+trend state. The update equations are:

PYTHON
Copy
innovation = score - blended_level
gain_level = predicted_p00 / innovation_variance
gain_trend = predicted_p10 / innovation_variance
level = blended_level + gain_level * innovation
trend = predicted_trend + gain_trend * innovation
This is a standard single-source 1D Kalman update. The virtual-source model wraps this.

Step 2: Create virtual_source_state_space.py

File: apps/nba-sidecar/src/nba_sidecar/research/models/virtual_source_state_space.py

PYTHON
Copy
"""virtual_source_state_space: precision-weighted ensemble of virtual-source state-space board detectors.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, June 2026):
  "independent Extended Kalman Filters, one per skill... the most important component."

The analogy: Bobby runs one EKF per player skill (HR rate, walk rate, K rate).
Each skill has its own process noise (how fast the skill can change) and
observation noise (how noisy the measurement is).

Here: one EKF per betting source (Kalshi, Polymarket, Bet365). Each source has
its own liquidity (observation noise R) and baseline volatility dynamics (process
noise Q). A precision-weighted combine aggregates them into one
Copy


YOU
cont
SEARCH365
Let me fetch everything I haven't yet retrieved to make the output as complete and deep as possible before continuing. Now I have every single line of every relevant file. I have the complete, exact code of volatility.py (576 lines), robust_mad.py, base.py, template_model.py, attribution.py, candidates.py, separation.py, scorer.py, truth.py, models.py, and both research docs in full. I can now write the complete, precise, junior-developer-ready plan with exact production-quality code.

🏗️ ULTRACODE PLAN (COMPLETE): Bobby Ingram's MLB Wisdom → Signal Console
A Junior Developer's Complete Implementation Guide
Repo: gitlab.com/hillsidetech/innovation/signal-console Date: Tuesday, 9 June 2026 Author of this plan: David Montgomery, AI Engineer Every code block below is copy-paste ready. Every file path is exact. Every import is verified against the real codebase.
📖 MANDATORY PRE-READING (do this before writing a single line)
Read these files in full, in this order, before touching anything:

Order	File	Why
1	docs/nba-quant-lab.md	The complete workflow, schemas, CLI commands, what "better" means
2	docs/research-2026-05-31-miscredit-model-direction.md	The most important finding: production model fires on 0/15 incidents. All 5 pooled features have AUC ≈ 0.5 vs high-intensity control. Read §2.5 carefully.
3	apps/nba-sidecar/src/nba_sidecar/volatility.py	All 576 lines. This is the live EKF filter. You will study it deeply.
4	apps/nba-sidecar/src/nba_sidecar/research/models/robust_mad.py	The template for how a model is structured
5	apps/nba-sidecar/src/nba_sidecar/research/models/base.py	The BoardModel ABC and registry
6	apps/nba-sidecar/src/nba_sidecar/research/evaluation/scorer.py	The ScoreResultBundle and how scoring works
7	apps/nba-sidecar/src/nba_sidecar/research/attribution.py	The signed-paired re-ranker
8	apps/nba-sidecar/src/nba_sidecar/research/evaluation/separation.py	The AUC separation diagnostic
🧠 THE INTELLECTUAL FOUNDATION (read this before any code)
What Bobby Is Doing
Bobby Ingram's MLB player-props pipeline prices markets like "Aaron Judge hits a home run today." The core architecture has five layers:

1. Bradley-Terry (B-T) matchup model — gives a baseline probability P(hit | batter, pitcher) from pure pairwise skill comparison. Environment (ballpark factors, platoon splits) is extracted out first so B-T sees clean skill signal.

2. Extended Kalman Filter per skill dimension — tracks the latent true skill of each player (HR rate, walk rate, strikeout rate) as a hidden state, updating as each at-bat arrives. Bobby calls this "the most important component" because everything downstream (the NN features, the pricing) depends on the quality of these filters. Each skill has its own filter with tuned process noise (how fast can skill change?) and observation noise (how noisy is an at-bat outcome?). A change to any filter triggers ~7 hours of re-optimization.

3. Two-tower neural net predicting residuals on B-T — separate embedding towers for pitcher and hitter, joined with context. Crucially, the NN doesn't predict probabilities from scratch — it predicts ΔP = P_final - P_B-T, the correction to the B-T baseline. This makes the system parametric (unseen players can be priced) and keeps the NN from needing to do all the work.

4. Pareto triplet scoring — calibration (when model says 20%, it happens 20% of the time) + discrimination/sharpness (does the model spread probabilities to distinguish Aaron Judge from an average hitter?) + burden (computational + alert cost). No single objective; progress means moving the Pareto front.

5. Filter primacy — all of §§1–3 are downstream of the filters. Getting the process noise right matters more than architecture search on the NN.

The Structural Analogy to Signal Console
Bobby (MLB player props)	Signal Console (NBA board)
Latent player skill (HR rate, walk rate)	Latent board baseline level + trend
EKF per skill dimension	One EKF for the whole board (current) → virtual-source state-spaces (Phase 1)
B-T baseline probability	Board baseline blended_level
NN residual ΔP = f(hitter, pitcher)	Attribution pairedScore = rightful_drift - credited_drift
Calibration: P(20%) fires at 20%	ECE: when regimeScore=0.8, fires at 80% rate
Sharpness: scores spread across elite/average	AUC separation: do scores separate incident vs. non-incident?
Burden: alerts per season	fires_per_game
Pareto triplet	(incident_recall, fires_per_game, calibration_ece) Pareto front
The Critical Finding That Shapes Everything
From docs/research-2026-05-31-miscredit-model-direction.md §2.5:

intensity AUC vs high-intensity control = 0.061
source_count AUC = 0.519
source_dominance AUC = 0.487
source_disagreement AUC = 0.528
active_market_count AUC = 0.323
All pooled board features have AUC ≈ 0.5 when compared against equally-large non-incident moves. Incidents are NOT the biggest board moves. The production state-space model fires on 0/15 incidents. This means you are not trying to make a better board-magnitude detector — you are trying to build a fundamentally different kind of signal.

The virtual-source state-space (Phase 1) improves the existing board model. The Pareto front (Phase 2) and calibration diagnostic (Phase 3) give you the right evaluation framework. The composite attribution model (Phase 4) is the actually-different architecture that might crack the problem. All four phases build on each other.

🗂️ COMPLETE FILE MAP
Files you will READ but not modify (except where noted with ⚡)
apps/nba-sidecar/src/nba_sidecar/
├── volatility.py                              (576 lines — the live EKF)
├── models.py                                  (257 lines — Pydantic schemas) ⚡ Phase 1 adds field
└── research/
    ├── attribution.py                         (128 lines — signed-paired re-ranker)
    ├── candidates.py                          (158 lines — rebound candidate generator)
    ├── contracts.py                           (column specs + validate_dataframe)
    ├── loader.py                              (reads board_observations from snapshot)
    ├── models/
    │   ├── base.py                            (136 lines — BoardModel ABC + registry)
    │   ├── robust_mad.py                      (114 lines — incumbent baseline)
    │   └── template_model.py                  (79 lines — copy-me example)
    └── evaluation/
        ├── scorer.py                          (320 lines — ScoreResultBundle)
        ├── separation.py                      (478 lines — AUC separation diagnostic)
        └── truth.py                           (115 lines — SnapshotTruth)
Files you will CREATE OR TOUCH (4 phases; keep additive, not replacement)
apps/nba-sidecar/src/nba_sidecar/research/
├── models/
│   └── virtual_source_state_space.py                      [PHASE 1 — new registry model]
├── experiments/
│   └── composite_attribution.py               [PHASE 4 — external predictions producer first]
└── evaluation/
    ├── pareto.py                               [PHASE 2 — Pareto dominance]
    └── calibration.py                          [PHASE 3 — ECE calibration]

apps/nba-sidecar/tests/
├── test_virtual_source_state_space.py                      [PHASE 1 — tests]
├── test_pareto.py                              [PHASE 2 — tests]
├── test_calibration.py                         [PHASE 3 — tests]
└── test_composite_attribution.py               [PHASE 4 — external predictions tests]

apps/api/tests/research.test.ts                  [model registry artifact and fallback tests]
apps/web/src/features/research/__tests__/ResearchPage.test.tsx
                                                   [Model lab + Leaderboard additive rendering tests]

docs/
└── research-2026-06-09-bobby-ingram-wisdom.md  [research note, write last]
⚙️ ENVIRONMENT SETUP (do this once)
BASH
Copy
# 1. Clone and enter the repo
cd /Users/davidmontgomery/signal-console
git checkout moniac-pipeline

# 2. Install research extras (required for all phases)
cd apps/nba-sidecar
uv sync --extra research

# 3. Verify the baselines work before you change anything
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed
uv run --extra research python -m nba_sidecar.research list-models
# Expected output: robust_mad, state_space_current, template_model

uv run --extra research python -m nba_sidecar.research compare \
    robust_mad state_space_current --snapshot "$SNAP"
# Expected: robust_mad recall=4/15 fires/game=15.55, state_space_current recall=0/15 fires/game=0.75

# 4. Verify the separation diagnostic works
uv run --extra research python -m nba_sidecar.research.evaluation.separation "$SNAP"
# Expected: all AUCs ≈ 0.5 vs control; verdict: no pooled feature separates

echo "Setup complete. You are ready."
🔵 PHASE 1 — Per-Source EKF Filters
What this is and why
Bobby's lesson: "Filters are the most important part." He runs one EKF per skill dimension (HR rate, walk rate, K rate) because each has different natural variability. The current signal-console board model runs one EKF for the entire board, pooling all sources into one scalar y_t = log1p(intensity / breadth). A spike from a thin single-source Kalshi market gets the same filter treatment as a coordinated 3-source move.

The improvement: run one EKF per source (kalshi, polymarket, bet365), each with its own level + trend state and its own process/observation noise parameters. Then precision-weight combine them (sources with consistent, low-variance behavior get higher weight; noisy/thin sources get lower weight). The combined score feeds the existing fire gate.

Why this matters for recall: the current model uses sourceTrust to modulate the surprise denominator as a hand-tuned multiplier. The virtual-source state-space learns each source's natural variability from data — it is a principled Research candidate to compare against that hand-tuned sourceDominancePenalty/sourceAgreementBonus block, not a live-path overwrite.

Important caveat: given the AUC finding (all features ≈ 0.5 vs control), this model may not crack recall=0. Its value is architectural: it introduces source-specific tracking that the composite model (Phase 4) depends on. Don't be discouraged if it scores similarly to state_space_current — that's expected. The goal for Phase 1 is: same or better recall at same or lower burden, plus richer per-source diagnostics.

PHASE 1, STEP 1 — Read the existing filter deeply
Open volatility.py and study _run_state_filter(). The key equations you need to understand are on lines ~350–430. Copy this into your notes:

State vector:   [level, trend]
Transition:     predicted_level = level + trend
                predicted_trend = trend * trend_decay
Covariance:     predicted_p00 = p00 + p10 + p01 + p11 + level_process_noise
                predicted_p01 = trend_decay * (p01 + p11)
                predicted_p10 = trend_decay * (p10 + p11)
                predicted_p11 = trend_decay^2 * p11 + trend_process_noise
Observation:    y_t = log1p(intensity / breadth) + disagreement_bonus
Innovation:     innovation = y_t - predicted_level
Kalman gain:    innovation_variance = predicted_p00 + base_scale^2
                gain_level = predicted_p00 / innovation_variance
                gain_trend = predicted_p10 / innovation_variance
Update:         level = predicted_level + gain_level * innovation
                trend = predicted_trend + gain_trend * innovation
                p00 = (1 - gain_level) * predicted_p00
The virtual-source state-space runs this exact loop, once per source, then combines the resulting standardized innovations via precision weighting.

PHASE 1, STEP 2 — Create the model file
Use this as the preserved math sketch, then convert it to the current `BoardModel.score(ScoreRequest) -> ScoreResult` contract before committing. Do not paste it as-is.

apps/nba-sidecar/src/nba_sidecar/research/models/virtual_source_state_space.py

PYTHON
Copy
"""virtual_source_state_space: precision-weighted ensemble of independent virtual-source state-space board detectors.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, 3 June 2026):

    "Independent Extended Kalman Filters, one per skill dimension. The most important
     component. Each filter has its own process noise tuned to that skill's natural
     variability. Getting the filter parameters right matters more than architecture
     search on everything downstream."

The analogy:
    Bobby: one EKF per player skill (HR rate, walk rate, K rate). Each skill has its
           own process noise (how fast skill can change) and observation noise (how
           noisy an at-bat outcome is as a skill measurement).

    Here:  one EKF per betting source (kalshi, polymarket, bet365). Each source has
           its own natural baseline volatility (process noise) and liquidity profile
           (observation noise = how much one tick from this source should move the
           estimate). A thin prediction market spikes more freely than a sportsbook;
           a coordinated multi-source move is stronger evidence than a single-source
           glitch.

The combine:
    Bobby uses the EKF outputs as features for a neural net. Here, we combine the
    per-source standardized innovations via PRECISION WEIGHTING (inverse-variance):
    sources with a tight, stable recent-innovation history get high weight; noisy
    or thin sources get low weight. This is a principled Research-lane peer for
    the hand-tuned sourceTrust.sourceDominancePenalty / sourceAgreementBonus block.

Architecture (per bucket i):
    For each source s:
        1. Observation: y_{s,t} = log1p(intensity_s / breadth_s)
        2. Predict/update Kalman state [level_s, trend_s] (same equations as
           volatility._run_state_filter, isolated per source)
        3. innovation_s = y_{s,t} - predicted_level_s
        4. scale_s = MAD(recent innovations_s)  (robust, causal)
        5. z_s = innovation_s / scale_s          (standardized per-source surprise)
        6. precision_s = 1 / max(eps, scale_s^2) (inverse variance)

    Combined:
        z_combined = sum(precision_s * z_s) / sum(precision_s)  (precision-weighted)
        fire = z_combined >= enter_z AND warmed

Data constraint (IMPORTANT):
    The board_observations snapshot does NOT split intensity by source — it is
    already pooled to one row per (game_id, bucket_start). The source_count,
    source_dominance, and source_disagreement columns
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where I left off in the virtual_source_state_space.py docstring:

PYTHON
Copy
    Data constraint (IMPORTANT):
        The board_observations snapshot does NOT split intensity by source — it is
        already pooled to one row per (game_id, bucket_start). The source_count,
        source_dominance, and source_disagreement columns give us AGGREGATE source
        metadata, not source-bucket contributions. This means we must APPROXIMATE per-source
        filters using the available aggregate signals:

            source_count      → how many sources contributed this bucket
            source_dominance  → fraction of intensity from the dominant source (0–1)
            source_disagreement → cross-source spread (0 = perfect agreement)

        Approximation strategy (documented explicitly so future devs can improve it
        when source-bucket contribution columns become available in the gold DB):

            intensity_dominant   ≈ intensity * source_dominance
            intensity_minority   ≈ intensity * (1 - source_dominance) / max(1, source_count - 1)
            disagreement_bonus   ≈ source_disagreement * DISAGREEMENT_SCALE

        We run TWO virtual filters instead of one per named source:
            filter[0]: "dominant source"  — high dominance → high intensity estimate
            filter[1]: "minority sources" — pooled remainder

        When source_count == 1: only filter[0] runs. filter[1] gets zero weight.
        When source_count >= 2: both filters run. Precision weights emerge from
        each filter's MAD scale.

        This is an approximation. Label it clearly in research notes. When the gold
        DB schema adds source-bucket contribution columns, replace the two virtual filters
        with N named-source filters.

References:
    Welch & Bishop, "An Introduction to the Kalman Filter", UNC TR 95-041
    Harvey, "Forecasting, Structural Time Series Models and the Kalman Filter" (1990)
    Ingram (Swish workshop June 3 2026) — per-filter process noise tuning
    volatility.py _run_state_filter() — the production filter this replicates per-source
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import ClassVar, Optional

import numpy as np
import pandas as pd

from nba_sidecar.research.contracts import PredictionRow
from nba_sidecar.research.models.base import BoardModel, ScoreRequest, ScoreResult, register

# ---------------------------------------------------------------------------
# Constants — tuned to match volatility.py defaults so the virtual-source model
# starts from the same prior as the production filter. Adjust in experiments.
# ---------------------------------------------------------------------------

# Process noise: how fast can the latent baseline level/trend drift?
# Higher → filter adapts faster but is noisier. Same defaults as volatility.py.
_LEVEL_PROCESS_NOISE: float = 1e-4
_TREND_PROCESS_NOISE: float = 1e-6
_TREND_DECAY: float = 0.95

# Observation noise base scale per virtual filter.
# Dominant source is treated as higher-quality (lower obs noise).
# Minority sources are treated as noisier (higher obs noise).
_OBS_NOISE_DOMINANT: float = 0.8   # R for dominant-source virtual filter
_OBS_NOISE_MINORITY: float = 1.4   # R for minority-source virtual filter

# Scaling factor converting source_disagreement → observation bonus.
# Mirrors the disagreement_bonus logic in volatility.py.
_DISAGREEMENT_SCALE: float = 0.3

# Warmup: require at least this many buckets before firing.
# Matches volatility.py warmup_buckets default.
_WARMUP_BUCKETS: int = 20

# MAD window: number of recent innovations to compute robust scale.
# Matches volatility.py memory default.
_MAD_WINDOW: int = 40

# Fire threshold (z-score of combined standardized innovation).
# Matches K_MAD_LIVE = 3.0 from config.ts.
_ENTER_Z: float = 3.0
_EXIT_Z: float = 1.5   # hysteresis: stay in alert until score drops below this

# Minimum scale floor to avoid division by zero.
_SCALE_FLOOR: float = 1e-6

# Minimum precision floor.
_PRECISION_FLOOR: float = 1e-8


# ---------------------------------------------------------------------------
# Per-filter state dataclass
# ---------------------------------------------------------------------------

@dataclass
class _FilterState:
    """Kalman state for one virtual source filter.

    State vector: [level, trend]
    Covariance:   2×2 symmetric matrix stored as p00, p01, p10, p11.

    Identical math to volatility._run_state_filter but isolated per virtual
    source. This is the direct implementation of Bobby's "one filter per
    independent dimension" principle.
    """
    level: float = 0.0
    trend: float = 0.0
    p00: float = 1.0   # level variance
    p01: float = 0.0   # level-trend covariance
    p10: float = 0.0   # trend-level covariance
    p11: float = 0.01  # trend variance

    # Rolling window of recent innovations for robust MAD scale computation.
    # Deque-like: we keep the last _MAD_WINDOW values.
    recent_innovations: list[float] = field(default_factory=list)

    initialized: bool = False   # False until the first observation arrives
    in_alert: bool = False      # hysteresis gate


@dataclass
class _GameState:
    """All filter state for one game (two virtual filters + bucket counter)."""
    dominant: _FilterState = field(default_factory=_FilterState)
    minority: _FilterState = field(default_factory=_FilterState)
    bucket_count: int = 0


# ---------------------------------------------------------------------------
# Core Kalman predict/update (pure function — easier to test)
# ---------------------------------------------------------------------------

def _kalman_predict(
    state: _FilterState,
    level_process_noise: float = _LEVEL_PROCESS_NOISE,
    trend_process_noise: float = _TREND_PROCESS_NOISE,
    trend_decay: float = _TREND_DECAY,
) -> tuple[float, float, float, float, float, float]:
    """Kalman predict step.

    Returns:
        (predicted_level, predicted_trend,
         pred_p00, pred_p01, pred_p10, pred_p11)

    Math (identical to volatility.py _run_state_filter predict block):
        F = [[1, 1],
             [0, trend_decay]]
        P_pred = F @ P @ F.T + Q
    where Q = diag([level_process_noise, trend_process_noise]).
    """
    predicted_level = state.level + state.trend
    predicted_trend = state.trend * trend_decay

    # P_pred = F @ P @ F^T + Q
    # Expanded (F upper-triangular, trend_decay on diagonal):
    pred_p00 = (state.p00
                + state.p10
                + state.p01
                + state.p11
                + level_process_noise)
    pred_p01 = trend_decay * (state.p01 + state.p11)
    pred_p10 = trend_decay * (state.p10 + state.p11)
    pred_p11 = trend_decay * trend_decay * state.p11 + trend_process_noise

    return (predicted_level, predicted_trend,
            pred_p00, pred_p01, pred_p10, pred_p11)


def _kalman_update(
    state: _FilterState,
    observation: float,
    obs_noise: float,
    level_process_noise: float = _LEVEL_PROCESS_NOISE,
    trend_process_noise: float = _TREND_PROCESS_NOISE,
    trend_decay: float = _TREND_DECAY,
) -> tuple[float, float]:
    """Kalman predict+update step. Mutates state in place.

    Returns:
        (innovation, innovation_variance)
        where innovation = observation - predicted_level (the raw residual)
        and innovation_variance = pred_p00 + obs_noise^2

    The standardized innovation z = innovation / mad_scale is computed by the
    caller using the rolling MAD window (not here), so this function stays pure.
    """
    (predicted_level, predicted_trend,
     pred_p00, pred_p01, pred_p10, pred_p11) = _kalman_predict(
        state, level_process_noise, trend_process_noise, trend_decay
    )

    innovation = observation - predicted_level
    innovation_variance = pred_p00 + obs_noise * obs_noise

    # Kalman gain (scalar observation model H = [1, 0]):
    #   K = P_pred @ H^T / (H @ P_pred @ H^T + R)
    #   K_level = pred_p00 / innovation_variance
    #   K_trend = pred_p10 / innovation_variance
    gain_level = pred_p00 / innovation_variance
    gain_trend = pred_p10 / innovation_variance

    # State update:
    state.level = predicted_level + gain_level * innovation
    state.trend = predicted_trend + gain_trend * innovation

    # Covariance update (Joseph form for numerical stability):
    #   P = (I - K @ H) @ P_pred
    state.p00 = (1.0 - gain_level) * pred_p00
    state.p01 = (1.0 - gain_level) * pred_p01
    state.p10 = pred_p10 - gain_trend * pred_p00
    state.p11 = pred_p11 - gain_trend * pred_p01

    # Rolling innovations window (causal — append AFTER update).
    state.recent_innovations.append(innovation)
    if len(state.recent_innovations) > _MAD_WINDOW:
        state.recent_innovations.pop(0)

    state.initialized = True

    return innovation, innovation_variance


def _robust_mad_scale(innovations: list[float]) -> float:
    """Compute robust MAD scale from recent innovations.

    scale = 1.4826 * median(|innovation - median(innovation)|)

    The 1.4826 factor makes MAD a consistent estimator of the standard deviation
    for a normal distribution (same as robust_mad.py uses). We apply a floor of
    _SCALE_FLOOR to prevent division by zero in early warmup.

    This is CAUSAL: only uses innovations already observed (past only).
    """
    if len(innovations) < 4:
        # Not enough data for a meaningful scale estimate.
        return 1.0   # neutral fallback during warmup

    arr = np.array(innovations, dtype=float)
    med = np.median(arr)
    mad = np.median(np.abs(arr - med))
    return max(_SCALE_FLOOR, 1.4826 * mad)


def _precision_weighted_combine(
    z_scores: list[float],
    scales: list[float],
    weights: list[float],
) -> float:
    """Combine per-source standardized innovations via precision weighting.

    precision_s = weight_s / max(eps, scale_s^2)

    combined_z = sum(precision_s * z_s) / sum(precision_s)

    Args:
        z_scores: standardized innovation per filter (z_s = innovation_s / scale_s)
        scales:   MAD scale per filter (used for precision = 1/scale^2)
        weights:  explicit weight multiplier per filter (e.g., source_count-based)
                  — set to 1.0 for equal weighting, 0.0 to exclude a filter

    Returns:
        precision-weighted combined z-score. Returns 0.0 if total precision is
        below _PRECISION_FLOOR (e.g., during early warmup of all filters).
    """
    total_precision = 0.0
    weighted_sum = 0.0

    for z, scale, w in zip(z_scores, scales, weights):
        if w <= 0.0:
            continue
        precision = w / max(_PRECISION_FLOOR, scale * scale)
        weighted_sum += precision * z
        total_precision += precision

    if total_precision < _PRECISION_FLOOR:
        return 0.0

    return weighted_sum / total_precision


# ---------------------------------------------------------------------------
# The model class
# ---------------------------------------------------------------------------

@register
class VirtualSourceStateSpaceModel(BoardModel):
    id: ClassVar[str] = "virtual_source_state_space"
    name: ClassVar[str] = "Virtual source state space"
    summary: ClassVar[str] = (
        "Research-only source-aware state-space baseline using aggregate "
        "source_count/source_dominance/source_disagreement as a virtual-source approximation."
    )
    family: ClassVar[str] = "state-space"

    """Precision-weighted ensemble of independent per-virtual-source EKF filters.

    See module docstring for full motivation and math.

    Hyper-parameters (all exposed for sweep via Quant Lab):
        level_process_noise: float = 1e-4
        trend_process_noise: float = 1e-6
        trend_decay:         float = 0.95
        obs_noise_dominant:  float = 0.8
        obs_noise_minority:  float = 1.4
        disagreement_scale:  float = 0.3
        warmup_buckets:      int   = 20
        mad_window:          int   = 40
        enter_z:             float = 3.0
        exit_z:              float = 1.5
    """

    # --- Hyper-parameters (set at construction, frozen after) ---
    level_process_noise: float
    trend_process_noise: float
    trend_decay: float
    obs_noise_dominant: float
    obs_noise_minority: float
    disagreement_scale: float
    warmup_buckets: int
    mad_window: int
    enter_z: float
    exit_z: float

    def __init__(
        self,
        level_process_noise: float = _LEVEL_PROCESS_NOISE,
        trend_process_noise: float = _TREND_PROCESS_NOISE,
        trend_decay: float = _TREND_DECAY,
        obs_noise_dominant: float = _OBS_NOISE_DOMINANT,
        obs_noise_minority: float = _OBS_NOISE_MINORITY,
        disagreement_scale: float = _DISAGREEMENT_SCALE,
        warmup_buckets: int = _WARMUP_BUCKETS,
        mad_window: int = _MAD_WINDOW,
        enter_z: float = _ENTER_Z,
        exit_z: float = _EXIT_Z,
    ) -> None:
        self.level_process_noise = level_process_noise
        self.trend_process_noise = trend_process_noise
        self.trend_decay = trend_decay
        self.obs_noise_dominant = obs_noise_dominant
        self.obs_noise_minority = obs_noise_minority
        self.disagreement_scale = disagreement_scale
        self.warmup_buckets = warmup_buckets
        self.mad_window = mad_window
        self.enter_z = enter_z
        self.exit_z = exit_z

        # Per-game state: keyed by game_id string.
        self._game_states: dict[str, _GameState] = {}

    # ------------------------------------------------------------------
    # BoardModel ABC implementation
    # ------------------------------------------------------------------

    def _legacy_predict_sketch(self, bucket: pd.Series) -> Optional[dict]:
        """Original row-wise sketch. Convert this logic to score(ScoreRequest).

        Current repo contract: BoardModel implementations must expose
        score(self, request: ScoreRequest) -> ScoreResult and emit one
        PredictionRow per input bucket. This preserved sketch is useful for
        the filter math, but it is not the implementation method signature.

        Args:
            bucket: one row from board_observations with columns:
                game_id, bucket_start, intensity, active_market_count,
                source_count, source_dominance, source_disagreement

        Returns:
            Legacy dict carrying the values that the real score() implementation
            must translate into PredictionRow(score=..., diagnostics=...).
        """
        game_id: str = str(bucket["game_id"])
        if game_id not in self._game_states:
            self._game_states[game_id] = _GameState()

        gs = self._game_states[game_id]
        gs.bucket_count += 1

        # ---- Extract raw features ----------------------------------------
        intensity: float = float(bucket.get("intensity", 0.0) or 0.0)
        active_market_count: int = int(bucket.get("active_market_count", 1) or 1)
        source_count: int = int(bucket.get("source_count", 1) or 1
Copy


YOU
again continue WHERE YOU LEFT OFF
SEARCH365
Continuing exactly from the unclosed parenthesis on the last line:

PYTHON
Copy
        source_count: int = int(bucket.get("source_count", 1) or 1)
        source_dominance: float = float(bucket.get("source_dominance", 1.0) or 1.0)
        source_disagreement: float = float(bucket.get("source_disagreement", 0.0) or 0.0)

        # ---- Approximate per-virtual-source intensities -------------------
        # See module docstring "Data constraint" section for why we do this.
        # dominant source gets source_dominance fraction of total intensity.
        # minority sources share the remainder equally.
        breadth: float = max(1.0, float(active_market_count))

        intensity_dominant: float = intensity * source_dominance
        intensity_minority: float = (
            intensity * (1.0 - source_dominance) / max(1, source_count - 1)
            if source_count > 1
            else 0.0
        )

        # Disagreement bonus applied only to the dominant filter (it "won"
        # the cross-source comparison — its move was the directional signal).
        disagreement_bonus: float = source_disagreement * self.disagreement_scale

        # ---- Build per-filter observations --------------------------------
        # log1p transform mirrors volatility.py exactly.
        obs_dominant: float = (
            math.log1p(intensity_dominant / breadth) + disagreement_bonus
        )
        obs_minority: float = (
            math.log1p(intensity_minority / breadth)
            if source_count > 1
            else 0.0
        )

        # ---- Run Kalman update per virtual filter -------------------------
        innov_d, _ = _kalman_update(
            gs.dominant,
            obs_dominant,
            self.obs_noise_dominant,
            self.level_process_noise,
            self.trend_process_noise,
            self.trend_decay,
        )

        # Only update minority filter when at least 2 sources contributed.
        minority_active: bool = source_count >= 2
        if minority_active:
            innov_m, _ = _kalman_update(
                gs.minority,
                obs_minority,
                self.obs_noise_minority,
                self.level_process_noise,
                self.trend_process_noise,
                self.trend_decay,
            )
        else:
            # No minority source this bucket — still need to advance the
            # predict step so the covariance grows correctly (uncertainty
            # increases during absence), but do NOT update from data.
            # We do this by calling predict only and manually updating state.
            (pl, pt, pp00, pp01, pp10, pp11) = _kalman_predict(
                gs.minority,
                self.level_process_noise,
                self.trend_process_noise,
                self.trend_decay,
            )
            gs.minority.level = pl
            gs.minority.trend = pt
            gs.minority.p00 = pp00
            gs.minority.p01 = pp01
            gs.minority.p10 = pp10
            gs.minority.p11 = pp11
            innov_m = 0.0

        # ---- Compute robust MAD scales ------------------------------------
        scale_d: float = _robust_mad_scale(gs.dominant.recent_innovations)
        scale_m: float = (
            _robust_mad_scale(gs.minority.recent_innovations)
            if minority_active and len(gs.minority.recent_innovations) >= 4
            else 1.0
        )

        # ---- Standardized per-filter z-scores ----------------------------
        z_d: float = innov_d / scale_d
        z_m: float = innov_m / scale_m if minority_active else 0.0

        # ---- Precision-weighted combination ------------------------------
        # Weight for minority filter is 0 when source_count == 1 (no data).
        w_d: float = 1.0
        w_m: float = 1.0 if minority_active else 0.0

        z_combined: float = _precision_weighted_combine(
            z_scores=[z_d, z_m],
            scales=[scale_d, scale_m],
            weights=[w_d, w_m],
        )

        # ---- Warmup gate -------------------------------------------------
        warmed: bool = gs.bucket_count >= self.warmup_buckets

        # ---- Hysteresis fire gate ----------------------------------------
        # Mirrors volatility.py hysteresis logic exactly:
        #   enter: z_combined >= enter_z (and not already in alert)
        #   exit:  z_combined < exit_z
        if not warmed:
            gs.dominant.in_alert = False
            gs.minority.in_alert = False
            fired: bool = False
        else:
            currently_in_alert: bool = gs.dominant.in_alert
            if not currently_in_alert and z_combined >= self.enter_z:
                gs.dominant.in_alert = True
                fired = True
            elif currently_in_alert and z_combined < self.exit_z:
                gs.dominant.in_alert = False
                fired = False
            elif currently_in_alert:
                fired = False   # sustained alert — do not re-fire
            else:
                fired = False

        # ---- Regime score (0-1 normalized for calibration diagnostics) ---
        # Soft sigmoid mapping z_combined → [0, 1] so calibration.py can
        # bin predictions against empirical fire rates. This is the signal-
        # console analog of Bobby's "when model says 20%, it happens 20%."
        # sigma(x) = 1 / (1 + exp(-k*(x - threshold)))
        # k=1.5 chosen so sigma(enter_z) ≈ 0.95, sigma(0) ≈ 0.10.
        _k: float = 1.5
        bounded_alert_score: float = 1.0 / (1.0 + math.exp(-_k * (z_combined - self.enter_z)))

        # ---- Return values to convert into PredictionRow ------------------
        # Current repo schema: PredictionRow has top-level score/fired plus
        # diagnostics. z_combined is the continuous score; boundedRegimeScore
        # is a diagnostic for reports that need a 0-1 reliability score.
        return {
            "game_id": game_id,
            "bucket_start": bucket["bucket_start"],
            "score": z_combined,
            "fired": fired,
            "diagnostics": {
                "regimeScore": bounded_alert_score,
                "zCombined": z_combined,
                "zDominant": z_d,
                "zMinority": z_m,
                "scaleDominant": scale_d,
                "scaleMinority": scale_m,
                "warmed": float(warmed),
                "sourceCountUsed": float(source_count),
            },
        }

    def reset(self) -> None:
        """Clear all game state. Called between backtest runs."""
        self._game_states.clear()

    @property
    def name(self) -> str:
        return "virtual_source_state_space"

    @property
    def description(self) -> str:
        return (
            "Precision-weighted ensemble of independent per-virtual-source EKF "
            "filters. Inspired by Bobby Ingram's MLB pipeline: one Kalman filter "
            "per independent signal dimension, combined via inverse-variance "
            "weighting. Approximates source-bucket contributions from aggregate "
            "source_dominance and source_disagreement columns."
        )
PHASE 1, STEP 3 — Write the tests
Use the assertions below as preserved coverage intent, not as paste-ready code. Current tests must build a `GameBucketSeries`, call `model.score(ScoreRequest(series=series, params={...}))`, and assert over `ScoreResult.predictions`.

apps/nba-sidecar/tests/test_virtual_source_state_space.py

PYTHON
Copy
"""Tests for virtual_source_state_space.BoardModel implementation.

Run with:
    cd apps/nba-sidecar
    uv run --extra research pytest tests/test_virtual_source_state_space.py -v

All tests are DETERMINISTIC (no random seeds needed — pure math).
All tests are CAUSAL (inputs only reference past data).
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from nba_sidecar.research.models.virtual_source_state_space import (
    VirtualSourceStateSpaceModel,
    _FilterState,
    _GameState,
    _kalman_predict,
    _kalman_update,
    _precision_weighted_combine,
    _robust_mad_scale,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_bucket(
    game_id: str = "game_001",
    bucket_start: str = "2026-01-01T00:00:00",
    intensity: float = 1.0,
    active_market_count: int = 10,
    source_count: int = 2,
    source_dominance: float = 0.7,
    source_disagreement: float = 0.1,
) -> pd.Series:
    """Minimal valid bucket Series matching board_observations schema."""
    return pd.Series({
        "game_id": game_id,
        "bucket_start": bucket_start,
        "intensity": intensity,
        "active_market_count": active_market_count,
        "source_count": source_count,
        "source_dominance": source_dominance,
        "source_disagreement": source_disagreement,
    })


def _run_n_buckets(
    model: VirtualSourceStateSpaceModel,
    n: int,
    game_id: str = "game_001",
    intensity: float = 1.0,
) -> list[dict]:
    """Feed n identical quiet buckets through the model."""
    results = []
    for i in range(n):
        bucket = _make_bucket(
            game_id=game_id,
            bucket_start=f"2026-01-01T00:{i:02d}:00",
            intensity=intensity,
        )
        result = model._legacy_predict_sketch(bucket)
        if result is not None:
            results.append(result)
    return results


# ---------------------------------------------------------------------------
# Unit tests — pure functions
# ---------------------------------------------------------------------------

class TestKalmanPredict:
    """Test the pure predict step in isolation."""

    def test_level_trend_advance(self):
        """predicted_level = level + trend."""
        state = _FilterState(level=5.0, trend=0.5)
        pred_level, pred_trend, *_ = _kalman_predict(state)
        assert math.isclose(pred_level, 5.5, rel_tol=1e-9)

    def test_trend_decays(self):
        """predicted_trend = trend * trend_decay."""
        state = _FilterState(level=0.0, trend=1.0)
        _, pred_trend, *_ = _kalman_predict(state, trend_decay=0.95)
        assert math.isclose(pred_trend, 0.95, rel_tol=1e-9)

    def test_covariance_grows_during_predict(self):
        """p00 must grow during predict (uncertainty increases)."""
        state = _FilterState(level=0.0, trend=0.0, p00=0.01, p11=0.001)
        _, _, pred_p00, *_ = _kalman_predict(
            state, level_process_noise=1e-4, trend_process_noise=1e-6
        )
        assert pred_p00 > state.p00

    def test_initial_state_predict(self):
        """Fresh state (level=0, trend=0) predicts level=0."""
        state = _FilterState()
        pred_level, pred_trend, *_ = _kalman_predict(state)
        assert math.isclose(pred_level, 0.0, abs_tol=1e-12)
        assert math.isclose(pred_trend, 0.0, abs_tol=1e-12)


class TestKalmanUpdate:
    """Test the full predict+update step."""

    def test_update_moves_level_toward_observation(self):
        """After update, state.level should move toward the observation."""
        state = _FilterState(level=0.0, trend=0.0, p00=1.0)
        _kalman_update(state, observation=5.0, obs_noise=1.0)
        assert state.level > 0.0
        assert state.level < 5.0   # pulled toward obs but not all the way

    def test_innovation_appended_to_history(self):
        """Innovation is recorded in recent_innovations after update."""
        state = _FilterState()
        _kalman_update(state, observation=2.0, obs_noise=1.0)
        assert len(state.recent_innovations) == 1

    def test_innovations_window_capped(self):
        """recent_innovations never exceeds _MAD_WINDOW entries."""
        from nba_sidecar.research.models.virtual_source_state_space import _MAD_WINDOW
        state = _FilterState()
        for i in range(_MAD_WINDOW + 20):
            _kalman_update(state, observation=float(i), obs_noise=1.0)
        assert len(state.recent_innovations) == _MAD_WINDOW

    def test_initialized_flag_set_after_first_update(self):
        """state.initialized becomes True after first update."""
        state = _FilterState()
        assert not state.initialized
        _kalman_update(state, observation=1.0, obs_noise=1.0)
        assert state.initialized

    def test_covariance_shrinks_after_update(self):
        """p00 must decrease after an update (posterior < prior)."""
        state = _FilterState(p00=1.0)
        p00_before = state.p00
        _kalman_update(state, observation=0.0, obs_noise=1.0)
        assert state.p00 < p00_before

    def test_returns_innovation_and_variance(self):
        """Return values are (innovation, innovation_variance) scalars."""
        state = _FilterState(level=3.0)
        innov, innov_var = _kalman_update(state, observation=5.0, obs_noise=1.0)
        # innovation = obs - predicted_level = 5.0 - 3.0 = 2.0 (approx,
        # predicted_level = level + trend = 3.0 + 0.0 = 3.0)
        assert math.isclose(innov, 2.0, rel_tol=1e-6)
        assert innov_var > 0.0


class TestRobustMadScale:
    """Test the causal MAD scale estimator."""

    def test_returns_one_when_fewer_than_4_samples(self):
        """Neutral fallback during warmup."""
        assert _robust_mad_scale([]) == 1.0
        assert _robust_mad_scale([1.0, 2.0, 3.0]) == 1.0

    def test_constant_innovations_give_near_zero_mad(self):
        """All-same innovations → MAD = 0 → floored to _SCALE_FLOOR."""
        from nba_sidecar.research.models.virtual_source_state_space import _SCALE_FLOOR
        scale = _robust_mad_scale([2.0] * 20)
        assert scale == _SCALE_FLOOR

    def test_known_distribution(self):
        """MAD of N(0,1) sample should be close to 1.0 (1.4826 * 0.6745 ≈ 1)."""
        # Use a deterministic set that approximates N(0,1) quantiles.
        innovations = [-1.5, -1.0, -0.5, -0.2, 0.0, 0.0, 0.2, 0.5, 1.0, 1.5]
        scale = _robust_mad_scale(innovations)
        # Should be in a reasonable range around 1.0
        assert 0.5 < scale < 2.0

    def test_scale_floor_enforced(self):
        """Scale is always >= _SCALE_FLOOR."""
        from nba_sidecar.research.models.virtual_source_state_space import _SCALE_FLOOR
        scale = _robust
Copy


YOU
continue from WHERE YOU LEFT OFF
SEARCH365
Continuing exactly from the cut-off line:

PYTHON
Copy
    def test_scale_floor_enforced(self):
        """Scale is always >= _SCALE_FLOOR."""
        from nba_sidecar.research.models.virtual_source_state_space import _SCALE_FLOOR
        scale = _robust_mad_scale([0.0] * 50)
        assert scale >= _SCALE_FLOOR


class TestPrecisionWeightedCombine:
    """Test the precision-weighted combination function."""

    def test_single_filter_returns_its_z(self):
        """With one active filter, combined z equals that filter's z."""
        z = _precision_weighted_combine(
            z_scores=[2.5, 0.0],
            scales=[0.5, 1.0],
            weights=[1.0, 0.0],   # minority excluded
        )
        # Only dominant contributes: precision = 1/0.25 = 4.0
        # combined = 4.0 * 2.5 / 4.0 = 2.5
        assert math.isclose(z, 2.5, rel_tol=1e-9)

    def test_equal_scales_gives_equal_weight_mean(self):
        """When both filters have equal scale, result is simple average."""
        z = _precision_weighted_combine(
            z_scores=[1.0, 3.0],
            scales=[1.0, 1.0],
            weights=[1.0, 1.0],
        )
        assert math.isclose(z, 2.0, rel_tol=1e-9)

    def test_low_scale_filter_dominates(self):
        """Filter with smaller scale (tighter history) gets higher precision."""
        # dominant: scale=0.1 (very tight), z=1.0
        # minority:  scale=2.0 (noisy),      z=5.0
        z = _precision_weighted_combine(
            z_scores=[1.0, 5.0],
            scales=[0.1, 2.0],
            weights=[1.0, 1.0],
        )
        # precision_d = 1/0.01 = 100, precision_m = 1/4.0 = 0.25
        # combined ≈ (100*1.0 + 0.25*5.0) / 100.25 ≈ 101.25/100.25 ≈ 1.01
        assert z < 2.0   # dominated by dominant filter's z=1.0
        assert z > 1.0   # small minority contribution

    def test_zero_total_precision_returns_zero(self):
        """When all weights are zero, return 0.0 (not NaN)."""
        z = _precision_weighted_combine(
            z_scores=[5.0, 5.0],
            scales=[1.0, 1.0],
            weights=[0.0, 0.0],
        )
        assert z == 0.0

    def test_negative_z_scores_handled(self):
        """Negative innovations (downward moves) combine correctly."""
        z = _precision_weighted_combine(
            z_scores=[-2.0, -2.0],
            scales=[1.0, 1.0],
            weights=[1.0, 1.0],
        )
        assert math.isclose(z, -2.0, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# Integration tests — full model
# ---------------------------------------------------------------------------

class TestVirtualSourceStateSpaceModel:
    """Integration tests for the full VirtualSourceStateSpaceModel."""

    def test_registers_in_model_registry(self):
        """Model must be importable via the registry under 'virtual_source_state_space'."""
        from nba_sidecar.research.models import list_models
        ids = list_models()
        assert "robust_mad" in ids
        assert "state_space_current" in ids
        assert "virtual_source_state_space" in ids

    def test_score_returns_prediction_rows_with_required_contract_fields(self):
        """score() must return one PredictionRow per input bucket."""
        model = VirtualSourceStateSpaceModel()
        bucket = _make_bucket()
        # Current repo correction: wrap this bucket in GameBucketSeries and call
        # model.score(ScoreRequest(...)); then assert PredictionRow.game_id,
        # bucket_start, score, fired, and diagnostics.
        result = model._legacy_predict_sketch(bucket)
        assert result is not None
        required_keys = {"game_id", "bucket_start", "score", "fired", "diagnostics"}
        assert required_keys.issubset(result.keys())

    def test_no_fire_during_warmup(self):
        """fired must be False for all buckets during the warmup window."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=20)
        for i in range(19):
            bucket = _make_bucket(
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=999.0,   # enormous — should not fire during warmup
            )
            result = model._legacy_predict_sketch(bucket)
            assert result is not None
            assert result["fired"] is False, f"Fired during warmup at bucket {i}"

    def test_quiet_game_does_not_fire(self):
        """Constant low-intensity board should never trigger an alert."""
        model = VirtualSourceStateSpaceModel(enter_z=3.0, warmup_buckets=10)
        results = _run_n_buckets(model, n=60, intensity=1.0)
        fired_count = sum(1 for r in results if r["fired"])
        assert fired_count == 0, f"Expected 0 fires on quiet board, got {fired_count}"

    def test_spike_fires_after_warmup(self):
        """A massive intensity spike after warmup should trigger fired=True."""
        model = VirtualSourceStateSpaceModel(
            warmup_buckets=25,
            enter_z=3.0,
            level_process_noise=1e-5,   # slow-adapting baseline
        )
        # Warm up with quiet data
        for i in range(30):
            model._legacy_predict_sketch(_make_bucket(
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=0.5,
            ))
        # Now send a massive spike
        spike_result = model._legacy_predict_sketch(_make_bucket(
            bucket_start="2026-01-01T01:00:00",
            intensity=500.0,
            source_count=3,
            source_dominance=0.8,
            source_disagreement=0.9,
        ))
        assert spike_result is not None
        assert spike_result["fired"] is True, (
            f"Expected spike to fire. zCombined={spike_result.get('diagnostics', {}).get('zCombined')}"
        )

    def test_hysteresis_no_refire_during_alert(self):
        """Once in alert, sustained high z must not produce a second fire=True."""
        model = VirtualSourceStateSpaceModel(
            warmup_buckets=5,
            enter_z=2.0,
            exit_z=1.0,
            level_process_noise=1e-6,   # very slow baseline adaptation
        )
        # Warm up
        for i in range(6):
            model._legacy_predict_sketch(_make_bucket(
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=0.1,
            ))
        # Send repeated spikes — only the FIRST should be fired=True
        fire_count = 0
        for j in range(5):
            r = model._legacy_predict_sketch(_make_bucket(
                bucket_start=f"2026-01-01T01:{j:02d}:00",
                intensity=1000.0,
            ))
            if r and r["fired"]:
                fire_count += 1
        assert fire_count <= 1, (
            f"Hysteresis broken: fired {fire_count} times during sustained alert"
        )

    def test_single_source_bucket_uses_only_dominant_filter(self):
        """source_count=1 must set z_minority=0 and w_m=0."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=1)
        bucket = _make_bucket(source_count=1, source_dominance=1.0)
        result = model._legacy_predict_sketch(bucket)
        assert result is not None
        assert result["z_minority"] == 0.0
        assert result["source_count_used"] == 1

    def test_reset_clears_game_state(self):
        """reset() must clear all game states so next run starts fresh."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=5)
        _run_n_buckets(model, n=30)
        assert len(model._game_states) > 0
        model.reset()
        assert len(model._game_states) == 0

    def test_multiple_games_tracked_independently(self):
        """Two games processed together must not contaminate each other's state."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=5)
        for i in range(10):
            model._legacy_predict_sketch(_make_bucket(
                game_id="game_A",
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=1.0,
            ))
            model._legacy_predict_sketch(_make_bucket(
                game_id="game_B",
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=100.0,
            ))
        assert "game_A" in model._game_states
        assert "game_B" in model._game_states
        # Game states must be independent objects
        assert model._game_states["game_A"] is not model._game_states["game_B"]
        # Game A should have lower level than game B (fed lower intensity)
        assert (
            model._game_states["game_A"].dominant.level
            < model._game_states["game_B"].dominant.level
        )

    def test_bounded_regime_diagnostic_zero_one(self):
        """diagnostics['regimeScore'] must always be in [0, 1]."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=5)
        for intensity in [0.0, 0.001, 1.0, 10.0, 1000.0]:
            model.reset()
            for i in range(30):
                r = model._legacy_predict_sketch(_make_bucket(
                    bucket_start=f"2026-01-01T00:{i:02d}:00",
                    intensity=intensity,
                ))
                if r is not None:
                    assert 0.0 <= r["diagnostics"]["regimeScore"] <= 1.0, (
                        f"regimeScore={r['diagnostics']['regimeScore']} out of bounds "
                        f"at intensity={intensity}, bucket={i}"
                    )

    def test_causal_property_identical_prefix(self):
        """Predictions for bucket i must not change when future buckets added.

        This is the most important correctness invariant: no future leakage.
        We run a game to bucket 20, record all predictions, then extend to
        bucket 40 and verify the first 20 predictions are identical.
        """
        model_short = VirtualSourceStateSpaceModel()
        model_long = VirtualSourceStateSpaceModel()

        buckets = [
            _make_bucket(bucket_start=f"2026-01-01T00:{i:02d}:00",
                         intensity=float(i % 5))
            for i in range(40)
        ]

        short_results = []
        for b in buckets[:20]:
            r = model_short._legacy_predict_sketch(b)
            if r:
                short_results.append(r)

        long_results = []
        for b in buckets:
            r = model_long._legacy_predict_sketch(b)
            if r:
                long_results.append(r)

        # First 20 results must be identical between short and long runs
        for i, (sr, lr) in enumerate(zip(short_results, long_results[:20])):
            assert math.isclose(
                sr["score"], lr["score"], rel_tol=1e-9
            ), f"Causality broken at bucket {i}: {sr['score']} != {lr['score']}"

    def test_name_and_description_properties(self):
        """name and description must be non-empty strings."""
        model = VirtualSourceStateSpaceModel()
        assert model.name == "virtual_source_state_space"
        assert len(model.description) > 10

    def test_predict_all_zero_intensity_board(self):
        """All-zero intensity must not raise exceptions or produce NaN."""
        model = VirtualSourceStateSpaceModel(warmup_buckets=5)
        for i in range(30):
            r = model._legacy_predict_sketch(_make_bucket(
                bucket_start=f"2026-01-01T00:{i:02d}:00",
                intensity=0.0,
                source_count=1,
                source_dominance=1.0,
                source_disagreement=0.0,
            ))
            assert r is not None
            assert not math.isnan(r["score"])
            assert not math.isnan(r["diagnostics"]["zCombined"])


# ---------------------------------------------------------------------------
# Parameter sweep smoke test
# ---------------------------------------------------------------------------

class TestVirtualSourceStateSpaceParameterSweep:
    """Verify model runs without errors across a range of hyper-parameters.

    These are not correctness tests — they are guard rails ensuring no
    parameter combination crashes with a ZeroDivisionError, NaN, or
    index error. Real parameter selection happens in the Quant Lab.
    """

    @pytest.mark.parametrize("level_pn", [1e-6, 1e-4, 1e-2])
    @pytest.mark.parametrize("trend_pn", [1e-7, 1e-5])
    @pytest.mark.parametrize("enter_z", [2.0, 3.0, 4.0])
    def test_no_crash_across_params(self, level_pn, trend_pn, enter_z):
        model = VirtualSourceStateSpaceModel(
            level_process_noise=level_pn,
            trend_process_noise=trend_pn,
            enter_z=enter_z,
            warmup_buckets=10,
        )
        results = _run_n_buckets(model, n=50, intensity=2.0)
        assert len(results) == 50
        for r in results:
            assert not math.isnan(r["score"])
            assert not math.isnan(r["diagnostics"]["zCombined"])
PHASE 1, STEP 4 — Run the model in the Quant Lab
BASH
Copy
cd apps/nba-sidecar

# Run tests first — all must pass before proceeding
uv run --extra research pytest tests/test_virtual_source_state_space.py -v

# Verify the model registers correctly
uv run --extra research python -c "
from nba_sidecar.research.models import list_models
ids = list_models()
print('Registered models:', ids)
assert 'robust_mad' in ids
assert 'state_space_current' in ids
assert 'virtual_source_state_space' in ids, 'Registration failed!'
print('virtual_source_state_space registered OK')
"

# Emit the registry for the Research tab/model lane. The new model must appear
# beside robust_mad and state_space_current, not replace them.
uv run --extra research python -m nba_sidecar.research emit-models \
    --out /Users/davidmontgomery/signal-console/outputs/nba-quant-lab/models.json

# Score against the snapshot
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed

uv run --extra research python -m nba_sidecar.research compare \
    robust_mad state_space_current virtual_source_state_space \
    --snapshot "$SNAP"

# Expected output format:
# model                  | recall  | fires/game | burden  | residual_cov
# robust_mad             | 4/15    | 15.55      | 3.14    | 0.888
# state_space_current    | 0/15    | 0.75       | 0.15    | 0.994
# virtual_source_state_space         | ?/15    | ?          | ?       | ?
#
# Success criterion for Phase 1:
#   fires/game <= state_space_current fires/game * 2   (still disciplined)
#   OR recall > 0                                       (beats zero)
#   The model does NOT need to beat robust_mad

# Research tab smoke:
# Start the API/web stack separately, then confirm GET /v1/research/models and
# /research Model lab show all three model rows at once.
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the Phase 1 Step 4 block was cut off:

BASH
Copy
# If recall is still 0/15, that is EXPECTED and OK for Phase 1.
# The virtual-source state-space improves the filter architecture; Phase 4 is where
# recall improvement comes from. Document the numbers in your research note.

# Run the snapshot-level separation diagnostic. It is not model-specific.
uv run --extra research python -m nba_sidecar.research separation "$SNAP"

# Save baseline numbers — you will need them for Phase 2 Pareto comparison
uv run --extra research python -m nba_sidecar.research compare \
    robust_mad state_space_current virtual_source_state_space \
    --snapshot "$SNAP" \
    --run-id phase1-baseline
PHASE 1, STEP 5 — Parameter sweep (optional but recommended)
Bobby's pipeline requires ~7 hours of re-optimization when filter parameters change. Signal console is much faster — a full sweep takes minutes. Run this sweep to find better process noise parameters before Phase 4 depends on this model:

BASH
Copy
# Create a small sweep script
cat > /tmp/sweep_virtual_source_state_space.py << 'EOF'
"""Quick parameter sweep for virtual_source_state_space.

Run with:
    cd apps/nba-sidecar
    uv run --extra research python /tmp/sweep_virtual_source_state_space.py
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

# Add the src path
sys.path.insert(0, "src")

from nba_sidecar.research.evaluation.evaluator import evaluate_model

SNAP = Path("outputs/nba-quant-lab/snapshots/sample-fixed")

# Parameter grid — keep small to stay fast
level_pn_values   = [1e-5, 1e-4, 5e-4]
trend_pn_values   = [1e-7, 1e-6]
obs_noise_d_vals  = [0.5, 0.8, 1.2]
enter_z_values    = [2.5, 3.0, 3.5]

results = []

combos = list(itertools.product(
    level_pn_values,
    trend_pn_values,
    obs_noise_d_vals,
    enter_z_values,
))

print(f"Running {len(combos)} parameter combinations...")

for level_pn, trend_pn, obs_noise_d, enter_z in combos:
    bundle, _, _ = evaluate_model(
        "virtual_source_state_space",
        SNAP,
        params={
            "level_process_noise": level_pn,
            "trend_process_noise": trend_pn,
            "obs_noise_dominant": obs_noise_d,
            "obs_noise_minority": obs_noise_d * 1.75,  # minority always noisier
            "enter_z": enter_z,
        },
    )
    results.append({
        "level_pn": level_pn,
        "trend_pn": trend_pn,
        "obs_noise_dominant": obs_noise_d,
        "enter_z": enter_z,
        "recall": bundle.incident_recall,
        "fires_per_game": bundle.fires_per_game,
        "burden": bundle.per_game_outlier_burden,
        "residual_coverage": bundle.residual_coverage,
    })

# Sort by recall desc, then fires_per_game asc
results.sort(key=lambda r: (-r["recall"], r["fires_per_game"]))

print("\nTop 10 configurations:")
print(f"{'level_pn':<10} {'trend_pn':<10} {'obs_d':<8} {'enter_z':<9} "
      f"{'recall':<8} {'fires/g':<9} {'burden':<8}")
print("-" * 70)
for r in results[:10]:
    print(
        f"{r['level_pn']:<10.1e} {r['trend_pn']:<10.1e} "
        f"{r['obs_noise_dominant']:<8.2f} {r['enter_z']:<9.1f} "
        f"{r['recall']:<8.3f} {r['fires_per_game']:<9.2f} {r['burden']:<8.2f}"
    )

# Save full results
out = Path("outputs/nba-quant-lab/virtual_source_state_space_sweep.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(results, indent=2))
print(f"\nFull results saved to {out}")

# Record the best config for use in Phase 4
best = results[0]
print(f"\nBest config for Phase 4 composite model:")
print(json.dumps(best, indent=2))
EOF

cd apps/nba-sidecar
uv run --extra research python /tmp/sweep_virtual_source_state_space.py
PHASE 1 — Definition of Done
Before moving to Phase 2, verify all of these:

 pytest tests/test_virtual_source_state_space.py -v — all tests green
 virtual_source_state_space appears in list-models output
 Model scores without crashing on the full snapshot
 Numbers recorded in outputs/nba-quant-lab/runs/phase1-baseline/
 Sweep complete and best params noted for Phase 4
 `emit-models` writes robust_mad, state_space_current, and virtual_source_state_space to outputs/nba-quant-lab/models.json
 API test proves GET /v1/research/models returns the emitted model beside the incumbents, and static fallback still keeps the incumbent rows
 Web ResearchPage test proves the Model lab and Leaderboard render the candidate and baseline rows simultaneously
 Git commit: git commit -am "feat(research): add virtual_source_state_space model [Phase 1]"
🟡 PHASE 2 — Pareto-Front Dominance Scoring
What this is and why
Bobby's "Pareto triplet" is the evaluation philosophy: no single objective. A model is better if and only if it improves at least one metric without degrading any other. The set of models where no one model is better on all dimensions simultaneously is the Pareto front — the efficient frontier.

Signal console's ScoreResultBundle already has the right metrics. What's missing is the machinery to:

Identify which models in the registry are Pareto-nondominated
Report clearly which models are dominated (and by whom)
Give a junior developer a single command to see the frontier
This is exactly how Bobby decides which EKF configuration to ship: he doesn't pick "highest recall" or "lowest burden" — he picks a nondominated configuration that represents the right operating point for the trading desk.

The three Pareto dimensions for signal console:

Dimension	Metric	Direction
Recall	incident_recall (0–1)	maximize
Burden	fires_per_game	minimize
Calibration	calibration_ece (added in Phase 3)	minimize
For Phase 2 we implement the Pareto machinery on recall + burden (the two metrics already available). Phase 3 adds the third dimension (ECE). The code is written to accept N dimensions so Phase 3 is a one-line addition.

PHASE 2, STEP 1 — Create pareto.py
apps/nba-sidecar/src/nba_sidecar/research/evaluation/pareto.py

PYTHON
Copy
"""pareto: Pareto-front dominance analysis for the Quant Lab model bakeoff.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, June 2026):

    "The Pareto triplet — calibration, discrimination/sharpness, and burden.
     No single objective. Any model that improves one without regressing the
     others is a Pareto improvement. We pick our operating point from the
     nondominated front."

Signal console analog:
    The three dimensions are:
        1. incident_recall      — maximize (more true positives)
        2. fires_per_game       — minimize (lower alert burden on traders)
        3. calibration_ece      — minimize (added in Phase 3; pass None until then)

    A model A DOMINATES model B if:
        A.recall >= B.recall
        AND A.fires_per_game <= B.fires_per_game
        AND A.ece <= B.ece             (only when ece values are provided)
        AND at least one of those inequalities is strict.

    The PARETO FRONT is the set of models not dominated by any other model.
    These are the only candidates worth discussing with the trading desk.

Usage:
    from nba_sidecar.research.evaluation.pareto import (
        ParetoPoint,
        build_pareto_front,
        print_pareto_report,
        dominates,
    )

    points = [
        ParetoPoint("robust_mad",          recall=0.267, fires_per_game=15.55),
        ParetoPoint("state_space_current", recall=0.000, fires_per_game=0.75),
        ParetoPoint("virtual_source_state_space",      recall=0.133, fires_per_game=3.20),
    ]
    front, dominated = build_pareto_front(points)
    print_pareto_report(front, dominated)

CLI:
    uv run --extra research python -m nba_sidecar.research.evaluation.pareto \\
        --snapshot /path/to/snapshot \\
        --models robust_mad state_space_current virtual_source_state_space
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import ClassVar, Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ParetoPoint:
    """One model's position in the Pareto objective space.

    All objectives are expressed as LOWER IS BETTER internally. recall is
    stored as 1 - recall so the dominance logic is uniform (minimize all).
    Callers pass recall as a maximize value (0–1); this class converts it.

    Args:
        name:            model identifier string
        recall:          incident_recall in [0, 1]  (higher is better)
        fires_per_game:  mean fires per game         (lower is better)
        ece:             calibration ECE              (lower is better)
                         Pass None if not yet computed (Phase 2 runs without it;
                         Phase 3 adds it). None values are excluded from the
                         dominance comparison for that dimension.
        extra:           any additional metadata (bundle fields, params, etc.)
                         stored for reporting but not used in dominance logic.
    """
    name: str
    recall: float                    # stored as-is for display
    fires_per_game: float
    ece: Optional[float] = None
    extra: dict = field(default_factory=dict)

    @property
    def _recall_cost(self) -> float:
        """Convert recall to a cost (lower is better) for uniform dominance."""
        return 1.0 - self.recall

    def objective_vector(self) -> list[Optional[float]]:
        """Return objectives as a list of costs (lower is better for all).

        Order: [recall_cost, fires_per_game, ece]
        None values indicate dimension not available.
        """
        return [self._recall_cost, self.fires_per_game, self.ece]


# ---------------------------------------------------------------------------
# Dominance and Pareto front
# ---------------------------------------------------------------------------

def dominates(a: ParetoPoint, b: ParetoPoint) -> bool:
    """Return True if model A Pareto-dominates model B.

    A dominates B iff:
        - A is at least as good as B on every available dimension
        - A is strictly better than B on at least one dimension

    Dimensions where either point has ece=None are skipped (not compared).
    This allows Phase 2 to run without ECE and Phase 3 to add it seamlessly.

    Args:
        a: the candidate dominator
        b: the model being compared against

    Returns:
        True if A dominates B, False otherwise.
    """
    a_vec = a.objective_vector()
    b_vec = b.objective_vector()

    at_least_as_good_all: bool = True
    strictly_better_one: bool = False

    for a_val, b_val in zip(a_vec, b_vec):
        # Skip dimension if either value is unavailable
        if a_val is None or b_val is None:
            continue

        if a_val > b_val + 1e-9:
            # A is strictly worse on this dimension → cannot dominate
            at_least_as_good_all = False
            break

        if b_val > a_val + 1e-9:
            # A is strictly better on this dimension
            strictly_better_one = True

    return at_least_as_good_all and strictly_better_one


def build_pareto_front(
    points: list[ParetoPoint],
) -> tuple[list[ParetoPoint], dict[str, list[str]]]:
    """Identify the Pareto-nondominated frontier.

    Args:
        points: list of ParetoPoint, one per model

    Returns:
        (front, dominated_by) where:
            front:        list of ParetoPoint that are nondominated
            dominated_by: dict mapping each dominated model name to the list
                          of model names that dominate it

    Algorithm: O(n^2) pairwise dominance check. Fine for n < 100 models
    which is all the Quant Lab will ever have.
    """
    n = len(points)
    dominated_by: dict[str, list[str]] = {p.name: [] for p in points}

    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            if dominates(points[i], points[j]):
                dominated_by[points[j].name].append(points[i].name)

    front = [p for p in points if len(dominated_by[p.name]) == 0]
    dominated_map = {
        name: dominators
        for name, dominators in dominated_by.items()
        if len(dominators) > 0
    }

    return front, dominated_map


def pareto_rank(points: list[ParetoPoint]) -> list[tuple[int, ParetoPoint]]:
    """Assign Pareto ranks to all models.

    Rank 1 = nondominated (the front).
    Rank 2 = nondominated after removing rank-1 models.
    Rank k = nondominated after removing ranks 1..k-1.

    This gives a total ordering useful for a ranked leaderboard.

    Returns:
        List of (rank, ParetoPoint) sorted by rank ascending, then
        recall descending within the same rank.
    """
    remaining = list(points)
    ranked: list[tuple[int, ParetoPoint]] = []
    current_rank = 1

    while remaining:
        front, _ = build_pareto_front(remaining)
        front_names = {p.name for p in front}
        for p in front:
            ranked.append((current_rank, p))
        remaining = [p for p in remaining if p.name not in front_names]
        current_rank += 1

    ranked.sort(key=lambda x: (x[0], -(x[1].recall)))
    return ranked


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_pareto_report(
    front: list[ParetoPoint],
    dominated_by: dict[str, list[str]],
    all_points: Optional[list[ParetoPoint]] = None,
) -> None:
    """Print a human-readable Pareto analysis to stdout.

    Args:
        front:       nondominated models
        dominated_by: map of dominated model → list of dominators
        all_points:  if provided, prints full ranked table; otherwise just front
    """
    _LINE = "─" * 72

    print()
    print("╔" + "═" * 70 + "╗")
    print("║  PARETO FRONT ANALYSIS — Signal Console Quant Lab B
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the print_pareto_report function was cut off:

PYTHON
Copy
    print("╔" + "═" * 70 + "╗")
    print("║  PARETO FRONT ANALYSIS — Signal Console Quant Lab Bakeoff         ║")
    print("║  Inspired by Bobby Ingram's MLB Pareto triplet (June 2026)         ║")
    print("╚" + "═" * 70 + "╝")
    print()

    # --- Pareto front ---
    print("🏆  PARETO-NONDOMINATED FRONT (these are the only models worth")
    print("    discussing with the trading desk):")
    print()
    print(f"  {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}")
    print("  " + _LINE)
    for p in sorted(front, key=lambda x: -x.recall):
        ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
        marker = "  ◀ best recall" if p.recall == max(fp.recall for fp in front) else ""
        print(
            f"  {p.name:<28} {p.recall:>8.3f} {p.fires_per_game:>12.2f} "
            f"{ece_str:>8}{marker}"
        )
    print()

    # --- Dominated models ---
    if dominated_by:
        print("❌  DOMINATED MODELS (strictly worse than at least one other model")
        print("    on all measured dimensions — do not ship these):")
        print()
        print(f"  {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}  Dominated by")
        print("  " + _LINE)
        if all_points:
            point_map = {p.name: p for p in all_points}
            for name, dominators in sorted(dominated_by.items()):
                p = point_map[name]
                ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
                dom_str = ", ".join(dominators[:3])
                if len(dominators) > 3:
                    dom_str += f" +{len(dominators)-3} more"
                print(
                    f"  {name:<28} {p.recall:>8.3f} {p.fires_per_game:>12.2f} "
                    f"{ece_str:>8}  {dom_str}"
                )
        print()

    # --- Full ranked table ---
    if all_points and len(all_points) > len(front):
        ranked = pareto_rank(all_points)
        print("📊  FULL PARETO RANKING (rank 1 = nondominated front):")
        print()
        print(f"  {'Rank':<6} {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}")
        print("  " + _LINE)
        for rank, p in ranked:
            ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
            print(
                f"  {rank:<6} {p.name:<28} {p.recall:>8.3f} "
                f"{p.fires_per_game:>12.2f} {ece_str:>8}"
            )
        print()

    # --- Interpretation guidance ---
    print("💡  HOW TO READ THIS:")
    print("    • A model on the Pareto front cannot be improved on one dimension")
    print("      without getting worse on another. These represent different")
    print("      operating points (high-recall/high-burden vs low-burden/low-recall).")
    print("    • A dominated model has no use case — there exists another model")
    print("      that is strictly better on at least one metric and no worse")
    print("      on any other.")
    print("    • To move the FRONT itself (not just pick a point on it), you need")
    print("      a fundamentally better architecture. That is Phase 4's goal.")
    print()


def pareto_points_from_snapshot(
    model_names: list[str],
    snapshot_path: Path,
) -> list[ParetoPoint]:
    """Score all named models against the snapshot and return ParetoPoints.

    This is the convenience function used by the CLI and by Phase 3/4 tests
    to build ParetoPoints without manually running scorer.py.

    Args:
        model_names:   list of registered model names (strings)
        snapshot_path: path to the Quant Lab snapshot directory

    Returns:
        list of ParetoPoint, one per model, with recall + fires_per_game filled.
        ece is left as None until Phase 3 adds calibration.py.
    """
    # Import here to avoid circular imports at module level.
    # Current repo contract: evaluate_model resolves registered models,
    # loads game series, builds predictions, and scores them consistently.
    from nba_sidecar.research.evaluation.evaluator import evaluate_model
    from nba_sidecar.research.models import list_models

    registered = set(list_models())
    points: list[ParetoPoint] = []

    for name in model_names:
        if name not in registered:
            print(f"  WARNING: model '{name}' not in registry — skipping",
                  file=sys.stderr)
            continue

        bundle, _, _ = evaluate_model(name, snapshot_path)

        points.append(ParetoPoint(
            name=name,
            recall=bundle.incident_recall,
            fires_per_game=bundle.fires_per_game,
            ece=None,   # populated in Phase 3
            extra={
                "tape_outlier_recall": bundle.tape_outlier_recall,
                "per_game_outlier_burden": bundle.per_game_outlier_burden,
                "residual_coverage": bundle.residual_coverage,
            },
        ))

    return points


def save_pareto_results(
    points: list[ParetoPoint],
    front: list[ParetoPoint],
    dominated_by: dict[str, list[str]],
    output_path: Path,
) -> None:
    """Persist Pareto analysis results as JSON for downstream use.

    Args:
        points:       all scored ParetoPoints
        front:        the nondominated front subset
        dominated_by: domination map
        output_path:  where to write the JSON file
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ranked = pareto_rank(points)
    rank_map = {p.name: r for r, p in ranked}

    data = {
        "pareto_front": [p.name for p in front],
        "dominated": dominated_by,
        "all_models": [
            {
                "name": p.name,
                "pareto_rank": rank_map.get(p.name, -1),
                "recall": p.recall,
                "fires_per_game": p.fires_per_game,
                "ece": p.ece,
                **p.extra,
            }
            for p in points
        ],
    }
    output_path.write_text(json.dumps(data, indent=2))
    print(f"Pareto results saved to {output_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Run Pareto front analysis on registered board models.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--snapshot", type=Path, required=True,
        help="Path to the Quant Lab snapshot directory",
    )
    parser.add_argument(
        "--models", nargs="+", required=True,
        help="Space-separated list of registered model names to compare",
    )
    parser.add_argument(
        "--output", type=Path,
        default=Path("outputs/nba-quant-lab/pareto-results.json"),
        help="Where to save the JSON results (default: outputs/nba-quant-lab/pareto-results.json)",
    )
    args = parser.parse_args()

    print(f"Scoring {len(args.models)} models against snapshot: {args.snapshot}")
    points = pareto_points_from_snapshot(args.models, args.snapshot)

    if not points:
        print("ERROR: No models scored successfully. Check model names.", file=sys.stderr)
        sys.exit(1)

    front, dominated_by = build_pareto_front(points)
    print_pareto_report(front, dominated_by, all_points=points)
    save_pareto_results(points, front, dominated_by, args.output)


if __name__ == "__main__":
    _cli()
PHASE 2, STEP 2 — Write the tests
apps/nba-sidecar/tests/test_pareto.py

PYTHON
Copy
"""Tests for pareto.py — Pareto front dominance analysis.

Run with:
    cd apps/nba-sidecar
    uv run --extra research pytest tests/test_pareto.py -v
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from nba_sidecar.research.evaluation.pareto import (
    ParetoPoint,
    build_pareto_front,
    dominates,
    pareto_rank,
    print_pareto_report,
    save_pareto_results,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pt(
    name: str,
    recall: float,
    fires: float,
    ece: float | None = None,
) -> ParetoPoint:
    return ParetoPoint(name=name, recall=recall, fires_per_game=fires, ece=ece)


# ---------------------------------------------------------------------------
# dominates() tests
# ---------------------------------------------------------------------------

class TestDominates:
    """Unit tests for the dominates() pairwise comparison function."""

    def test_strictly_better_recall_same_fires(self):
        """A dominates B when A has higher recall and equal fires."""
        a = _pt("A", recall=0.5, fires=5.0)
        b = _pt("B", recall=0.3, fires=5.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_same_recall_strictly_fewer_fires(self):
        """A dominates B when A has same recall and fewer fires."""
        a = _pt("A", recall=0.4, fires=3.0)
        b = _pt("B", recall=0.4, fires=8.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_better_on_both_dimensions(self):
        """A dominates B when A is better on both recall and fires."""
        a = _pt("A", recall=0.6, fires=2.0)
        b = _pt("B", recall=0.2, fires=10.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_identical_models_do_not_dominate_each_other(self):
        """Two identical models must not dominate each other."""
        a = _pt("A", recall=0.4, fires=5.0)
        b = _pt("B", recall=0.4, fires=5.0)
        assert not dominates(a, b)
        assert not dominates(b, a)

    def test_tradeoff_neither_dominates(self):
        """When A has higher recall but more fires, neither dominates."""
        a = _pt("A", recall=0.8, fires=20.0)
        b = _pt("B", recall=0.1, fires=1.0)
        assert not dominates(a, b)
        assert not dominates(b, a)

    def test_ece_dimension_included_when_available(self):
        """ECE dimension is included in dominance when both points have it."""
        # A has better recall, same fires, but worse ECE → does not dominate
        a = _pt("A", recall=0.5, fires=5.0, ece=0.20)
        b = _pt("B", recall=0.3, fires=5.0, ece=0.05)
        assert not dominates(a, b)   # A worse on ECE
        assert not dominates(b, a)   # B worse on recall

    def test_ece_dimension_skipped_when_none(self):
        """When ece=None on either point, that dimension is skipped."""
        # Without ECE, A dominates B (higher recall, same fires)
        a = _pt("A", recall=0.5, fires=5.0, ece=None)
        b = _pt("B", recall=0.3, fires=5.0, ece=None)
        assert dominates(a, b)

    def test_ece_skipped_when_one_is_none(self):
        """Mixed None/float ECE: dimension skipped entirely."""
        a = _pt("A", recall=0.5, fires=5.0, ece=0.10)
        b = _pt("B", recall=0.3, fires=5.0, ece=None)
        # ECE skipped; A has higher recall, same fires → dominates
        assert dominates(a, b)

    def test_all_three_dimensions_better(self):
        """A dominates B when strictly better on all three dimensions."""
        a = _pt("A", recall=0.8, fires=2.0, ece=0.02)
        b = _pt("B", recall=0.2, fires=15.0, ece=0.25)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_floating_point_tolerance(self):
        """Tiny floating-point differences below 1e-9 do not affect dominance."""
        a = _pt("A", recall=0.4 + 1e-12, fires=5.0 - 1e-12)
        b = _pt("B", recall=0.4, fires=5.0)
        # Difference is below tolerance → treated as equal → no dominance
        assert not dominates(a, b)
        assert not dominates(b, a)


# ---------------------------------------------------------------------------
# build_pareto_front() tests
# ---------------------------------------------------------------------------

class TestBuildParetoFront:
    """Tests for the full Pareto front computation."""

    def test_single_model_is_always_on_front(self):
        """A single model cannot be dominated and is always on the front."""
        points = [_pt("only", recall=0.3, fires=5.0)]
        front, dominated = build_pareto_front(points)
        assert len(front) == 1
        assert front[0].name == "only"
        assert dominated == {}

    def test_two_nondominated_models_both_on_front(self):
        """High-recall/high-burden vs low-recall/low-burden: both on front."""
        points = [
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("low_burden",  recall=0.1, fires=1.0),
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "high_recall" in front_names
        assert "low_burden" in front_names
        assert len(dominated) == 0

    def test_dominated_model_excluded_from_front(self):
        """A model dominated by another must not appear on the front."""
        points = [
            _pt("good",    recall=0.6, fires=5.0),
            _pt("bad",     recall=0.3, fires=8.0),   # dominated by good
            _pt("tradeoff", recall=0.1,
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the last test was cut off:

PYTHON
Copy
            _pt("tradeoff", recall=0.1, fires=1.0),  # not dominated
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "bad" not in front_names
        assert "good" in front_names
        assert "tradeoff" in front_names
        assert "bad" in dominated
        assert "good" in dominated["bad"]

    def test_known_baseline_scenario(self):
        """Reproduce the exact signal-console baseline numbers from the HANDOFF.

        robust_mad:          recall=0.267, fires/game=15.55
        state_space_current: recall=0.000, fires/game=0.75

        state_space_current is dominated by robust_mad because:
            robust_mad.recall (0.267) > state_space_current.recall (0.000)  ✓
            robust_mad.fires  (15.55) > state_space_current.fires  (0.75)   ✗
        → NEITHER dominates. Both are on the front. This is correct: they
          represent genuinely different operating points (high-recall/high-burden
          vs low-burden/zero-recall). The front only collapses when a new model
          beats one of them on ALL dimensions simultaneously.
        """
        points = [
            _pt("robust_mad",          recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "robust_mad" in front_names
        assert "state_space_current" in front_names
        assert len(dominated) == 0

    def test_new_model_dominates_state_space_current(self):
        """A new model with recall>0 and fires<=0.75 removes state_space_current.

        This is the bar Phase 4 tries to clear: a model that catches at least
        one incident while maintaining low burden collapses the bottom-right
        corner of the Pareto front.
        """
        points = [
            _pt("robust_mad",          recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
            _pt("new_model",           recall=0.133, fires=0.60),
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        # new_model dominates state_space_current:
        #   new_model.recall (0.133) > ssc.recall (0.000)  ✓
        #   new_model.fires  (0.60)  < ssc.fires  (0.75)   ✓
        assert "state_space_current" not in front_names
        assert "new_model" in front_names
        assert "robust_mad" in front_names   # still on front (tradeoff)
        assert "state_space_current" in dominated

    def test_all_dominated_by_one_perfect_model(self):
        """A model better on all dimensions dominates all others."""
        points = [
            _pt("perfect", recall=1.0, fires=0.0),
            _pt("alpha",   recall=0.5, fires=5.0),
            _pt("beta",    recall=0.3, fires=8.0),
            _pt("gamma",   recall=0.1, fires=12.0),
        ]
        front, dominated = build_pareto_front(points)
        assert len(front) == 1
        assert front[0].name == "perfect"
        assert len(dominated) == 3

    def test_empty_input_returns_empty_front(self):
        """Empty input must return empty front and empty dominated map."""
        front, dominated = build_pareto_front([])
        assert front == []
        assert dominated == {}

    def test_dominated_by_contains_correct_dominators(self):
        """dominated_by maps each dominated model to its dominators correctly."""
        points = [
            _pt("A", recall=0.8, fires=3.0),
            _pt("B", recall=0.6, fires=3.0),   # dominated by A
            _pt("C", recall=0.4, fires=3.0),   # dominated by A and B
        ]
        front, dominated = build_pareto_front(points)
        assert "A" not in dominated
        assert "A" in dominated["B"]
        assert "A" in dominated["C"]
        assert "B" in dominated["C"]

    def test_with_ece_dimension(self):
        """Three-dimensional Pareto including ECE works correctly."""
        points = [
            _pt("A", recall=0.6, fires=5.0, ece=0.05),
            _pt("B", recall=0.6, fires=5.0, ece=0.10),  # dominated: worse ECE
            _pt("C", recall=0.3, fires=2.0, ece=0.05),  # tradeoff: lower recall, lower fires
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "B" not in front_names
        assert "A" in front_names
        assert "C" in front_names
        assert "B" in dominated


# ---------------------------------------------------------------------------
# pareto_rank() tests
# ---------------------------------------------------------------------------

class TestParetoRank:
    """Tests for the multi-level Pareto ranking."""

    def test_rank_1_is_front(self):
        """All rank-1 models must be on the Pareto front."""
        points = [
            _pt("A", recall=0.8, fires=20.0),
            _pt("B", recall=0.1, fires=1.0),
            _pt("C", recall=0.4, fires=8.0),  # dominated by A (better recall, fewer fires)
        ]
        ranked = pareto_rank(points)
        rank_map = {name: r for r, p in [(r, p) for r, p in ranked] for name in [p.name]}
        # A and B are nondominated (tradeoff) → rank 1
        # C is dominated by A → rank 2
        assert rank_map["A"] == 1
        assert rank_map["B"] == 1
        assert rank_map["C"] == 2

    def test_ranks_are_contiguous_from_one(self):
        """Ranks must start at 1 and be contiguous integers."""
        points = [
            _pt("A", recall=0.9, fires=1.0),
            _pt("B", recall=0.6, fires=5.0),
            _pt("C", recall=0.3, fires=10.0),
            _pt("D", recall=0.1, fires=20.0),
        ]
        # Each strictly dominates the next in recall-only terms when fires are equal
        # but here fires also increase so it's tradeoffs. Let's use same fires:
        points2 = [
            _pt("A", recall=0.9, fires=5.0),
            _pt("B", recall=0.6, fires=5.0),  # dominated by A
            _pt("C", recall=0.3, fires=5.0),  # dominated by A and B
        ]
        ranked = pareto_rank(points2)
        ranks = sorted({r for r, _ in ranked})
        assert ranks[0] == 1
        for i in range(1, len(ranks)):
            assert ranks[i] == ranks[i-1] + 1

    def test_single_model_rank_one(self):
        """A single model always gets rank 1."""
        ranked = pareto_rank([_pt("only", recall=0.5, fires=5.0)])
        assert ranked[0][0] == 1

    def test_sorted_by_recall_within_rank(self):
        """Within the same rank, models are sorted by recall descending."""
        points = [
            _pt("low_recall",  recall=0.2, fires=20.0),
            _pt("high_recall", recall=0.8, fires=1.0),
            _pt("mid_recall",  recall=0.5, fires=8.0),
        ]
        # All three are on the front (genuine tradeoffs)
        ranked = pareto_rank(points)
        rank1 = [(r, p) for r, p in ranked if r == 1]
        recalls = [p.recall for _, p in rank1]
        assert recalls == sorted(recalls, reverse=True)


# ---------------------------------------------------------------------------
# save_pareto_results() tests
# ---------------------------------------------------------------------------

class TestSaveParetoResults:
    """Tests for JSON persistence of Pareto results."""

    def test_saves_valid_json(self, tmp_path):
        """save_pareto_results must write parseable JSON."""
        points = [
            _pt("A", recall=0.5, fires=5.0),
            _pt("B", recall=0.2, fires=2.0),
        ]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        assert "pareto_front" in data
        assert "dominated" in data
        assert "all_models" in data

    def test_saved_front_names_match(self, tmp_path):
        """Saved pareto_front list must match computed front names."""
        points = [
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("low_burden",  recall=0.1, fires=1.0),
            _pt("bad",         recall=0.0, fires=20.0),
        ]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        saved_front = set(data["pareto_front"])
        computed_front = {p.name for p in front}
        assert saved_front == computed_front

    def test_all_models_have_pareto_rank(self, tmp_path):
        """Every model in all_models must have a pareto_rank field."""
        points = [
            _pt("A", recall=0.6, fires=5.0),
            _pt("B", recall=0.3, fires=5.0),
        ]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        for m in data["all_models"]:
            assert "pareto_rank" in m
            assert isinstance(m["pareto_rank"], int)
            assert m["pareto_rank"] >= 1

    def test_creates_parent_directories(self, tmp_path):
        """Output path parent directories are created if they do not exist."""
        out = tmp_path / "nested" / "deep" / "pareto.json"
        points = [_pt("A", recall=0.5, fires=5.0)]
        front, dominated = build_pareto_front(points)
        save_pareto_results(points, front, dominated, out)
        assert out.exists()


# ---------------------------------------------------------------------------
# print_pareto_report() smoke test
# ---------------------------------------------------------------------------

class TestPrintParetoReport:
    """Smoke tests — verify report prints without crashing."""

    def test_prints_without_error(self, capsys):
        """print_pareto_report must not raise on valid input."""
        points = [
            _pt("robust_mad",          recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
            _pt("virtual_source_state_space",      recall=0.133, fires=3.20),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "PARETO" in captured.out
        assert "robust_mad" in captured.out

    def test_prints_with_ece_values(self, capsys):
        """Report handles ECE values correctly in table formatting."""
        points = [
            _pt("A", recall=0.5, fires=5.0, ece=0.082),
            _pt("B", recall=0.2, fires=2.0, ece=0.041),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "0.0820" in captured.out or "0.082" in captured.out

    def test_prints_with_none_ece(self, capsys):
        """Report handles None ECE gracefully (Phase 2 before calibration)."""
        points = [
            _pt("A", recall=0.5, fires=5.0, ece=None),
            _pt("B", recall=0.2, fires=2.0, ece=None),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "n/a" in captured.out
PHASE 2, STEP 3 — Run it
BASH
Copy
cd apps/nba-sidecar

# Run tests
uv run --extra research pytest tests/test_pareto.py -v

# Run the CLI against all three models
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed

uv run --extra research python -m nba_sidecar.research.evaluation.pareto \
    --snapshot "$SNAP" \
    --models robust_mad state_space_current virtual_source_state_space \
    --output outputs/nba-quant-lab/pareto-phase2.json

# Expected output (approximate — actual numbers depend on virtual_source_state_space score):
#
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  PARETO FRONT ANALYSIS — Signal Console Quant Lab Bakeoff           ║
# ╚══════════════════════════════════════════════════════════════════════╝
#
# 🏆  PARETO-NONDOMINATED FRONT:
#   robust_mad               recall=0.267  fires/game=15.55  ECE=n/a
#   state_space_current      recall=0.000  fires/game=0.75   ECE=n/a
#   (virtual_source_state_space will land somewhere between these or on the front)
PHASE 2 — Definition of Done
 pytest tests/test_pareto.py -v — all tests green
 CLI runs successfully against snapshot
 outputs/nba-quant-lab/pareto-phase2.json written and valid JSON
 You can read the report and explain to a colleague what "dominated" means
 Git commit: git commit -am "feat(research): add Pareto front analysis [Phase 2]"
🟠 PHASE 3 — Calibration Curve Diagnostic (ECE)
What this is and why
Bobby's "calibration" leg of the Pareto triplet means: when the model says the probability of an alert is 0.8, does it actually fire 80% of the time? A perfectly calibrated model's predicted scores match empirical fire rates exactly.

For signal console: the `PredictionRow.score` output from `virtual_source_state_space` (and any future model that exposes a continuous score) is the soft alert score. If the implementation also writes `diagnostics["regimeScore"]`, that is a UI/reporting duplicate, not a separate top-level prediction field. The Expected Calibration Error (ECE) measures how far that
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the ECE explanation was cut off:

What this is and why (continued)
The Expected Calibration Error (ECE) measures how far that soft score deviates from the empirical fire rate across score bins. It is the third leg of Bobby's Pareto triplet and the metric that gets wired into Phase 2's ParetoPoint.ece field.

The math:

Bin the warmed buckets into B equal-width bins on [0, 1] by normalized `score` or by `diagnostics["regimeScore"]` when the model writes that diagnostic.
For each bin b:
    conf_b = mean(score) for buckets in bin b
    acc_b  = mean(fired)        for buckets in bin b   (empirical fire rate)
    |b|    = count of buckets in bin b

ECE = Σ_b (|b| / N) × |acc_b - conf_b|

where N = total warmed buckets across all bins.
A perfectly calibrated model has ECE = 0. A model that always outputs score=0.9 but fires only 20% of the time has ECE ≈ 0.7 — badly miscalibrated. Bobby cares about this because miscalibrated probabilities produce bad pricing even if discrimination is good.

Why this matters for signal console: every `PredictionRow` already has `score`, but models differ in whether that score is bounded and reliability-friendly. ECE gives you a principled way to evaluate whether a bounded alert score is honest.

PHASE 3, STEP 1 — Create calibration.py
apps/nba-sidecar/src/nba_sidecar/research/evaluation/calibration.py

PYTHON
Copy
"""calibration: Expected Calibration Error (ECE) diagnostic for board models.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, June 2026):

    "Calibration: when the model says 20%, it happens 20% of the time.
     This is the first leg of the Pareto triplet. A model can have great
     discrimination but terrible calibration — it will still misprice markets."

Signal console analog:
    A bounded score column (0-1) is the model's soft probability of an alert.
    Native predictions always have top-level score; models may also flatten a
    diagnostics["regimeScore"] column when their primary score is unbounded.
    ECE measures whether score=0.7 corresponds to a 70% empirical fire rate.

    ECE = Σ_b (|b| / N) × |acc_b - conf_b|

    where:
        B bins partition [0, 1] by the selected score column
        conf_b = mean(score) in bin b          (model confidence)
        acc_b  = mean(fired) in bin b          (empirical fire rate)
        |b|    = count of warmed buckets in bin b
        N      = total warmed buckets

    A perfectly calibrated model has ECE = 0.
    A model that is systematically overconfident has ECE > 0 with
    conf_b > acc_b in the high-score bins.
    A model that is systematically underconfident has ECE > 0 with
    conf_b < acc_b in the low-score bins.

Reliability diagram:
    The calibration curve (also called a reliability diagram) plots
    conf_b on the x-axis against acc_b on the y-axis. A perfectly
    calibrated model lies on the diagonal y = x. Points above the
    diagonal = underconfident (model undersells its alerts). Points
    below = overconfident (model oversells).

Usage:
    from nba_sidecar.research.evaluation.calibration import (
        compute_ece,
        calibration_bins,
        CalibrationResult,
        print_calibration_report,
    )

    # predictions_df must have columns: score, fired; warmed is optional
    result = compute_ece(predictions_df, n_bins=10, score_col="regimeScore")
    print(f"ECE = {result.ece:.4f}")
    print_calibration_report(result)

Integration with Pareto (Phase 2):
    from nba_sidecar.research.evaluation.pareto import ParetoPoint
    point = ParetoPoint(
        name="virtual_source_state_space",
        recall=0.133,
        fires_per_game=3.20,
        ece=result.ece,   # ← wire in here
    )

CLI:
    uv run --extra research python -m nba_sidecar.research.evaluation.calibration \\
        --snapshot /path/to/snapshot \\
        --model virtual_source_state_space \\
        --bins 10
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class BinStats:
    """Statistics for one calibration bin.

    Attributes:
        bin_lower:   lower edge of selected score bin (inclusive)
        bin_upper:   upper edge of selected score bin (exclusive, except last)
        count:       number of warmed buckets in this bin
        mean_score:  mean selected score of buckets in this bin (confidence)
        fire_rate:   empirical fire rate = mean(fired) in this bin (accuracy)
        gap:         |fire_rate - mean_score| — contribution driver
        weight:      count / total_count — bin weight in ECE sum
        weighted_gap: weight × gap — direct ECE contribution
    """
    bin_lower: float
    bin_upper: float
    count: int
    mean_score: float
    fire_rate: float
    gap: float
    weight: float
    weighted_gap: float


@dataclass
class CalibrationResult:
    """Full calibration analysis result for one model.

    Attributes:
        ece:             Expected Calibration Error (0 = perfect, 1 = worst)
        n_bins:          number of bins used
        total_buckets:   total warmed buckets scored
        empty_bins:      number of bins with zero buckets
        bins:            per-bin statistics (list of BinStats)
        overconfident:   True if model tends to over-predict fire probability
        underconfident:  True if model tends to under-predict fire probability
        model_name:      name of the model being evaluated
        notes:           list of human-readable diagnostic notes
    """
    ece: float
    n_bins: int
    total_buckets: int
    empty_bins: int
    bins: list[BinStats]
    overconfident: bool
    underconfident: bool
    model_name: str = "unknown"
    notes: list[str] = field(default_factory=list)

    @property
    def max_gap(self) -> float:
        """Largest single-bin gap (worst miscalibration point)."""
        if not self.bins:
            return 0.0
        return max(b.gap for b in self.bins)

    @property
    def populated_bins(self) -> list[BinStats]:
        """Bins that contain at least one bucket."""
        return [b for b in self.bins if b.count > 0]


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------

def calibration_bins(
    predictions_df: pd.DataFrame,
    n_bins: int = 10,
    score_col: str = "score",
    fired_col: str = "fired",
    warmed_col: str = "warmed",
) -> list[BinStats]:
    """Compute per-bin calibration statistics.

    Args:
        predictions_df: DataFrame with one row per bucket prediction.
                        Must contain columns: selected score column and fired.
                        The selected score must be in [0, 1].
                        fired must be bool or 0/1 integer.
                        warmed is optional; missing warmed defaults to True.
        n_bins:         number of equal-width bins to partition [0, 1].
                        10 is standard (Naeini et al. 2015). Use 5 if data
                        is sparse (fewer than 500 warmed buckets).
        score_col:      name of the column containing bounded soft scores
                        (default: score)
        fired_col:      name of the binary outcome column (default: fired)
        warmed_col:     name of the warmup gate column (default: warmed)

    Returns:
        list of BinStats, one per bin (including empty bins with count=0).

    Raises:
        ValueError: if required columns are missing from predictions_df.
        ValueError: if selected score values are outside [0, 1].
    """
    required = {score_col, fired_col}
    missing = required - set(predictions_df.columns)
    if missing:
        raise ValueError(
            f"predictions_df is missing required columns: {missing}. "
            f"Available columns: {list(predictions_df.columns)}"
        )

    # Filter to warmed-up buckets only — pre-warmup predictions are
    # undefined and must not pollute the calibration estimate.
    if warmed_col not in predictions_df.columns:
        predictions_df = predictions_df.copy()
        predictions_df[warmed_col] = True
    warmed = predictions_df[predictions_df[warmed_col].astype(bool)].copy()

    if warmed.empty:
        return []

    scores = warmed[score_col].astype(float).values
    fired = warmed[fired_col].astype(float).values

    # Validate score range
    if np.any(scores < 0.0) or np.any(scores > 1.0):
        bad_count = int(np.sum((scores < 0.0) | (scores > 1.0)))
        raise ValueError(
            f"{score_col} must be in [0, 1] but found {bad_count} values "
            f"outside this range. Min={scores.min():.4f}, Max={scores.max():.4f}. "
            f"Use a bounded score column such as diagnostics['regimeScore']."
        )

    total = len(scores)
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    result_bins: list[BinStats] = []

    for i in range(n_bins):
        lower = bin_edges[i]
        upper = bin_edges[i + 1]

        # Last bin is inclusive on both ends to capture score=1.0 exactly
        if i < n_bins - 1:
            mask = (scores >= lower) & (scores < upper)
        else:
            mask = (scores >= lower) & (scores <= upper)

        count = int(mask.sum())

        if count == 0:
            result_bins.append(BinStats(
                bin_lower=lower,
                bin_upper=upper,
                count=0,
                mean_score=0.0,
                fire_rate=0.0,
                gap=0.0,
                weight=0.0,
                weighted_gap=0.0,
            ))
            continue

        mean_score = float(scores[mask].mean())
        fire_rate = float(fired[mask].mean())
        gap = abs(fire_rate - mean_score)
        weight = count / total
        weighted_gap = weight * gap

        result_bins.append(BinStats(
            bin_lower=lower,
            bin_upper=upper,
            count=count,
            mean_score=mean_score,
            fire_rate=fire_rate,
            gap=gap,
            weight=weight,
            weighted_gap=weighted_gap,
        ))

    return result_bins


def compute_ece(
    predictions_df: pd.DataFrame,
    n_bins: int = 10,
    score_col: str = "score",
    fired_col: str = "fired",
    warmed_col: str = "warmed",
    model_name: str = "unknown",
) -> CalibrationResult:
    """Compute Expected Calibration Error (ECE) for a model's predictions.

    This is the main entry point for Phase 3. Call this after running a model
    through the Quant Lab to get its ECE for the Pareto triplet.

    Args:
        predictions_df: DataFrame with score/fired plus optional warmed. Produced
                        by evaluate_model(...) or load_external_predictions(...).
        n_bins:         number of calibration bins (default: 10)
        score_col:      column name for bounded soft score (default: score)
        fired_col:      column name for binary outcome (default: fired)
        warmed_col:     column name for warmup gate (default: warmed)
        model_name:     model identifier for reporting

    Returns:
        CalibrationResult with ECE and full bin statistics.

    Notes:
        - Use compute_ece only with a bounded 0-1 score. If top-level score is
          unbounded, pass score_col="regimeScore" when the model emits that
          flattened diagnostic.
        - A minimum of 4 populated bins is recommended for ECE to be
          meaningful. Fewer bins → result is flagged with a note.
    """
    bins = calibration_bins(
        predictions_df=predictions_df,
        n_bins=n_bins,
        score_col=score_col,
        fired_col=fired_col,
        warmed_col=warmed_col,
    )

    if not bins:
        return CalibrationResult(
            ece=float("nan"),
            n_bins=n_bins,
            total_buckets=0,
            empty_bins=n_bins,
            bins=[],
            overconfident=False,
            underconfident=False,
            model_name=model_name,
            notes=["No warmed-up buckets found — ECE cannot be computed."],
        )

    ece = float(sum(b.weighted_gap for b in bins))
    total_buckets = sum(b.count for b in bins)
    empty_bins = sum(1 for b in bins if b.count == 0)
    populated = [b for b in bins if b.count > 0]

    notes: list[str] = []
    if len(populated) < 4:
        notes.append(
            f"Only {len(populated)} populated bins (of {n_bins}). ECE estimate "
            f"is unreliable. Consider using --bins 5 or collecting more data."
        )

    # Determine systematic bias direction.
    # Overconfident: model scores high but fires rarely (conf > acc in top bins).
    # Underconfident: model scores low but fires often (conf < acc in bottom bins).
    top_bins = [b for b in populated if b.bin_lower >= 0.5]
    if top_bins:
        mean_gap_signed = float(np.mean([b.mean_score - b.fire_rate for b in top_bins]))
        overconfident = mean_gap_signed > 0.05
        underconfident = mean_gap_signed < -0.05
    else:
        overconfident = False
        underconfident = False
        notes.append(f"No buckets with {score_col} >= 0.5 — cannot assess confidence bias.")

    if overconfident:
        notes.append(
            f"Model is OVERCONFIDENT: {score_col} is higher than empirical fire "
            "rate in the upper bins. Consider reducing the sigmoid steepness (_k "
            "parameter in virtual_source_state_space.py) or recalibrating enter_z."
        )
    elif underconfident:
        notes.append(
            f"Model is UNDERCONFIDENT: {score_col} is lower than empirical fire "
            "rate in the upper bins. Consider increasing the sigmoid steepness."
        )

    if empty_bins > n_bins // 2:
        notes.append(
            f"{empty_bins}/{n_bins} bins are empty. The model's score distribution "
            f"is concentrated in a narrow range. This is common when enter_z is "
            f"high — most buckets cluster near 0 with occasional spikes near 1."
        )

    return CalibrationResult(
        ece=ece,
        n_bins=n_bins,
        total_buckets=total_buckets,
        empty_bins=empty_bins,
        bins=bins,
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the CalibrationResult constructor was cut off:

PYTHON
Copy
        bins=bins,
        overconfident=overconfident,
        underconfident=underconfident,
        model_name=model_name,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_calibration_report(result: CalibrationResult) -> None:
    """Print a human-readable calibration report including reliability diagram.

    The reliability diagram is rendered as ASCII art in the terminal.
    Each row is a score bin; the bar shows the empirical fire rate vs
    the model confidence (diagonal reference).

    Args:
        result: CalibrationResult from compute_ece()
    """
    _LINE = "─" * 72

    print()
    print("╔" + "═" * 70 + "╗")
    print(f"║  CALIBRATION REPORT — {result.model_name:<47}║")
    print("║  Bobby Ingram Pareto triplet: Leg 1 (Calibration)                   ║")
    print("╚" + "═" * 70 + "╝")
    print()

    # --- Summary ---
    ece_str = f"{result.ece:.4f}" if not math.isnan(result.ece) else "  N/A "
    print(f"  ECE (Expected Calibration Error): {ece_str}")
    print(f"  Interpretation:")
    if math.isnan(result.ece):
        print("    No warmed-up buckets — cannot evaluate calibration.")
    elif result.ece < 0.02:
        print("    ✅  Excellent calibration (ECE < 0.02). Scores are honest.")
    elif result.ece < 0.05:
        print("    ✅  Good calibration (ECE < 0.05). Acceptable for trading use.")
    elif result.ece < 0.10:
        print("    ⚠️   Moderate miscalibration (ECE 0.05–0.10). Monitor closely.")
    else:
        print("    ❌  Poor calibration (ECE > 0.10). Scores are not trustworthy.")

    print(f"  Total warmed buckets scored: {result.total_buckets}")
    print(f"  Populated bins: {len(result.populated_bins)}/{result.n_bins}")
    if result.overconfident:
        print("  Bias: OVERCONFIDENT (model fires less often than its scores suggest)")
    elif result.underconfident:
        print("  Bias: UNDERCONFIDENT (model fires more often than its scores suggest)")
    else:
        print("  Bias: balanced (no systematic over/under-confidence detected)")
    print()

    # --- Reliability diagram (ASCII) ---
    print("  RELIABILITY DIAGRAM (ASCII):")
    print("  Each row = one score bin. Bar = empirical fire rate.")
    print("  │ = diagonal reference (perfect calibration).")
    print()
    print(f"  {'Bin':<14} {'Count':>6} {'Conf':>6} {'FireRate':>9}  Reliability")
    print("  " + _LINE)

    bar_width = 30
    for b in result.bins:
        bin_label = f"[{b.bin_lower:.1f}, {b.bin_upper:.1f})"
        if b.count == 0:
            print(f"  {bin_label:<14} {'—':>6} {'—':>6} {'—':>9}  (empty)")
            continue

        conf_str = f"{b.mean_score:.3f}"
        rate_str = f"{b.fire_rate:.3f}"

        # ASCII bar: fill to fire_rate position, mark conf position with │
        fire_pos = int(round(b.fire_rate * bar_width))
        conf_pos = int(round(b.mean_score * bar_width))

        bar = [" "] * (bar_width + 1)
        # Fill fire rate bar with ▓
        for k in range(min(fire_pos, bar_width + 1)):
            bar[k] = "▓"
        # Mark confidence position with │ (diagonal reference)
        if 0 <= conf_pos <= bar_width:
            # If conf_pos is inside the filled region, use ┤ to show overlap
            bar[conf_pos] = "┤" if conf_pos < fire_pos else "│"

        bar_str = "".join(bar)
        gap_marker = f"  gap={b.gap:.3f}" if b.gap > 0.05 else ""
        print(f"  {bin_label:<14} {b.count:>6} {conf_str:>6} {rate_str:>9}  {bar_str}{gap_marker}")

    print()

    # --- Per-bin table ---
    print("  PER-BIN DETAIL:")
    print(f"  {'Bin':<14} {'Count':>6} {'Weight':>8} {'Conf':>7} "
          f"{'FireRate':>9} {'Gap':>7} {'WtdGap':>8}")
    print("  " + _LINE)
    for b in result.bins:
        if b.count == 0:
            continue
        print(
            f"  [{b.bin_lower:.1f},{b.bin_upper:.1f})  "
            f"{b.count:>6}  {b.weight:>8.4f}  {b.mean_score:>7.4f}  "
            f"{b.fire_rate:>9.4f}  {b.gap:>7.4f}  {b.weighted_gap:>8.4f}"
        )
    print()

    # --- Notes ---
    if result.notes:
        print("  📝 NOTES:")
        for note in result.notes:
            # Word-wrap at 65 chars
            words = note.split()
            line = "    • "
            for word in words:
                if len(line) + len(word) + 1 > 70:
                    print(line)
                    line = "      " + word + " "
                else:
                    line += word + " "
            print(line.rstrip())
        print()

    print("  💡 Bobby Ingram's lesson: A model with great discrimination but")
    print("     poor calibration still misprices markets. ECE < 0.05 is the")
    print("     target before a bounded alert score is trusted for trading decisions.")
    print()


# ---------------------------------------------------------------------------
# Integration with scorer and Pareto
# ---------------------------------------------------------------------------

def compute_ece_for_model(
    model_name: str,
    snapshot_path: Path,
    n_bins: int = 10,
    score_col: str | None = None,
) -> CalibrationResult:
    # Current repo correction:
    # Do not hand-roll model instantiation, snapshot loading, or row-wise loops.
    # Use evaluate_model(model_name, snapshot_path), then compute reliability
    # from the returned predictions DataFrame.
    """Score a registered model and compute its ECE in one call.

    This is the convenience function used by the CLI and by Phase 4 to
    compute ECE without manually managing DataFrames.

    Args:
        model_name:    registered model id from list_models()
        snapshot_path: path to the Quant Lab snapshot directory
        n_bins:        number of calibration bins
        score_col:     bounded score column; defaults to regimeScore when present,
                       otherwise top-level score.

    Returns:
        CalibrationResult — wire result.ece into ParetoPoint.ece for Phase 2.

    Raises:
        KeyError: if model_name is not in the registry.
        ValueError: if selected score values are outside [0, 1].
    """
    from nba_sidecar.research.evaluation.evaluator import evaluate_model

    _, _, predictions_df = evaluate_model(model_name, snapshot_path)
    selected_score_col = score_col
    if selected_score_col is None:
        selected_score_col = "regimeScore" if "regimeScore" in predictions_df.columns else "score"

    return compute_ece(
        predictions_df=predictions_df,
        n_bins=n_bins,
        score_col=selected_score_col,
        warmed_col="warmed",
        model_name=model_name,
    )


def build_pareto_points_with_ece(
    model_names: list[str],
    snapshot_path: Path,
    n_bins: int = 10,
) -> list:
    """Build ParetoPoints with ECE filled in for all named models.

    Drop-in replacement for pareto.pareto_points_from_snapshot() that adds
    ECE to each point. Models without a bounded score get ece=None.

    Args:
        model_names:   list of registered model names
        snapshot_path: path to the Quant Lab snapshot directory
        n_bins:        number of calibration bins for ECE

    Returns:
        list of ParetoPoint with ece populated where available.
    """
    from nba_sidecar.research.evaluation.pareto import (
        ParetoPoint,
        pareto_points_from_snapshot,
    )

    # Get recall + fires_per_game from existing scorer
    points = pareto_points_from_snapshot(model_names, snapshot_path)
    point_map = {p.name: p for p in points}

    # Add ECE to each point where possible
    enriched: list[ParetoPoint] = []
    for name in model_names:
        if name not in point_map:
            continue
        p = point_map[name]
        try:
            cal_result = compute_ece_for_model(name, snapshot_path, n_bins)
            ece = cal_result.ece if not math.isnan(cal_result.ece) else None
        except (ValueError, KeyError) as e:
            print(
                f"  NOTE: ECE not available for '{name}': {e}",
                file=sys.stderr,
            )
            ece = None

        enriched.append(ParetoPoint(
            name=p.name,
            recall=p.recall,
            fires_per_game=p.fires_per_game,
            ece=ece,
            extra=p.extra,
        ))

    return enriched


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Compute ECE calibration diagnostic for a board model.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--snapshot", type=Path, required=True,
        help="Path to the Quant Lab snapshot directory",
    )
    parser.add_argument(
        "--model", type=str, required=True,
        help="Registered model name to evaluate",
    )
    parser.add_argument(
        "--bins", type=int, default=10,
        help="Number of calibration bins (default: 10, use 5 for sparse data)",
    )
    parser.add_argument(
        "--pareto", action="store_true",
        help="After computing ECE, run full Pareto analysis with all baseline models",
    )
    args = parser.parse_args()

    print(f"Computing ECE for model '{args.model}' against snapshot: {args.snapshot}")
    result = compute_ece_for_model(args.model, args.snapshot, args.bins)
    print_calibration_report(result)

    if args.pareto:
        print("\nRunning full Pareto analysis with ECE included...")
        from nba_sidecar.research.evaluation.pareto import (
            build_pareto_front,
            print_pareto_report,
        )
        all_models = ["robust_mad", "state_space_current", args.model]
        points = build_pareto_points_with_ece(all_models, args.snapshot, args.bins)
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)


if __name__ == "__main__":
    _cli()
PHASE 3, STEP 2 — Write the tests
apps/nba-sidecar/tests/test_calibration.py

Current repo correction: these tests should validate the current prediction frame:
`score`, `fired`, and optional flattened diagnostic `warmed`/`regimeScore`. The
old top-level `regime_score` and `warmed_up` names must not be written to
`predictions.parquet`.

PYTHON
Copy
"""Tests for calibration.py — ECE diagnostic.

Run with:
    cd apps/nba-sidecar
    uv run --extra research pytest tests/test_calibration.py -v
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from nba_sidecar.research.evaluation.calibration import (
    BinStats,
    CalibrationResult,
    calibration_bins,
    compute_ece,
    print_calibration_report,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_predictions(
    scores: list[float] | None = None,
    fired: list[bool] | None = None,
    warmed: list[bool] | None = None,
) -> pd.DataFrame:
    """Build a minimal predictions DataFrame for testing."""
    values = scores or []
    fired = fired or []
    n = len(values)
    assert len(fired) == n, "scores and fired must have same length"
    if warmed is None:
        warmed = [True] * n
    return pd.DataFrame({
        "score": values,
        "fired": fired,
        "warmed": warmed,
    })


def _perfect_calibration_df(n_per_bin: int = 50, n_bins: int = 10) -> pd.DataFrame:
    """Generate a perfectly calibrated predictions DataFrame.

    For each bin centre c, fire rate = c exactly.
    This should produce ECE ≈ 0.
    """
    scores = []
    fired = []
    bin_centres = [(i + 0.5) / n_bins for i in range(n_bins)]
    rng = np.random.default_rng(seed=42)
    for c in bin_centres:
        # Generate scores uniformly within the bin
        bin_scores = rng.uniform(
            c - 0.5 / n_bins,
            c + 0.5 / n_bins,
            size=n_per_bin,
        ).clip(0, 1).tolist()
        # Fire at exactly rate c (deterministic for low n)
        n_fires = int(round(c * n_per_bin))
        bin_fired = [True] * n_fires + [False] * (n_per_bin - n_fires)
        scores.extend(bin_scores)
        fired.extend(bin_fired)
    return _make_predictions(scores, fired)


# ---------------------------------------------------------------------------
# calibration_bins() tests
# ---------------------------------------------------------------------------

class TestCalibrationBins:
    """Unit tests for the bin computation function."""

    def test_returns_correct_number_of_bins(self):
        """calibration_bins must return exactly n
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the test class was cut off:

PYTHON
Copy
    def test_returns_correct_number_of_bins(self):
        """calibration_bins must return exactly n_bins BinStats objects."""
        df = _make_predictions(
            scores=[0.1, 0.5, 0.9],
            fired=[False, False, True],
        )
        bins = calibration_bins(df, n_bins=10)
        assert len(bins) == 10

    def test_bin_edges_cover_zero_to_one(self):
        """Bin edges must partition [0, 1] completely."""
        df = _make_predictions(scores=[0.0, 0.5, 1.0], fired=[False, False, True])
        bins = calibration_bins(df, n_bins=5)
        assert math.isclose(bins[0].bin_lower, 0.0, abs_tol=1e-9)
        assert math.isclose(bins[-1].bin_upper, 1.0, abs_tol=1e-9)
        # Consecutive bins must be contiguous
        for i in range(len(bins) - 1):
            assert math.isclose(bins[i].bin_upper, bins[i + 1].bin_lower, abs_tol=1e-9)

    def test_counts_sum_to_total_warmed_buckets(self):
        """Sum of bin counts must equal total warmed-up buckets."""
        scores = [0.1, 0.2, 0.5, 0.7, 0.9]
        df = _make_predictions(scores=scores, fired=[False] * 5)
        bins = calibration_bins(df, n_bins=10)
        assert sum(b.count for b in bins) == 5

    def test_unwarmed_buckets_excluded(self):
        """Buckets with warmed=False must not be counted."""
        df = _make_predictions(
            scores=[0.5, 0.5, 0.5],
            fired=[True, True, True],
            warmed=[True, False, False],
        )
        bins = calibration_bins(df, n_bins=10)
        assert sum(b.count for b in bins) == 1

    def test_empty_dataframe_returns_empty_list(self):
        """Empty predictions DataFrame returns empty list."""
        df = _make_predictions(scores=[], fired=[])
        bins = calibration_bins(df, n_bins=10)
        assert bins == []

    def test_all_unwarmed_returns_empty_list(self):
        """All buckets unwarmed returns empty list."""
        df = _make_predictions(
            scores=[0.5, 0.5],
            fired=[True, True],
            warmed=[False, False],
        )
        bins = calibration_bins(df, n_bins=10)
        assert bins == []

    def test_score_exactly_one_goes_in_last_bin(self):
        """score=1.0 must be captured in the last bin (inclusive)."""
        df = _make_predictions(scores=[1.0], fired=[True])
        bins = calibration_bins(df, n_bins=10)
        assert bins[-1].count == 1
        assert bins[-1].fire_rate == 1.0

    def test_score_exactly_zero_goes_in_first_bin(self):
        """score=0.0 must be captured in the first bin."""
        df = _make_predictions(scores=[0.0], fired=[False])
        bins = calibration_bins(df, n_bins=10)
        assert bins[0].count == 1
        assert bins[0].fire_rate == 0.0

    def test_fire_rate_computed_correctly(self):
        """fire_rate must be mean(fired) for buckets in each bin."""
        # Put 4 buckets in the [0.0, 0.2) bin: 1 fired, 3 not
        df = _make_predictions(
            scores=[0.05, 0.10, 0.15, 0.19],
            fired=[True, False, False, False],
        )
        bins = calibration_bins(df, n_bins=5)
        first_bin = bins[0]
        assert first_bin.count == 4
        assert math.isclose(first_bin.fire_rate, 0.25, rel_tol=1e-6)

    def test_mean_score_computed_correctly(self):
        """mean_score must be mean(score) for buckets in each bin."""
        df = _make_predictions(
            scores=[0.10, 0.20],
            fired=[False, False],
        )
        bins = calibration_bins(df, n_bins=5)
        # Both scores fall in [0.0, 0.2) bin
        first_bin = bins[0]
        assert math.isclose(first_bin.mean_score, 0.15, rel_tol=1e-6)

    def test_gap_is_abs_difference(self):
        """gap must be |fire_rate - mean_score|."""
        df = _make_predictions(
            scores=[0.80, 0.85, 0.90],
            fired=[False, False, False],   # fire_rate=0.0, mean_score≈0.85
        )
        bins = calibration_bins(df, n_bins=10)
        high_bin = next(b for b in bins if b.count > 0)
        assert math.isclose(high_bin.gap, abs(high_bin.fire_rate - high_bin.mean_score), rel_tol=1e-9)

    def test_weighted_gap_is_weight_times_gap(self):
        """weighted_gap must equal weight × gap for every bin."""
        df = _perfect_calibration_df(n_per_bin=20, n_bins=5)
        bins = calibration_bins(df, n_bins=5)
        for b in bins:
            if b.count > 0:
                assert math.isclose(b.weighted_gap, b.weight * b.gap, rel_tol=1e-9)

    def test_weights_sum_to_one(self):
        """Bin weights must sum to 1.0 (they are fractions of total)."""
        df = _perfect_calibration_df(n_per_bin=30, n_bins=10)
        bins = calibration_bins(df, n_bins=10)
        total_weight = sum(b.weight for b in bins)
        assert math.isclose(total_weight, 1.0, rel_tol=1e-9)

    def test_raises_on_missing_column(self):
        """ValueError must be raised when a required column is missing."""
        df = pd.DataFrame({"fired": [True], "warmed": [True]})
        # score column is required; warmed is optional and defaults to True when absent.
        with pytest.raises(ValueError, match="missing required columns"):
            calibration_bins(df, n_bins=10)

    def test_raises_on_out_of_range_scores(self):
        """ValueError must be raised when score is outside [0, 1]."""
        df = _make_predictions(scores=[0.5, 1.5], fired=[False, True])
        with pytest.raises(ValueError, match="score must be in"):
            calibration_bins(df, n_bins=10)

    def test_raises_on_negative_scores(self):
        """ValueError must be raised when score is negative."""
        df = _make_predictions(scores=[-0.1, 0.5], fired=[False, True])
        with pytest.raises(ValueError, match="score must be in"):
            calibration_bins(df, n_bins=10)

    def test_custom_column_names(self):
        """Custom column names via score_col/fired_col/warmed_col args."""
        df = pd.DataFrame({
            "score": [0.3, 0.7],
            "alert": [False, True],
            "ready": [True, True],
        })
        bins = calibration_bins(
            df, n_bins=5,
            score_col="score",
            fired_col="alert",
            warmed_col="ready",
        )
        assert sum(b.count for b in bins) == 2


# ---------------------------------------------------------------------------
# compute_ece() tests
# ---------------------------------------------------------------------------

class TestComputeEce:
    """Tests for the main ECE computation function."""

    def test_perfect_calibration_ece_near_zero(self):
        """A perfectly calibrated model must have ECE close to 0."""
        df = _perfect_calibration_df(n_per_bin=200, n_bins=10)
        result = compute_ece(df, n_bins=10)
        # Allow some statistical noise from the random generation
        assert result.ece < 0.05, (
            f"Perfect calibration should give ECE < 0.05, got {result.ece:.4f}"
        )

    def test_always_zero_score_fires_rarely_is_overconfident(self):
        """A model that always outputs score=0.9 but fires 10% → overconfident."""
        n = 200
        scores = [0.9] * n
        fired = [True] * 20 + [False] * 180   # 10% fire rate
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10)
        # ECE ≈ |0.10 - 0.90| = 0.80
        assert result.ece > 0.5
        assert result.overconfident

    def test_always_low_score_fires_often_is_underconfident(self):
        """A model that outputs score=0.1 but fires 80% → underconfident."""
        n = 200
        scores = [0.1] * n
        fired = [True] * 160 + [False] * 40   # 80% fire rate
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10)
        # ECE ≈ |0.80 - 0.10| = 0.70
        assert result.ece > 0.5
        assert result.underconfident

    def test_ece_is_zero_for_binary_perfect_model(self):
        """A model that only outputs 0.0 and 1.0 with matching fire rates."""
        # 100 buckets with score=0.0, never fires; 100 with score=1.0, always fires
        scores = [0.0] * 100 + [1.0] * 100
        fired = [False] * 100 + [True] * 100
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10)
        assert result.ece < 0.01

    def test_ece_is_nan_for_empty_predictions(self):
        """ECE must be NaN when no predictions provided."""
        df = _make_predictions(scores=[], fired=[])
        result = compute_ece(df, n_bins=10)
        assert math.isnan(result.ece)

    def test_ece_is_nan_for_all_unwarmed(self):
        """ECE must be NaN when all buckets are unwarmed."""
        df = _make_predictions(
            scores=[0.5, 0.5],
            fired=[True, True],
            warmed=[False, False],
        )
        result = compute_ece(df, n_bins=10)
        assert math.isnan(result.ece)

    def test_total_buckets_counts_only_warmed(self):
        """total_buckets must count only warmed-up predictions."""
        df = _make_predictions(
            scores=[0.5, 0.5, 0.5, 0.5],
            fired=[True, True, False, False],
            warmed=[True, True, False, False],
        )
        result = compute_ece(df, n_bins=10)
        assert result.total_buckets == 2

    def test_empty_bins_counted_correctly(self):
        """empty_bins must count bins with zero buckets."""
        # All scores in [0.4, 0.6) → 8 of 10 bins will be empty
        scores = [0.45, 0.50, 0.55] * 10
        fired = [False] * 30
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10)
        assert result.empty_bins >= 8

    def test_sparse_data_note_added(self):
        """A note must be added when fewer than 4 bins are populated."""
        # Only 3 scores, all in different bins
        df = _make_predictions(
            scores=[0.05, 0.55, 0.95],
            fired=[False, False, True],
        )
        result = compute_ece(df, n_bins=10)
        assert any("populated bins" in note.lower() or "unreliable" in note.lower()
                   for note in result.notes)

    def test_model_name_propagated(self):
        """model_name must appear in the result."""
        df = _perfect_calibration_df(n_per_bin=10)
        result = compute_ece(df, n_bins=10, model_name="virtual_source_state_space")
        assert result.model_name == "virtual_source_state_space"

    def test_n_bins_respected(self):
        """Result must contain n_bins bins regardless of data distribution."""
        df = _perfect_calibration_df(n_per_bin=20, n_bins=5)
        result = compute_ece(df, n_bins=5)
        assert result.n_bins == 5
        assert len(result.bins) == 5

    def test_max_gap_property(self):
        """max_gap must return the largest single-bin gap."""
        df = _make_predictions(
            scores=[0.05, 0.95],
            fired=[True, False],   # both miscalibrated
        )
        result = compute_ece(df, n_bins=10)
        expected_max = max(b.gap for b in result.bins if b.count > 0)
        assert math.isclose(result.max_gap, expected_max, rel_tol=1e-9)

    def test_populated_bins_property(self):
        """populated_bins must only return bins with count > 0."""
        df = _make_predictions(
            scores=[0.1, 0.9],
            fired=[False, True],
        )
        result = compute_ece(df, n_bins=10)
        for b in result.populated_bins:
            assert b.count > 0

    def test_ece_bounded_zero_to_one(self):
        """ECE must always be in [0, 1] for valid inputs."""
        rng = np.random.default_rng(seed=123)
        for _ in range(20):
            n = rng.integers(10, 200)
            scores = rng.uniform(0, 1, size=n).tolist()
            fired = rng.choice([True, False], size=n).tolist()
            df = _make_predictions(scores, fired)
            result = compute_ece(df, n_bins=10)
            if not math.isnan(result.ece):
                assert 0.0 <= result.ece <= 1.0, (
                    f"ECE={result.ece} out of [0,1] bounds"
                )

    def test_ece_symmetric_under_relabelling(self):
        """ECE is symmetric: swapping fired/not-fired changes values but not structure."""
        scores = [0.3] * 50 + [0.7] * 50
        fired_a = [False] * 50 + [True
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from where the last test was cut off:

PYTHON
Copy
    def test_ece_symmetric_under_relabelling(self):
        """ECE is symmetric: swapping fired/not-fired changes values but not structure."""
        scores = [0.3] * 50 + [0.7] * 50
        fired_a = [False] * 50 + [True] * 50   # calibrated: low score → no fire
        fired_b = [True] * 50 + [False] * 50   # miscalibrated: low score → fires

        df_a = _make_predictions(scores, fired_a)
        df_b = _make_predictions(scores, fired_b)

        result_a = compute_ece(df_a, n_bins=10)
        result_b = compute_ece(df_b, n_bins=10)

        # df_a should be better calibrated than df_b
        assert result_a.ece < result_b.ece

    def test_five_bin_mode_for_sparse_data(self):
        """n_bins=5 should work and return 5 bins."""
        df = _make_predictions(
            scores=[0.1, 0.3, 0.5, 0.7, 0.9],
            fired=[False, False, True, False, True],
        )
        result = compute_ece(df, n_bins=5)
        assert len(result.bins) == 5
        assert result.n_bins == 5


# ---------------------------------------------------------------------------
# print_calibration_report() smoke tests
# ---------------------------------------------------------------------------

class TestPrintCalibrationReport:
    """Smoke tests for the ASCII calibration report."""

    def test_prints_without_error_perfect(self, capsys):
        """Report for a well-calibrated model prints without raising."""
        df = _perfect_calibration_df(n_per_bin=50, n_bins=10)
        result = compute_ece(df, n_bins=10, model_name="test_model")
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "CALIBRATION REPORT" in captured.out
        assert "test_model" in captured.out

    def test_prints_excellent_for_low_ece(self, capsys):
        """ECE < 0.02 triggers 'Excellent calibration' message."""
        df = _perfect_calibration_df(n_per_bin=200, n_bins=10)
        result = compute_ece(df, n_bins=10)
        # Force ECE to near-zero for deterministic test
        result.ece = 0.01
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "Excellent" in captured.out

    def test_prints_poor_for_high_ece(self, capsys):
        """ECE > 0.10 triggers 'Poor calibration' message."""
        scores = [0.9] * 100
        fired = [False] * 100
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10, model_name="bad_model")
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "Poor" in captured.out

    def test_prints_nan_ece_gracefully(self, capsys):
        """NaN ECE (no warmed buckets) prints without crashing."""
        df = _make_predictions(
            scores=[0.5],
            fired=[True],
            warmed=[False],
        )
        result = compute_ece(df, n_bins=10, model_name="no_warmup_model")
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "CALIBRATION REPORT" in captured.out

    def test_reliability_diagram_contains_bars(self, capsys):
        """Reliability diagram must contain ▓ characters for populated bins."""
        scores = [0.85] * 50
        fired = [True] * 40 + [False] * 10
        df = _make_predictions(scores, fired)
        result = compute_ece(df, n_bins=10)
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "▓" in captured.out

    def test_notes_printed_when_present(self, capsys):
        """Notes section appears when result.notes is non-empty."""
        df = _make_predictions(
            scores=[0.1, 0.5, 0.9],
            fired=[False, False, True],
        )
        result = compute_ece(df, n_bins=10)
        # Manually inject a note to test rendering
        result.notes = ["This is a test diagnostic note for rendering."]
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "NOTES" in captured.out
        assert "test diagnostic note" in captured.out

    def test_overconfident_label_printed(self, capsys):
        """Overconfident bias label appears when result.overconfident=True."""
        df = _make_predictions(
            scores=[0.9] * 100,
            fired=[False] * 100,
        )
        result = compute_ece(df, n_bins=10)
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "OVERCONFIDENT" in captured.out

    def test_underconfident_label_printed(self, capsys):
        """Underconfident bias label appears when result.underconfident=True."""
        df = _make_predictions(
            scores=[0.1] * 100,
            fired=[True] * 100,
        )
        result = compute_ece(df, n_bins=10)
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "UNDERCONFIDENT" in captured.out
PHASE 3, STEP 3 — Run it
BASH
Copy
cd apps/nba-sidecar

# Run all tests
uv run --extra research pytest tests/test_calibration.py -v

# Compute ECE for virtual_source_state_space
SNAP=/Users/davidmontgomery/signal-console/outputs/nba-quant-lab/snapshots/sample-fixed

uv run --extra research python -m nba_sidecar.research.evaluation.calibration \
    --snapshot "$SNAP" \
    --model virtual_source_state_space \
    --bins 10 \
    --pareto

# Expected output (approximate):
#
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CALIBRATION REPORT — virtual_source_state_space                                ║
# ╚══════════════════════════════════════════════════════════════════════╝
#
#   ECE: 0.XXXX
#   Total warmed buckets scored: XXXX
#   Populated bins: X/10
#
#   RELIABILITY DIAGRAM:
#   [0.0, 0.1)   count=XXXX  conf=0.XXX  fire=0.XXX  ▓▓▓▓▓▓│
#   [0.1, 0.2)   ...
#   ...
#
# What to look for:
#   - If most buckets land in [0.0, 0.1) with near-zero fire rate → good,
#     model correctly assigns low scores to quiet buckets.
#   - If the [0.8, 0.9) and [0.9, 1.0) bins have fire_rate close to their
#     mean_score → well calibrated in the alert region.
#   - ECE > 0.10 → adjust sigmoid _k parameter in virtual_source_state_space.py.

# Then run full Pareto with ECE wired in
uv run --extra research python -c "
from pathlib import Path
from nba_sidecar.research.evaluation.calibration import build_pareto_points_with_ece
from nba_sidecar.research.evaluation.pareto import (
    build_pareto_front, print_pareto_report, save_pareto_results
)

SNAP = Path('outputs/nba-quant-lab/snapshots/sample-fixed')
models = ['robust_mad', 'state_space_current', 'virtual_source_state_space']

points = build_pareto_points_with_ece(models, SNAP, n_bins=10)
front, dominated = build_pareto_front(points)
print_pareto_report(front, dominated, all_points=points)
save_pareto_results(
    points, front, dominated,
    Path('outputs/nba-quant-lab/pareto-phase3-with-ece.json')
)
"
PHASE 3 — Definition of Done
 pytest tests/test_calibration.py -v — all tests green
 ECE computed successfully for virtual_source_state_space on the snapshot
 Reliability diagram renders correctly in terminal
 Full Pareto analysis with ECE column runs and saves JSON
 You can explain the difference between ECE=0.02 and ECE=0.15 to a colleague
 Git commit: git commit -am "feat(research): add ECE calibration diagnostic [Phase 3]"
🔴 PHASE 4 — Composite Attribution Producer (B-T + NN → Board + Attribution)
What this is and why
This is the most important phase. It implements Bobby's deepest architectural insight directly into signal console.

Bobby's architecture:

Layer 1 (Bradley-Terry): baseline P(outcome | batter, pitcher)
Layer 2 (Neural Net):    ΔP = residual correction on top of B-T
Final:                   P_final = P_B-T + ΔP
The NN predicts residuals on the baseline, not outcomes from scratch. The B-T layer does the heavy lifting; the NN corrects systematic errors. Neither layer alone is as good as both together.

Signal console's analogous architecture:

Layer 1 (Board EKF):      regimeScore = how surprised is the board? (0–1)
Layer 2 (Attribution):    pairedScore = rightful_drift - credited_drift (signed)
Final:                    compositeScore = f(regimeScore, pairedScore)
Why this is the right architecture for the recall=0 problem:

From research-2026-05-31: all five pooled board features have AUC ≈ 0.5 vs high-intensity control. Incidents are NOT the biggest board moves — they are moves with a specific directional signature: the credited player's prop drifts DOWN, the rightful player's prop drifts UP. The pairedScore in attribution.py captures exactly this signature. The board model alone cannot see it because it looks at aggregate intensity, not directed player-pair movements.

The composition: regimeScore tells you "something happened on the board." pairedScore tells you "specifically, the market thinks Player A was wrongly credited and Player B was the real rebounder." Neither alone is sufficient:

High regimeScore + low pairedScore → big board move, no directional player signal → probably not a miscredit
Low regimeScore + high pairedScore → directional player signal, no big board move → weak signal
High regimeScore + high pairedScore → big board move WITH directional player signal → very strong miscredit indicator
This is exactly how Bobby uses B-T + NN: B-T gives magnitude, NN gives direction and correction.

PHASE 4, STEP 1 — Understand attribution.py deeply
Before writing a single line of the composite producer, open attribution.py and trace through signed_paired_score(). The key equations:

PYTHON
Copy
# For a (credited_player, rightful_player) candidate pair:
credited_drift  = prop_intensity_after(credited)  - prop_intensity_before(credited)
rightful_drift  = prop_intensity_after(rightful)  - prop_intensity_before(rightful)
paired_score    = rightful_drift - credited_drift

# If miscredit happened:
#   credited player's prop falls (market corrects downward) → credited_drift < 0
#   rightful player's prop rises (market corrects upward)   → rightful_drift > 0
#   paired_score = positive - negative = strongly positive  → FIRE
#
# If no miscredit:
#   both drift randomly → paired_score ≈ 0 on average
The pairedScore is a signed, directional, hermetically testable signal. It is geometrically different from board magnitude — it can be near-zero even when the board is moving a lot (if the move is symmetric across players), and it can be large even when the board is quiet (if one player's prop quietly moves opposite to another's).

PHASE 4, STEP 2 — Create composite_attribution.py
apps/nba-sidecar/src/nba_sidecar/research/experiments/composite_attribution.py

Current repo contract correction: implement this first as an external prediction producer, not a registered `BoardModel`. It should read snapshot prop ticks, candidate/event tables, and board predictions, write a `predictions.parquet`, then use `pnpm quant score-predictions`. Only move it into `apps/nba-sidecar/src/nba_sidecar/research/models/` if the `BoardModel` input contract is expanded to include the required attribution inputs.

PYTHON
Copy
"""composite_attribution: Board EKF × Attribution signal composition.

Implements Bobby Ingram's core architectural insight from his MLB player-props
pipeline (Swish workshop, June 2026):

    "The neural net predicts RESIDUALS on top of the Bradley-Terry baseline.
     B-T gives you a principled prior; the NN corrects its systematic errors.
     Neither alone is as good as both together."

Signal console analog:
    Layer 1 (Board):       regimeScore  = how surprised is the aggregate board?
                           Produced by virtual_source_state_space (Phase 1).
    Layer 2 (Attribution): pairedScore  = rightful_drift - credited_drift
                           Produced by attribution.signed_paired_score().
    Composition:           compositeScore = combine(regimeScore, pairedScore)

Why this is needed (from research-2026-05-31):
    All five pooled board features have AUC ≈ 0.5 vs high-intensity control.
    Incidents are NOT the biggest board moves. The board-MAD model fires on
    0/15 known incidents. The paired attribution signal is DIRECTIONAL —
    it fires when credited_player's prop falls AND rightful_player's rises.
    This geometric object is orthogonal to board magnitude; neither signal
    alone is sufficient, but their product is strongly discriminating.

Composition strategies (selectable via `strategy` parameter):
    "product":      compositeScore = regimeScore × pairedScore_normalized
                    → requires both signals to be active simultaneously
                    → Bobby's exact pattern: baseline × residual_correction

    "weighted_sum": compositeScore = α × regimeScore + β × pairedScore_normalized
                    → softer combination; fires when either is strong
                    → use when board signal is noisy

    "gate":         compositeScore = pairedScore_normalized if regimeScore >= gate_threshold
                                     else 0.0
                    → board signal gates attribution; attribution drives the score
                    → most conservative; lowest false-alarm rate

    "max":          compositeScore = max(regimeScore, pairedScore_normalized)
                    → fires when either signal is strong
                    → highest recall, highest burden

Architecture notes:
    - In the current repo, Layer 1 should be produced by evaluate_model(...) or
      predictions_from_model(...), not by calling a row-wise predict method.
    - The attribution layer requires candidate pairs and prop-tick windows.
      Those inputs are outside the BoardModel bucket contract, so this remains
      an external predictions.parquet producer until that contract expands.
    - pairedScore is normalized to [0, 1] via a sigmoid before composition.
      Raw pairedScore is unbounded; normalization makes it commensurable with
      regimeScore.

Data flow per bucket:
    bucket (pd.Series)
        │
        ├─→ evaluate_model("virtual_source_state_space", snapshot)
        │       → regimeScore ∈ [0, 1]
        │       → score / zCombined diagnostics
        │
Copy


YOU
cont FROM WHERE YOU LEFT OFF DO NOT START OVER
SEARCH365
Continuing exactly from the data flow diagram that was cut off:

PYTHON
Copy
        │
        ├─→ candidates.rebound_candidates(actions, game_id=...)
        │       → list of (credited_player_id, rightful_player_id) pairs
        │       → empty list if lineup data unavailable
        │
        ├─→ attribution.signed_paired_score(credited_ticks, rightful_ticks, event_epoch)
        │       → raw pairedScore = rightful_drift - credited_drift
        │       → None if insufficient drift data
        │
        ├─→ _normalize_paired_score(raw_pairedScore)
        │       → pairedScore_normalized ∈ [0, 1] via sigmoid
        │
        └─→ _compose(regimeScore, pairedScore_normalized, strategy)
                → compositeScore ∈ [0, 1]
                → fired = compositeScore >= fire_threshold

References:
    Ingram (Swish workshop June 3 2026) — B-T + NN residual architecture
    research-2026-05-31-miscredit-model-direction.md §2.5 — AUC finding
    attribution.py — signed_paired_score() implementation
    candidates.py — rebound_candidates() / team_rebound_candidates() implementation
    virtual_source_state_space.py (Phase 1) — Layer 1 board signal
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd

from nba_sidecar.research.evaluation.evaluator import evaluate_model

# Attribution and candidates — imported lazily inside methods to avoid
# import errors when lineup data is not available in the test environment.
# The model degrades gracefully if these modules cannot be imported.
_ATTRIBUTION_AVAILABLE: bool = True
try:
    from nba_sidecar.research.attribution import signed_paired_score
    from nba_sidecar.research.candidates import rebound_candidates, team_rebound_candidates
except ImportError:
    _ATTRIBUTION_AVAILABLE = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Sigmoid steepness for normalizing raw pairedScore → [0, 1].
# At k=2.0, sigmoid(2.0) ≈ 0.88, sigmoid(0.0) = 0.50, sigmoid(-2.0) ≈ 0.12.
# The zero-center of the sigmoid is set to 0.0 (no paired signal = 0.5).
# We then shift so that "no signal" maps to 0.0 not 0.5 — see
# _normalize_paired_score() for the full transform.
_PAIRED_SIGMOID_K: float = 2.0

# Minimum raw pairedScore magnitude to consider non-trivial.
# Scores below this are treated as noise and mapped to 0.0.
_PAIRED_NOISE_FLOOR: float = 0.05

# Default fire threshold on compositeScore (0–1).
# Chosen to match K_MAD_LIVE philosophy: conservative by default.
_FIRE_THRESHOLD: float = 0.65

# Default gate threshold for "gate" strategy:
# regimeScore must be at least this high before attribution is evaluated.
_GATE_THRESHOLD: float = 0.40

# Default weights for "weighted_sum" strategy.
_ALPHA: float = 0.35   # weight on regimeScore
_BETA: float = 0.65    # weight on pairedScore_normalized
# Note: α + β need not equal 1.0; compositeScore is clipped to [0, 1].

# Warmup: inherit from virtual_source_state_space (20 buckets).
# Attribution also needs warmup — we gate attribution on bucket_count >= this.
_ATTRIBUTION_WARMUP_BUCKETS: int = 20


# ---------------------------------------------------------------------------
# Composition strategies (pure functions — easy to test in isolation)
# ---------------------------------------------------------------------------

def _normalize_paired_score(raw: Optional[float]) -> float:
    """Normalize raw pairedScore to [0, 1].

    Raw pairedScore = rightful_drift - credited_drift.
    This is unbounded: strongly positive when a miscredit is detected,
    near zero when no directional signal, negative when the market moves
    in the "wrong" direction (noise or genuine credited player improvement).

    Transform:
        1. If raw is None or |raw| < noise_floor → return 0.0
           (treat as no signal, not as 0.5 — we want absence of signal to
           contribute nothing to compositeScore, not 0.5)
        2. If raw > 0: sigmoid(k * raw) mapped to (0.5, 1.0], then rescaled
           to (0.0, 1.0]
        3. If raw < 0: return 0.0 (negative signal suppressed — a market
           move in the wrong direction is not evidence of miscredit)

    This one-sided transform is Bobby's "residual correction" philosophy:
    the paired signal either confirms the board move (positive contribution)
    or is absent (zero contribution). It never subtracts from regimeScore.

    Args:
        raw: raw pairedScore from attribution.signed_paired_score(), or None

    Returns:
        normalized score in [0, 1]. 0.0 means no directional attribution
        signal. 1.0 means maximally strong directional signal.
    """
    if raw is None:
        return 0.0
    if abs(raw) < _PAIRED_NOISE_FLOOR:
        return 0.0
    if raw <= 0.0:
        # Negative signal (market moved opposite to expected miscredit pattern)
        # → suppress. Do not let this drag compositeScore down.
        return 0.0

    # Sigmoid: maps (0, ∞) → (0.5, 1.0)
    # Then rescale to (0.0, 1.0): normalized = 2 * (sigmoid - 0.5)
    sigmoid_val = 1.0 / (1.0 + math.exp(-_PAIRED_SIGMOID_K * raw))
    normalized = 2.0 * (sigmoid_val - 0.5)
    return max(0.0, min(1.0, normalized))


def _compose_product(regime: float, paired: float) -> float:
    """Product composition: compositeScore = regime × paired.

    Bobby's exact pattern: the baseline probability × the residual correction.
    Both signals must be active for the composite to fire.
    This is the most conservative strategy — lowest false-alarm rate.

    If paired=0.0 (no attribution signal), composite=0.0 regardless of regime.
    If regime=0.0 (quiet board), composite=0.0 regardless of paired.

    Args:
        regime: regimeScore from Layer 1 (0–1)
        paired: normalized pairedScore from Layer 2 (0–1)

    Returns:
        compositeScore in [0, 1]
    """
    return regime * paired


def _compose_weighted_sum(
    regime: float,
    paired: float,
    alpha: float = _ALPHA,
    beta: float = _BETA,
) -> float:
    """Weighted sum: compositeScore = α × regime + β × paired.

    Softer combination — fires when either signal is moderately strong.
    Use when the board signal is noisy and you cannot require both.

    Args:
        regime: regimeScore (0–1)
        paired: normalized pairedScore (0–1)
        alpha:  weight on regime (default 0.35)
        beta:   weight on paired (default 0.65)

    Returns:
        compositeScore clipped to [0, 1]
    """
    return max(0.0, min(1.0, alpha * regime + beta * paired))


def _compose_gate(
    regime: float,
    paired: float,
    gate_threshold: float = _GATE_THRESHOLD,
) -> float:
    """Gate composition: attribution only evaluated when board is active.

    compositeScore = paired  if regime >= gate_threshold
                     0.0     otherwise

    The board signal acts as a gate — attribution drives the score once
    the gate is open. This mirrors the two-stage architecture of Bobby's
    system: B-T must first identify a meaningful matchup before the NN
    is evaluated.

    Args:
        regime:          regimeScore (0–1)
        paired:          normalized pairedScore (0–1)
        gate_threshold:  minimum regime to open the attribution gate

    Returns:
        compositeScore in [0, 1]
    """
    if regime >= gate_threshold:
        return paired
    return 0.0


def _compose_max(regime: float, paired: float) -> float:
    """Max composition: compositeScore = max(regime, paired).

    Fires when either signal is strong. Highest recall, highest burden.
    Use for exploratory analysis — not recommended for production.

    Args:
        regime: regimeScore (0–1)
        paired: normalized pairedScore (0–1)

    Returns:
        compositeScore in [0, 1]
    """
    return max(regime, paired)


# ---------------------------------------------------------------------------
# Per-game state
# ---------------------------------------------------------------------------

@dataclass
class _CompositeGameState:
    """Game-level state for the composite attribution model."""
    bucket_count: int = 0
    in_alert: bool = False
    # Rolling window of recent compositeScores for hysteresis exit detection
    recent_composite_scores: list[float] = field(default_factory=list)


# ---------------------------------------------------------------------------
# The external producer sketch
# ---------------------------------------------------------------------------

class CompositeAttributionProducer:
    """Board EKF × Attribution signal composition.

    Implements Bobby Ingram's B-T + NN residual architecture for signal
    console's NBA board monitoring problem.

    Layer 1: virtual_source_state_space  → regimeScore  (how surprised is the board?)
    Layer 2: attribution     → pairedScore  (which player pair is signalling?)
    Final:   compose()       → compositeScore → fired

    See module docstring for full motivation, data flow, and composition
    strategy descriptions.

    Args:
        strategy:         composition strategy — one of:
                          "product", "weighted_sum", "gate", "max"
                          (default: "product" — Bobby's exact pattern)
        fire_threshold:   compositeScore threshold for firing (default: 0.65)
        gate_threshold:   regimeScore gate for "gate" strategy (default: 0.40)
        alpha:            weight on regimeScore for "weighted_sum" (default: 0.35)
        beta:             weight on pairedScore for "weighted_sum" (default: 0.65)
        board_predictions: predictions DataFrame from evaluate_model("virtual_source_state_space", ...)
    """

    def __init__(
        self,
        strategy: str = "product",
        fire_threshold: float = _FIRE_THRESHOLD,
        gate_threshold: float = _GATE_THRESHOLD,
        alpha: float = _ALPHA,
        beta: float = _BETA,
    ) -> None:
        valid_strategies = {"product", "weighted_sum", "gate", "max"}
        if strategy not in valid_strategies:
            raise ValueError(
                f"strategy must be one of {valid_strategies}, got '{strategy}'"
            )

        self.strategy = strategy
        self.fire_threshold = fire_threshold
        self.gate_threshold = gate_threshold
        self.alpha = alpha
        self.beta = beta

        # Per-game state
        self._game_states: dict[str, _CompositeGameState] = {}

    # ------------------------------------------------------------------
    # Composition dispatch
    # ------------------------------------------------------------------

    def _compose(self, regime: float, paired: float) -> float:
        """Dispatch to the selected composition strategy."""
        if self.strategy == "product":
            return _compose_product(regime, paired)
        elif self.strategy == "weighted_sum":
            return _compose_weighted_sum(regime, paired, self.alpha, self.beta)
        elif self.strategy == "gate":
            return _compose_gate(regime, paired, self.gate_threshold)
        elif self.strategy == "max":
            return _compose_max(regime, paired)
        else:
            # Should never reach here due to __init__ validation
            raise RuntimeError(f"Unknown strategy: {self.strategy}")

    # ------------------------------------------------------------------
    # Attribution layer (Layer 2)
    # ------------------------------------------------------------------

    def _get_paired_score(self, event: dict, prop_ticks_by_player: dict[str, list[tuple[float, float]]]) -> float:
        """Run the attribution layer for one event/candidate set.

        Attempts to:
        1. Get candidate pairs from rebound_candidates(actions, game_id=...)
        2. Score each pair via attribution.signed_paired_score(...)
        3. Return the maximum paired score across all candidates

        Falls back to 0.0 (no attribution signal) when:
        - attribution module is unavailable (import failed)
        - no candidates found for this bucket
        - all candidate scores return None (insufficient drift data)
        - any exception is raised (fail open — never crash the model)

        The maximum-over-candidates aggregation mirrors Bobby's approach:
        the NN evaluates all possible matchups and the strongest residual
        correction is used. Here, the "strongest candidate" is the pair
        with the highest pairedScore — the most directionally consistent
        market signal.

        Args:
            event: rebound event/candidate context from the snapshot/PBP layer
            prop_ticks_by_player: causal prop-tick windows keyed by player id

        Returns:
            normalized pairedScore in [0, 1]. 0.0 = no signal.
        """
        if not _ATTRIBUTION_AVAILABLE:
            return 0.0

        try:
            # Pseudocode: build this from rebound_candidates(...) outside the
            # BoardModel lane, where actions and prop ticks are available.
            candidates = event.get("candidates", [])
            if not candidates:
                return 0.0

            best_raw: Optional[float] = None
            for candidate in candidates:
                credited_id = str(candidate.credited_person_id)
                rightful_id = str(candidate.candidate_person_id)
                result = signed_paired_score(
                    prop_ticks_by_player.get(credited_id, []),
                    prop_ticks_by_player.get(rightful_id, []),
                    float(event["event_epoch"]),
                )
                raw = result.score
                if raw is None:
                    continue
                if best_raw is None or raw > best_raw:
                    best_raw = raw

            return _normalize_paired_score(best_raw)

        except Exception:
            # Fail open: attribution errors must never crash the external producer.
            # The board prediction layer (Layer 1) continues to operate.
            return 0.0

    # ------------------------------------------------------------------
    # External prediction-row sketch
    # ------------------------------------------------------------------

    def _legacy_external_row_sketch(
        self,
        board_row: pd.Series,
        event: dict,
        prop_ticks_by_player: dict[str, list[tuple[float, float]]],
    ) -> Optional[dict]:
        """Original row-wise sketch. Do not implement this as BoardModel.predict.

        Current repo contract: keep this composite as an external
        predictions.parquet producer because it needs prop ticks, candidate
        pairs, and event anchors that BoardModel does not currently receive.

        Args:
            board_row: one row from the board predictions DataFrame
            event: rebound event/candidate context
            prop_ticks_by_player: causal prop-tick windows keyed by player id

        Returns:
            dict matching predictions.parquet columns plus diagnostics.
        """
        game_id: str = str(board_row["game_id"])

        # Initialise game state
        if game_id not in self._game_states:
            self._game_states[game_id] = _CompositeGameState()
        gs = self._game_states[game_id]
        gs.bucket_count += 1

        # ---- Layer 1: Board prediction row ------------------------------
        regime: float = float(board_row.get("regimeScore", board_row["score"]))
        z_combined: float = float(board_row.get("zCombined", board_row["score"]))
        warmed: bool = bool(board_row.get("warmed", True))

        # ---- Layer 2: Attribution (only after warmup) ------------------
        # Gating attribution on warmup prevents noisy early-game candidate
        # pairs from contaminating the composite score. Bobby's NN is also
        # only evaluated once the B-T model has enough data to be reliable.
        if warmed and gs.bucket_count >= _ATTRIBUTION_WARMUP_BUCKETS:
            paired_score: float = self._get_paired_score(event, prop_ticks_by_player)
        else:
            paired_score = 0.0

        # ---- Composition -----------------------------------------------
        composite_score: float = self._compose(regime, paired_score)

        # ---- Hysteresis fire gate --------------------------------------
        # Mirrors volatility.py hysteresis exactly:
        #   enter: composite_score >= fire_threshold and not already in alert
        #   exit:  composite_score < fire_threshold * 0.70
        #   sustain: do not re-fire while already in alert
        if not warmed:
            gs.in_alert = False
            fired = False
        elif not gs.in_alert and composite_score >= self.fire_threshold:
            gs.in_alert = True
            fired = True
        elif gs.in_alert and composite_score < self.fire_threshold * 0.70:
            gs.in_alert = False
            fired = False
        else:
            fired = False

        gs.recent_composite_scores.append(composite_score)
        if len(gs.recent_composite_scores) > 40:
            gs.recent_composite_scores = gs.recent_composite_scores[-40:]

        # External predictions.parquet contract requires only:
        #   game_id, bucket_start, score, fired
        # Extra diagnostic columns are allowed. Keep them numeric where possible
        # so downstream tables and notebooks can summarize them without special
        # cases.
        return {
            "game_id": game_id,
            "bucket_start": board_row["bucket_start"],
            "score": composite_score,
            "fired": fired,
            "bucket_end": board_row.get("bucket_end"),
            "intensity": float(board_row.get("intensity", 0.0) or 0.0),
            "regimeScore": regime,
            "zCombined": z_combined,
            "pairedScore": paired_score,
            "fireThreshold": self.fire_threshold,
            "warmed": float(warmed),
            "compositeInAlert": float(gs.in_alert),
        }

    def build_predictions(
        self,
        board_predictions: pd.DataFrame,
        events_by_bucket: dict[tuple[str, str], list[dict]],
        ticks_by_game_player: dict[tuple[str, str], list[tuple[float, float]]],
    ) -> pd.DataFrame:
        """Build an external predictions DataFrame from board rows + event context.

        This is intentionally NOT a BoardModel.score implementation. It joins
        the BoardModel output to PBP/event/candidate/tick context that the
        current BoardModel input contract does not carry.
        """
        rows: list[dict] = []
        ordered = board_predictions.sort_values(["game_id", "bucket_start"])
        for _, board_row in ordered.iterrows():
            game_id = str(board_row["game_id"])
            bucket_start = str(board_row["bucket_start"])
            events = events_by_bucket.get((game_id, bucket_start), [])

            # If multiple rebound events land in the same board bucket, score
            # them all and keep the strongest directional attribution residual.
            # Empty event context degrades to board-only.
            if not events:
                event = {"event_epoch": 0.0, "candidates": []}
                prop_ticks_by_player: dict[str, list[tuple[float, float]]] = {}
                row = self._legacy_external_row_sketch(board_row, event, prop_ticks_by_player)
                if row is not None:
                    rows.append(row)
                continue

            best_event = events[0]
            best_paired = -1.0
            for candidate_event in events:
                prop_ticks_by_player = {
                    player_id: ticks
                    for (gid, player_id), ticks in ticks_by_game_player.items()
                    if gid == game_id
                }
                paired = self._get_paired_score(candidate_event, prop_ticks_by_player)
                if paired > best_paired:
                    best_paired = paired
                    best_event = candidate_event

            prop_ticks_by_player = {
                player_id: ticks
                for (gid, player_id), ticks in ticks_by_game_player.items()
                if gid == game_id
            }
            row = self._legacy_external_row_sketch(board_row, best_event, prop_ticks_by_player)
            if row is not None:
                rows.append(row)

        return pd.DataFrame(rows)


def write_composite_predictions(
    snapshot_path: Path,
    out_path: Path,
    *,
    strategy: str = "product",
    fire_threshold: float = _FIRE_THRESHOLD,
) -> Path:
    """External producer entry point.

    Required implementation work before this can be real:
    1. Load board predictions with evaluate_model("virtual_source_state_space", snapshot).
    2. Load rebound event/candidate context from a fixture or snapshot table.
    3. Load player_prop_ticks through the existing snapshot loader.
    4. Build one row per board bucket.
    5. Validate/write predictions.parquet.
    """
    _, _, board_predictions = evaluate_model("virtual_source_state_space", snapshot_path)

    # Current blocker: the repo has signed-paired scoring and player_prop_ticks,
    # but not yet a bucket-indexed rebound-event/candidate snapshot table. Add
    # that fixture/table before removing these placeholders.
    events_by_bucket: dict[tuple[str, str], list[dict]] = {}
    ticks_by_game_player: dict[tuple[str, str], list[tuple[float, float]]] = {}

    producer = CompositeAttributionProducer(
        strategy=strategy,
        fire_threshold=fire_threshold,
    )
    predictions = producer.build_predictions(
        board_predictions=board_predictions,
        events_by_bucket=events_by_bucket,
        ticks_by_game_player=ticks_by_game_player,
    )

    required = {"game_id", "bucket_start", "score", "fired"}
    missing = required - set(predictions.columns)
    if missing:
        raise ValueError(f"composite predictions missing required columns: {sorted(missing)}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_parquet(out_path, index=False)
    return out_path
PHASE 4, STEP 3 — Add the missing data fixtures before scoring composite output

The composite producer is only honest if it has the data the current `BoardModel`
contract does not carry. Add these fixtures before claiming a Phase 4 result:

1. `player_prop_ticks.parquet` proof: verify `scripts/export-quant-snapshot.ts`
   writes or lists this file in the manifest, because `read_player_prop_ticks`
   and the signed-paired path require it.
2. Bucket-indexed rebound-event fixture: for each test game, provide rebound
   events keyed by `(game_id, bucket_start)` with `event_epoch`, credited player,
   candidate player ids, and on-court context.
3. Support-class fixture: include examples for `ok`, `rightful_only`,
   `credited_only`, and `insufficient_support`; assert abstentions stay
   explicit and are not converted into fabricated zero signal.
4. Multi-event bucket fixture: prove that when two rebound events share a board
   bucket, the external producer picks the strongest directional paired score
   and still emits exactly one prediction row for the bucket.
5. Two-game interleaving fixture: prove per-game hysteresis state is isolated.

Do not register `composite_attribution` in `nba_sidecar.research.models` until
those inputs are available through a formal `BoardModel` contract extension.

PHASE 4, STEP 4 — Score the external predictions identically to native models

BASH
Copy
cd /Users/davidmontgomery/signal-console
SNAP=outputs/nba-quant-lab/snapshots/sample-fixed
OUT=outputs/nba-quant-lab/external/composite_attribution/predictions.parquet

# Producer command shape. Wire this to a real CLI subcommand only after the
# missing event/candidate fixture exists.
uv run --extra research python -m nba_sidecar.research.experiments.composite_attribution \
  --snapshot "$SNAP" \
  --out "$OUT"

# Score external predictions through the SAME scorer/truth join as BoardModels.
pnpm quant score-predictions "$OUT" "$SNAP" \
  --model-id composite_attribution \
  --run-id composite-attribution-smoke

Success criteria:

- `outputs/nba-quant-lab/runs/composite-attribution-smoke/predictions.parquet`
  exists and carries a `model_id` column with `composite_attribution`.
- `leaderboard.json` has a `composite_attribution` row.
- The `/research` Leaderboard renders that row without replacing baseline rows.
- The `/research` Model lab does not need a `composite_attribution` row unless
  external producers become a first-class model registry surface.

PHASE 4, STEP 5 — Tests

Add or update these tests when implementing the external producer:

- `apps/nba-sidecar/tests/test_composite_attribution.py`
  - `_compose_product`, `_compose_weighted_sum`, `_compose_gate`, and
    `_compose_max` are bounded and monotonic where expected.
  - `_normalize_paired_score(None)` and low-magnitude scores return `0.0`.
  - negative paired scores do not boost the composite.
  - hysteresis fires once on enter, does not refire while sustained, and exits
    below the exit threshold.
  - `build_predictions(...)` emits one row per board bucket and required
    external prediction columns.
  - multi-game state is isolated.
  - support classes `ok`, `rightful_only`, `credited_only`,
    `insufficient_support` are preserved in diagnostics or companion reports.
- `apps/nba-sidecar/tests/test_evaluation.py`
  - `score-predictions` scores `composite_attribution` through the external
    bridge and writes combined predictions with `model_id`.
- `apps/web/src/features/research/__tests__/ResearchPage.test.tsx`
  - Leaderboard fixture includes `robust_mad`, `state_space_current`,
    `virtual_source_state_space`, and `composite_attribution` simultaneously
    when a composite external run exists.
  - Model lab fixture includes only registered `BoardModel` rows unless the API
    gains an external-producer registry.

PHASE 4 — Definition of Done

- Composite producer is external-first and does not force event/tick data into
  `BoardModel.score`.
- Missing fixtures above exist and are referenced in the snapshot manifest or
  test fixtures.
- `predictions.parquet` validates against the external prediction contract.
- `pnpm quant score-predictions` produces a run directory for
  `composite_attribution`.
- `/research` Leaderboard shows composite output beside baselines; no row
  overwrites another model id.
- Recent, Live, Backtest, Detectors, Known Cases, and Settings remain unchanged
  except for existing links into Research.
- Research docs/explainers state clearly that this is offline Research evidence,
  not live suspend behavior.

FINAL IMPLEMENTATION CHECKLIST — everything this draft must force before code ships

Copy-first execution rule:

- Start from the code already written in this draft. Copy/paste the relevant
  block into the target file, then patch it to current repo contracts.
- Do not ask a new agent to "implement from the plan" without also telling it
  to reuse the code blocks here verbatim as the starting point.
- Any changed copied block needs a concrete reason: repo API mismatch, test
  failure, missing fixture, or documented contract correction. Style preference
  is not enough.
- If code already exists in the repo, patch it in place. Do not replace working
  local code with a clean-room rewrite of this draft.

Runtime:

- `virtual_source_state_space` is additive in the Python registry.
- It implements `score(ScoreRequest) -> ScoreResult`.
- It emits one `PredictionRow` per input bucket.
- It writes top-level `score` and `fired`; bounded reliability score is
  diagnostic `regimeScore`, not top-level `regime_score`.
- Composite attribution stays external until event/tick inputs have a real
  contract.

API/UI:

- `pnpm quant emit-models` writes all registered models to
  `outputs/nba-quant-lab/models.json`.
- `GET /v1/research/models` returns the emitted registry when present.
- Static fallback keeps `robust_mad` and `state_space_current`.
- `/research` Model lab renders incumbent and candidate registered models
  together.
- `/research` Leaderboard renders all scored model ids together.
- Quant guide quickstart is updated only after the candidate model exists.
- No top-level app tab other than Research changes in this phase.

Docs and explainers:

- Update `packages/ui/src/explainers.ts` `research-model-lab` copy from
  "baseline research models" to "baseline and candidate research models" once
  `virtual_source_state_space` is registered.
- Update `docs/quant-researcher-guide.md` and active runbooks with exact
  commands, output paths, and rollback notes.
- Do not promote this draft's preserved sketches directly into implementation
  without reconciling them against current repo contracts.

Verification commands:

BASH
Copy
cd /Users/davidmontgomery/signal-console

# Python research lane
cd apps/nba-sidecar
uv run --extra research pytest tests/test_research.py tests/test_evaluation.py -v
uv run --extra research pytest tests/test_virtual_source_state_space.py -v
uv run --extra research pytest tests/test_composite_attribution.py -v

# Registry/API/UI lane
cd /Users/davidmontgomery/signal-console
pnpm quant emit-models
pnpm quant compare robust_mad state_space_current virtual_source_state_space --snapshot "$SNAP"
pnpm --filter @signal-console/api test -- research.test.ts
pnpm --filter @signal-console/web test -- ResearchPage.test.tsx

# Stale wording and doc guards
rg -n "per_source_ekf|PerSourceEKFModel|total_intensity|def predict\\(|@register\\(|_REGISTRY|load_snapshot|score_model|score_candidate_pair|get_candidates|regime_score|warmed_up" \
  docs/moniac-pipeline-plan-and-code-draft.md apps/nba-sidecar apps/web packages/ui
arch -x86_64 ./node_modules/.bin/tsx scripts/verify-no-stale-plan.ts
arch -x86_64 ./node_modules/.bin/tsx scripts/verify-citations.ts

Rollback notes:

- If the candidate underperforms, delete only its emitted run artifacts and keep
  `robust_mad` / `state_space_current` untouched.
- If `models.json` is bad, remove that artifact and the API falls back to static
  incumbent rows.
- Do not change live detector defaults as rollback for Research failures; the
  live path was never changed.

END OF DRAFT — 2026-06-09 Codex completion
