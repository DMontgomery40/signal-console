# NBA Quant Lab — Research Menu

> Audience: a strong quant deciding _what to try_. For each family: what it is good at,
> its likely fit for **this** dataset, its **operating mode** (online-causal /
> offline-trained / forecasting-first), and real references.
>
> **The dataset, in one line.** Per-game series of ~60-second buckets; the only causal
> inputs are `intensity` (volume-weighted Σ|Δ implied prob|), `active_market_count`,
> `source_count`, `source_dominance`, `source_disagreement`, `game_elapsed_seconds`.
> Labels are sparse and **forced into train**, so incident recall is a small-corpus,
> near-zero-shot target (the frozen `sample-fixed` reference snapshot carries 15
> scoreable incidents over ~20 truth-bearing games). A candidate must score and
> _decide to fire_ causally (buckets `0..i` only), one decision per bucket. See
> `docs/nba-quant-lab.md`.
>
> **Corpus size depends on the snapshot.** `pnpm quant:export` reads the **gold DB
> directly** (no pull step required) and now defaults to the **full corpus**
> (~1 256 board-eligible games on the current gold DB), not the 29-game `sample-fixed`
> reference; sampling (`--sample N` / `--games a,b` / `--limit N`) is opt-in. (The old
> "Pull" / "add-or-repair source data" step is optional — only for non-gold sources or
> new date windows; see `docs/nba-quant-lab.md` §0.) Scoreable-incident counts scale with the incident registry, not the
> regular-game count, so a larger corpus mainly buys more non-incident games to test
> fire-rate / residual-coverage generalization on.
>
> **What that implies for model choice.** This is a **streaming change/anomaly-detection**
> problem on a short, low-dimensional, irregular series — _not_ a clean supervised
> classification problem with abundant labels. The honest favorites are online-causal
> robust/state-space detectors. Heavy offline-trained sequence models (Mamba,
> transformers, JEPA) are _plausible representation learners_ but are fighting a severe
> label-scarcity and leakage-risk headwind here; treat them as research bets, not
> defaults. Forecasting-first models earn their keep only via a residual/innovation
> signal, not raw point forecasts.

Legend for **mode**: 🟢 online-causal (natural fit) · 🟡 offline-trained (needs a causal
inference wrapper + careful leakage control) · 🔵 forecasting-first (use the
one-step-ahead residual as the surprise signal).

---

## A. Robust statistics (MAD / Hampel) 🟢

**What it's good at.** Cheap, transparent, distribution-free outlier flagging on a
streaming univariate (or low-dim) signal. Median + MAD gives a breakdown point of 50%;
the Hampel identifier is the canonical robust online despiker.

**Fit for this dataset — strong, and it's the incumbent.** `robust_mad` (trailing-median

- k·MAD on `intensity`) is one of the two shipped baselines (4/15 scoreable recall @
  15.55 fires/game). Its weakness is exactly where the headroom is: no breadth
  normalization, no source-trust weighting, no regime adaptation, so it over-fires on calm
  games and under-fires on structurally wild ones. **Cheapest wins likely live here:** add
  `active_market_count` breadth normalization, a `source_disagreement` gate, or a Hampel
  two-sided rule, and you may beat the incumbent on burden at equal recall without leaving
  robust-stats territory.

**Mode.** 🟢 fully online-causal.

**References.**

- Hampel (1974), "The Influence Curve and Its Role in Robust Estimation," _JASA_ 69(346),
  383–393 — the influence-function / Hampel-identifier foundation.
- Rousseeuw & Croux (1993), "Alternatives to the Median Absolute Deviation," _JASA_ —
  robust scale estimators (Sn/Qn) if MAD's symmetry assumption bites.
- In-repo: `apps/nba-sidecar/src/nba_sidecar/research/models/robust_mad.py`.

---

## B. Kalman / EKF / UKF / EnKF filters 🟢

**What it's good at.** Recursive Bayesian state estimation for (locally) linear-Gaussian
dynamics. The level/trend (local linear trend) form tracks a slowly-moving baseline and
emits a **standardized innovation** every step — a natural, causal "surprise" score.
EKF/UKF/EnKF extend it to nonlinear/non-Gaussian dynamics (Jacobian linearization,
sigma-point unscented transform, ensemble Monte-Carlo for high-dim).

**Fit for this dataset — strong; it's the other incumbent.** `state_space_current` is
exactly this: a Kalman-style level/trend filter with breadth normalization, source-trust
measurement noise, regime variance adaptation, and opening-ramp anchoring. Today it is
very quiet (0.75 fires/game) and catches 0/15 scoreable incidents — so the headroom is in
the **trigger/observation model**, not the filter machinery. UKF/EKF are likely overkill
(the dynamics are nearly linear in a 1-D intensity level); **EnKF and the unscented
transform are mostly irrelevant** at this dimensionality. The productive moves: re-tune
the enter/exit thresholds, make measurement noise a sharper function of
`source_disagreement`/`source_dominance`, or add a second observed channel.

**Mode.** 🟢 online-causal (the canonical recursive filter).

**References.**

- Kalman (1960), "A New Approach to Linear Filtering and Prediction Problems," _J. Basic
  Eng._ 82(1), 35–45.
- Julier & Uhlmann (1997), "A New Extension of the Kalman Filter to Nonlinear Systems"
  (UKF / unscented transform).
- Evensen (1994/2003), "The Ensemble Kalman Filter" — EnKF for high-dimensional state.
- Libraries: `pykalman`, `filterpy` (Labbe, "Kalman and Bayesian Filters in Python"),
  `statsmodels` `UnobservedComponents` (local-linear-trend in Python).
- In-repo: `apps/nba-sidecar/src/nba_sidecar/research/models/state_space_current.py`,
  `apps/nba-sidecar/src/nba_sidecar/volatility.py`, and the registered candidate
  `apps/nba-sidecar/src/nba_sidecar/research/models/virtual_source_state_space.py`
  (per-virtual-source filters + precision-weighted combine; see
  `docs/moniac-pipeline-plan-and-code-draft.md`).

---

## C. Particle filters (sequential Monte Carlo) 🟢

**What it's good at.** State estimation for arbitrary nonlinear/non-Gaussian state-space
models, including multimodal posteriors and heavy-tailed observation noise — situations
where the Gaussian Kalman family breaks. Online and causal by construction.

**Fit for this dataset — plausible but probably over-engineered.** A particle filter
shines when the posterior is genuinely multimodal or the noise is heavy-tailed. Board
intensity is bursty and heavy-tailed, so a particle filter with a Student-t observation
model _could_ outperform a Gaussian Kalman filter on the wild games. But with a 1-D
state and ~150 buckets/game, you pay real compute and tuning cost for a marginal modeling
gain. Worth a focused experiment only after the cheap robust/Kalman trigger tuning is
exhausted.

**Mode.** 🟢 online-causal.

**References.**

- Gordon, Salmond, Smith (1993), "Novel approach to nonlinear/non-Gaussian Bayesian state
  estimation," _IEE Proc. F_ (the bootstrap particle filter).
- Doucet & Johansen (2011), "A Tutorial on Particle Filtering and Smoothing: Fifteen Years
  Later," _Oxford Handbook of Nonlinear Filtering_ —
  https://www.stats.ox.ac.uk/~doucet/doucet_johansen_tutorialPF2011.pdf
- Library: `particles` (Chopin).

---

## D. GARCH / stochastic volatility 🔵

**What it's good at.** Modeling time-varying conditional variance (volatility clustering)
in a return-like series. GARCH gives a one-step-ahead conditional variance; stochastic-vol
models treat log-variance as a latent state.

**Fit for this dataset — useful as a normalizer, not as a detector.** `intensity` already
behaves like a volatility proxy (it _is_ a sum of absolute price moves), so fitting GARCH
directly to it is somewhat circular. The honest use is **regime normalization**: estimate
the conditional volatility level and fire on standardized exceedances (a bucket that is
extreme _relative to the current volatility regime_), which addresses `robust_mad`'s
"calm game vs wild game" failure directly. Treat the GARCH/SV conditional variance as a
feature feeding a robust or state-space trigger, not as a standalone classifier.

**Mode.** 🔵 forecasting-first (use the standardized residual / conditional-vol band). SV
variants are often offline-fit (MCMC) but can be filtered online.

**References.**

- Bollerslev (1986), "Generalized Autoregressive Conditional Heteroskedasticity,"
  _J. Econometrics_ 31(3), 307–327 (GARCH).
- Engle (1982), "Autoregressive Conditional Heteroscedasticity…," _Econometrica_ (ARCH).
- Kim, Shephard, Chib (1998), "Stochastic Volatility: Likelihood Inference and Comparison
  with ARCH Models," _Rev. Econ. Stud._
- Library: `arch` (Sheppard) for GARCH/EGARCH in Python.

---

## E. Bayesian Structural Time Series (BSTS) 🔵🟡

**What it's good at.** A modular state-space framework (local level/trend + seasonality +
regression with a spike-and-slab prior for sparse predictor selection) with full
posterior uncertainty. Designed for nowcasting / "predicting the present" and for
counterfactual/causal-impact estimation around an intervention.

**Fit for this dataset — a clean conceptual match, with caveats.** BSTS is structurally
the Bayesian generalization of the Kalman baseline, so its **posterior predictive
interval** is a principled "is this bucket surprising?" band — fire when `intensity`
escapes the credible interval. The CausalImpact framing (was there a structural break
around time _t_?) maps directly onto "did the board structurally shift around the
incident?" Caveats: BSTS is heavier (MCMC), so the online story is a rolling-refit
approximation rather than a true recursive filter, and the spike-and-slab regression part
has almost no exogenous predictors to select from here (you only have 5 causal channels).
Use it for the structural-break/credible-band idea, not the regression machinery.

**Mode.** 🟡 offline-fit posterior (rolling window) / 🔵 forecasting-first credible band.

**References.**

- Scott & Varian (2014), "Predicting the Present with Bayesian Structural Time Series" —
  https://people.ischool.berkeley.edu/~hal/Papers/2013/pred-present-with-bsts.pdf
- Brodersen et al. (2015), "Inferring causal impact using Bayesian structural time-series
  models," _Annals of Applied Statistics_ (the CausalImpact method).
- Libraries: R `bsts` / `CausalImpact` (Scott); `tfp.sts` (TensorFlow Probability).

---

## F. Online learning (river) 🟢

**What it's good at.** Single-pass, incremental learning on streams: online anomaly
detectors (Half-Space Trees, One-Class SVM), drift detectors (ADWIN, Page-Hinkley),
adaptive standardizers, and incremental classifiers — all with `learn_one` / `score_one`
causal APIs.

**Fit for this dataset — a natural home for a causal candidate.** `river` lets you build a
genuinely online detector that updates per bucket: e.g. an online standardizer feeding
Half-Space Trees on the 5-channel feature vector, or a Page-Hinkley / ADWIN change
detector on `intensity`. This respects the causal contract for free and is a low-risk
way to bring multivariate structure (`source_disagreement` × `intensity` interactions) in
without a heavy offline training loop. **A strong first non-baseline bet.** Watch label
scarcity: prefer the unsupervised anomaly/drift detectors over supervised online
classifiers, since you have ~15 positives.

**Mode.** 🟢 online-causal by design.

**References.**

- Montiel et al. (2021), "River: machine learning for streaming data in Python," _JMLR_
  22 — arXiv:2012.04740 — https://arxiv.org/abs/2012.04740
- Bifet & Gavaldà (2007), ADWIN; Page (1954) / Hinkley, Page-Hinkley change detection.
- Library: `river` (https://riverml.xyz).

---

## G. State-space backbones — S4 / S6 / Mamba 🟡

**What it's good at.** Deep selective state-space sequence models: linear-time, long-range
sequence modeling that learns the dynamics (the A/B/C/Δ matrices) from data rather than
hand-tuning a Kalman filter. Mamba (S6) makes the SSM parameters input-dependent
(selective), giving content-aware memory.

**Fit for this dataset — interesting but headwind-heavy.** Conceptually beautiful: a
learned state-space backbone is the data-driven cousin of the Kalman baseline, and could
in principle learn a far better intensity-dynamics model. But these are **offline-trained
deep nets that are data-hungry**, and you have ~20 games and 15 positives. Realistic path:
use a small Mamba/S4 as an **unsupervised next-bucket predictor** (train on all causal
buckets, no labels), then fire on the prediction residual — sidestepping the
label-scarcity wall and the leakage risk. Do **not** train it as a supervised
incident-classifier on this corpus; it will memorize. A research bet, not a default.

**Mode.** 🟡 offline-trained (then 🔵 residual-based firing for the causal decision).

**References.**

- Gu, Goel, Ré (2021/2022), "Efficiently Modeling Long Sequences with Structured State
  Spaces" (S4) — arXiv:2111.00396 — https://arxiv.org/abs/2111.00396
- Gu & Dao (2023), "Mamba: Linear-Time Sequence Modeling with Selective State Spaces"
  (S6) — arXiv:2312.00752 — https://arxiv.org/abs/2312.00752
- Library: `mamba-ssm` (https://github.com/state-spaces/mamba).

---

## H. Temporal / decoder transformers (forecasting) 🔵🟡

**What it's good at.** Attention-based multi-horizon forecasting with interpretable
variable/temporal attention (TFT), or patch-based long-horizon univariate forecasting
(PatchTST), or efficient long-sequence forecasting (Informer). Strong when there is
abundant data and useful covariates.

**Fit for this dataset — weakest of the deep families here.** Transformers want long,
data-rich series and known-future covariates; you have short games, few series, and
almost no exogenous future inputs. As classifiers they will overfit 15 positives. The
only honest use is **forecasting-first**: a transformer trained unsupervised to forecast
the next bucket's `intensity`, firing on the forecast residual — but a Kalman/SSM residual
likely matches it at a fraction of the cost and data. Park these unless the snapshot grows
by an order of magnitude.

**Mode.** 🔵 forecasting-first / 🟡 offline-trained.

**References.**

- Lim et al. (2021), "Temporal Fusion Transformers for Interpretable Multi-horizon Time
  Series Forecasting," _IJF_ — arXiv:1912.09363 — https://arxiv.org/abs/1912.09363
- Nie et al. (2023), "A Time Series is Worth 64 Words: Long-term Forecasting with
  Transformers" (PatchTST) — arXiv:2211.14730 — https://arxiv.org/abs/2211.14730
- Zhou et al. (2021), "Informer: Beyond Efficient Transformer for Long Sequence
  Time-Series Forecasting," _AAAI_ — arXiv:2012.07436.

---

## I. JEPA (Joint-Embedding Predictive Architectures) 🟡

**What it's good at.** Non-generative self-supervised representation learning: predict the
_embedding_ of a masked/target region from a context region, in latent space rather than
input space. Learns abstract structure without reconstructing noise.

**Fit for this dataset — speculative, representation-learning angle only.** A
time-series JEPA could learn a self-supervised embedding of board-dynamics windows
(predict the embedding of the next window from the current one) and surface incidents as
embedding-space prediction errors — an anomaly-in-latent-space detector that needs no
incident labels. The appeal is exactly the label-scarcity dodge. The reality: JEPA is
image/video-native, the time-series recipe is unsettled, and your data volume is tiny. A
long-shot research bet, valuable mainly if you already believe a learned embedding beats
hand-crafted features.

**Mode.** 🟡 offline self-supervised (then 🔵 latent-residual firing).

**References.**

- LeCun (2022), "A Path Towards Autonomous Machine Intelligence" (the JEPA proposal);
  intro: Dawid & LeCun (2023), arXiv:2306.02572 — https://arxiv.org/abs/2306.02572
- Assran et al. (2023), "Self-Supervised Learning from Images with a Joint-Embedding
  Predictive Architecture" (I-JEPA) — arXiv:2301.08243 — https://arxiv.org/abs/2301.08243
- Bardes et al. (2024), V-JEPA — video extension (relevant for the windowed-sequence
  framing).

---

## J. World models with embeddings 🟡

**What it's good at.** Learn a compressed latent state + a recurrent forward model of an
environment's dynamics; detect surprise as a large forward-model prediction error in
latent space. The classic VAE-encoder + MDN-RNN "dream" architecture.

**Fit for this dataset — conceptually apt, practically a stretch.** The board _is_ an
environment with latent dynamics, and "incident ≈ large forward-model surprise in latent
space" is an elegant framing that needs no incident labels. But world models are built for
high-dimensional observation streams (pixels) with abundant rollouts; here the observation
is a 5-D vector over ~150 steps. You would essentially be building a small latent SSM with
a learned encoder — which collapses back toward family G (learned state-space) with extra
moving parts. Pursue only as a unification of G + the surprise-as-residual idea.

**Mode.** 🟡 offline-trained latent forward model → 🔵 latent prediction-error firing.

**References.**

- Ha & Schmidhuber (2018), "World Models" — arXiv:1803.10122 — https://arxiv.org/abs/1803.10122
- Hafner et al., Dreamer line (DreamerV3, arXiv:2301.04104) — latent world models with
  learned dynamics, if you want the modern recipe.

---

## K. Test-time training (TTT) 🟢🟡

**What it's good at.** Adapt model parameters _per test instance_ using a self-supervised
objective before predicting — improving robustness under distribution shift. The modern
"TTT-layer" variant makes the recurrent hidden state itself a model updated by
self-supervised gradient steps at inference, giving an expressive, online-adapting
sequence model.

**Fit for this dataset — a genuinely interesting bet, because every game is a shift.**
Games differ wildly (calm vs wild, by source mix and pace), which is exactly the
distribution-shift setting TTT targets: adapt the baseline per game from that game's early
buckets (self-supervised next-bucket prediction), then fire on residuals with a model
that has _specialized to this game's regime_. This directly attacks `robust_mad`'s
calm/wild brittleness and is causal if you only adapt on past buckets. The TTT-layer
(TTT-Linear) variant is also a credible Mamba/transformer alternative with a built-in
online-adaptation story. Promising — and it composes with families A/B/G.

**Mode.** 🟢 online-causal adaptation (adapt on buckets `0..i`) over a 🟡 pretrained or
🟢 from-scratch base.

**References.**

- Sun et al. (2020), "Test-Time Training with Self-Supervision for Generalization under
  Distribution Shifts," _ICML_ — arXiv:1909.13231 — https://arxiv.org/abs/1909.13231
- Gandelsman et al. (2022), "Test-Time Training with Masked Autoencoders" —
  arXiv:2209.07522 — https://arxiv.org/abs/2209.07522
- Sun et al. (2024), "Learning to (Learn at Test Time): RNNs with Expressive Hidden
  States" (TTT-Linear / TTT-MLP) — arXiv:2407.04620 — https://arxiv.org/abs/2407.04620

---

## Recommended ordering (honest)

1. **A (robust stats) + B (Kalman trigger tuning)** — the incumbents have obvious unused
   structure (breadth, source-trust, regime). Cheapest expected wins; lowest leakage risk.
2. **F (river) and D/E (vol-regime normalization as a feature)** — bring multivariate /
   regime-aware structure online without heavy training.
3. **K (test-time training)** — best-motivated deep bet given the per-game shift.
4. **G (Mamba/S4) as an unsupervised residual model** — if you want a learned-dynamics
   backbone, do it forecasting-first, never as a 15-positive supervised classifier.
5. **H / I / J** — park until the dataset is an order of magnitude larger; high overfit /
   leakage risk on the current corpus.

Across all of them: the candidate must obey the **causal, one-row-per-bucket** contract
and clear the recorded bar — _better known-case recall at the same fires/game plus honest
residual coverage_ — measured by the shared scorer. See `docs/nba-quant-lab.md`.
