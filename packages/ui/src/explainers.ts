// Explainer content for hover-cards across the UI.
//
// Each entry has two sections: `eli5` (sports-trader voice, plain English, no
// math jargon) and `formal` (technical, with KaTeX LaTeX where useful — `$inline$`
// and `$$block$$` delimiters). Both rendered as markdown via react-markdown +
// remark-math + rehype-katex by the HoverCard component in components/ExplainerCard.tsx
// (built in US-046).
//
// Voice guidelines (see docs/design-language.md §Explainer Cards):
//   ELI5    — conversational, second person OK, never condescending. Tell the
//             reader what the concept means for *their job* (deciding whether to
//             suspend a market), not for the algorithm's job. 2-3 short paragraphs.
//   formal  — technical but readable to a "normal-small nerd" (not IMO-winner).
//             Define every symbol the first time. Always say WHY this estimator
//             vs an obvious alternative. Cite canonical sources. 1-2 paragraphs
//             + LaTeX formula where helpful.
//
// Content edits are review events; add new entries here, then reference by id
// from any component that needs to hover-explain that concept.

export interface Explainer {
  readonly title: string;
  readonly eli5: string;
  readonly formal: string;
}

export const explainers = {
  // ──────────────────────────────────────────────────────────────────────────
  //  Headline concepts
  // ──────────────────────────────────────────────────────────────────────────

  "board-mad": {
    title: "Board state-space detector",
    eli5: String.raw`This is the main suspend signal. It watches how the whole prediction-market board moves together on a game, then asks whether the current bucket looks surprising relative to the game's current hidden volatility regime.

The live model is no longer a plain rolling median-plus-MAD rule. It still builds whole-board intensity from weighted implied-probability deltas, but the fire decision comes from a causal state-space filter. That filter tracks a latent baseline level and a latent volatility regime, then scores each new bucket by its standardized innovation. The practical output is the same trader question as before: "did the board just do something unusually informative for this game state?"`,
    formal: String.raw`For each bucket $t$, the observation model starts from whole-board intensity

$$I_t = \sum_{m \in \mathcal{M}_g} \sum_{i \in t} w(v_{m,i}) \cdot \left| \Delta p_{m,i} \right|,$$

with $w(v)=\log(1+v)$ by default, then normalizes by market breadth and works in transformed score space $y_t=\log(1+I_t/\sqrt{B_t})$. The live filter is a robust two-state level/trend model with adaptive observation variance. Historical priors, opening anchors, and current-game memory all enter as causal anchor distributions on the latent baseline before the innovation update.

The alert rule is innovation-based: a bucket fires when the positive standardized innovation clears the configured enter threshold after warmup, with hysteresis on the exit side. The UI still shows baseline level and baseline scale because traders need an interpretable threshold line, but the live runtime truth is the state-space filter in \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "k-mad": {
    title: "Innovation trigger",
    eli5: String.raw`This is the main fire threshold for the live board model. Lower values make it easier for a bucket to count as a surprise; higher values make the model calmer.

The important change is what it means now. In the current runtime it is not "how many MADs above the median" anymore. It scales the innovation gate used by the state-space filter. The filter estimates what the board should look like right now, measures the gap between that estimate and the actual bucket, standardizes the gap by its uncertainty, and fires when that standardized surprise is big enough.`,
    formal: String.raw`The live runtime maps this dial into the state-space model's innovation gate, not a direct $K \cdot \mathrm{MAD}$ term. In the current implementation, the positive standardized innovation $z_t^+$ fires when it exceeds the configured enter threshold after warmup, with a lower exit threshold to prevent chatter. The dial still uses the legacy \`kMad\` field name in requests for compatibility, but the semantic meaning is "innovation trigger strength" in the Python sidecar.`,
  },

  "k-mad-sensitive": {
    title: "Sensitivity 3.0 — Sensitive (live default)",
    eli5: String.raw`This is the production setting. Every Recent and Live screen you see in this app is running at sensitivity 3 behind the scenes. The Backtest dial lets you compare other values, but everything else lives here.

What you get at sensitivity 3: the live board lane takes the higher-recall posture. You'll see more fires than you'd manually act on, and that's intentional. The expected use case is a desk operator scanning Recent's per-game fire counts, opening anything that looks elevated, and confirming or ignoring at a glance.

If the volume feels like too many false alarms in practice, the right answer isn't to nudge sensitivity up — it's to add a second filter downstream (a confidence score, a phase-of-game gate, anything you can validate). sensitivity is locked at 3 for the live path because the empirical recall curve is steepest right around this value.`,
    formal: String.raw`Sensitivity 3.0 with volume weighting is the canonical live operating point, declared in \`packages/detectors/src/board-mad/config.ts\` and matching the legacy \`nba-predict\` TypeScript runtime at \`game-state-volatility.ts:24-340\`.

The generated bakeoff report carries the current empirical characterization for the active incident corpus. The contract test \`packages/detectors/src/board-mad/__tests__/canonical.test.ts\` pins the sensitivity=3 outcomes against committed JSON fixtures to prevent silent drift.`,
  },

  "k-mad-calm": {
    title: "Sensitivity 6.0 — Calm (backtest comparison preset)",
    eli5: String.raw`This is the calmer comparison point on the dial. At sensitivity 6 the detector fires about half as often as it does at sensitivity 3 — roughly 9 per game on the backtest set instead of 18 — because we're requiring six "typical variations" above the median wiggle to trigger, twice the threshold.

Calm exists on the dial as a reference point, not a recommended setting. It's the value the original research backtest was written around (the Python script's default), and pinning it as a labeled snap makes it cheap to sanity-check: move the dial to Calm, see which fires survive, ask whether they're the right ones.

In production we never run the live system at sensitivity 6 — too many real events get missed at that sensitivity. If the dial in Backtest shows you something interesting at sensitivity 6 specifically, it's almost certainly a high-confidence event also visible at sensitivity 3. The interesting comparison is usually the other direction: things that fire at sensitivity 3 but not at sensitivity 6 are the edge-case sensitivity gains.`,
    formal: String.raw`Sensitivity 6.0 is the comparison-only preset, matching the original Python research backtest's default in \`scripts/board_signal_v2.py:33\`. It is exposed only in Backtest UI and never used by Live or Recent surfaces.

Empirical anchors for the current incident corpus live in \`outputs/nba-detector-bakeoff/\` and the Known Cases page. The committed detector tests keep this preset bounded against the local PBP fixture set without copying a stale benchmark count into product copy.

Contract tests pin two specific event-level outcomes at sensitivity 6: (1) Hartenstein (event \`2026-05-08T03:12:36.8Z\`, game \`nba-0042500222\`) fires with bucket-start \`03:12:00Z\` and watcher-confirmation bucket-end \`03:13:00Z\` ($\approx$ T+23 s after the event); and (2) Reaves (event \`2026-05-12T04:51:40.2Z\`, games \`nba-0042500223/224\`) does **not** fire on either game — the report's honest null case for the board lane. These outcomes are locked in \`packages/detectors/src/board-mad/__tests__/canonical.test.ts\` against committed JSON fixtures; any drift is a review event.`,
  },

  mad: {
    title: "MAD — Median Absolute Deviation",
    eli5: String.raw`MAD is a way to measure how spread-out a list of numbers is, without letting one weird value mess up the measurement. Think of it as the "typical wiggle" — most numbers stay within one MAD of the median; a number more than several MADs out is genuinely unusual.

The everyday alternative is standard deviation, and the two answer the same question — but standard deviation is fragile. One contaminated value can dominate it. If twenty minutes of intensity look like \`[12, 14, 13, 11, 15, 12, 14, 13, 12, 14, 13, 12, 11, 14, 13, 12, 13, 14, 12, 88]\` because some weird thing happened in the last bucket, standard deviation will tell you the typical wiggle is huge. MAD will tell you the typical wiggle is ~1, because the median didn't move and most absolute deviations from it are still ~1.

In this app, MAD is what sets the spike threshold for the suspend detector. We want the threshold to reflect "what normal felt like" — and "normal" should not be redefined by the one outlier we're trying to detect.`,
    formal: String.raw`The Median Absolute Deviation of a sample $x = (x_1, \ldots, x_n)$ is:

$$\mathrm{MAD}(x) = \mathrm{median}_i\!\left(\left|x_i - \mathrm{median}(x)\right|\right)$$

a robust scale estimator with a 50% asymptotic breakdown point (vs the 0% breakdown of standard deviation). For approximately Gaussian samples, $\mathrm{MAD}$ relates to the population standard deviation by $\sigma \approx 1.4826 \cdot \mathrm{MAD}$, but the board-MAD detector does NOT apply this constant — the rule is parameterized directly in MAD units via sensitivity, so any rescaling would just multiply through sensitivity.

We choose MAD over $\hat\sigma$ in the fire rule because the trailing window is contaminated by definition: it is contaminated by the events we're trying to detect, plus benign outliers (timeout-end repricing bursts, single-market liquidation cascades) that don't constitute board-wide signal. With $\hat\sigma$, a single such outlier inflates the threshold for $W$ subsequent buckets, suppressing detections we'd want to see. With MAD, the threshold is essentially unmoved by isolated outliers — the median absorbs the location shift and the median of absolute deviations from it remains close to the bulk's natural scale. A small floor (\`max(MAD, 1e-9)\`) prevents division-by-zero on degenerate quiet windows; see \`scripts/board_signal_v2.py\`.`,
  },

  "trailing-baseline": {
    title: "State-space alert rule",
    eli5: String.raw`The detector still works causally — it only looks backward — but the decision rule is now "is this bucket a large standardized surprise for the current hidden regime?" rather than "is it several MADs above a rolling median?"

That matters because the baseline can move with the game. If the whole board has become broadly wild, the hidden regime should rise and later spikes should be harder to call special. If the game is quiet, a sharp repricing burst stands out much more.`,
    formal: String.raw`The current runtime keeps the trader-facing threshold line but computes it from a robust state-space filter. Let $y_t$ be the transformed bucket score, $\hat y_t$ the one-step baseline prediction, and $s_t$ the innovation scale. The innovation score is

$$z_t = \frac{y_t - \hat y_t}{s_t}, \qquad z_t^+ = \max(0, z_t).$$

After warmup, a bucket fires when $z_t^+$ exceeds the enter threshold; the alert exits only after $z_t^+$ falls below a lower hysteresis threshold. Historical priors, opening anchors, and recent wall-memory anchors all shift $\hat y_t$ causally before the innovation test. The live threshold line shown in the UI is the equivalent intensity-space threshold implied by that state-space step, not a literal rolling median-plus-MAD line.

This is a robust, causal, one-sided z-score-style rule. Causal: the comparison set is strictly prior buckets with no future leakage. Adaptive: as the game progresses, the latent state and its uncertainty move with the regime. Canonical runtime: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "baseline-timing-controls": {
    title: "Signal timing",
    eli5: String.raw`This box keeps two opening-game mechanics together because separating them made the page misleading.

Filter memory is the board model's adaptation horizon. If it says 20 with one-minute buckets, the state-space baseline keeps roughly 20 current-game minutes of context in play while it updates. Shorter memory reacts faster to basketball phase changes, but it is easier to fool after a quiet stretch.

Alert holdoff is the opening lockout. If it says 8 with one-minute buckets, no alert can fire until 8 minutes of game clock have elapsed. Prior anchor decides what the first active alert check compares against: pure trailing state, an opening anchor that fades out, or historical NBA priors blended into live current-game memory.`,
    formal: String.raw`For board observation $i$ with elapsed seconds $e_i$, filter memory is an elapsed duration $W = \texttt{trailingBuckets} \cdot \texttt{bucketSeconds}$ and alert holdoff is $W_0 = \texttt{warmupBuckets} \cdot \texttt{bucketSeconds}$:

$$\text{active}_i \iff e_i \ge W_0,\qquad
\mathcal{B}_i = \{I_j : e_i - W \le e_j < e_i\}$$

When active, the runtime transforms the bucket score into an innovation $z_i$ against the latent state and fires when that innovation clears the configured enter threshold. The default prior anchor is opening-ramp: it starts with \`openingBaselineBuckets\` from the beginning of the game and fades out by \`openingRampCompleteBuckets\`. Historical mode blends same-side priors with live game-clock memory and an optional short wall-clock tack-on. Canonical runtime: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "baseline-source-mode": {
    title: "Prior anchor",
    eli5: String.raw`Pure trailing state is the leanest mode: once the holdoff ends, each bucket is judged only against the latent state learned from recent current-game behavior.

Opening anchor ramp is the live default for the opening minutes. The first active alert check can borrow a smaller elapsed sample from the start of the game — for example, hold off until 8 minutes but judge it against the first 4 elapsed minutes — then that anchor fades out until the model is running on live state alone.

Historical prior blend starts from recent same-side NBA priors — away team as away, home team as home — then fades toward current-game volatility as actual game-clock minutes accumulate.`,
    formal: String.raw`\texttt{baselineMode} selects which prior anchor shapes the latent state after alert holdoff. The current sidecar supports three modes:

$$
\text{anchor}_i =
\begin{cases}
\varnothing, & \texttt{trailing}\\
A^{\text{open}}_i, & \texttt{opening-ramp}\\
A^{\text{hist/live}}_i, & \texttt{historical-blend}
\end{cases}
$$

where $A^{\text{open}}_i$ is the opening anchor built from the first \texttt{openingBaselineBuckets} buckets and faded out by \texttt{openingRampCompleteBuckets}, and $A^{\text{hist/live}}_i$ is the precision-weighted combination of historical priors, current-game memory, and optional wall-clock memory. Canonical runtime: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "fires-per-game": {
    title: "Fires per game",
    eli5: String.raw`This is the rate at which the detector calls a board-wide spike on a given game. Take a window — last 24 hours, the backtest range, whatever — count how many buckets fired across all games in that window, divide by how many games. That's "fires per game."

It's the cheapest possible quality metric for a detector. Too low, you're missing things. Too high, you're burning attention on false alarms. The whole reason this dial exists is to let you see the trade-off between these two failure modes by sliding the innovation trigger around.

Real games vary — a tight, slow game might fire a handful of times; a chaotic playoff game with three lead changes might fire far more. The number is most useful as a comparison ("game X is firing twice as much as the median tonight") rather than an absolute ("more than 15 = real"). Current reference numbers live in Backtest and the generated bakeoff report.`,
    formal: String.raw`For a window $\mathcal{W}$ containing games $\mathcal{G}_{\mathcal{W}}$:

$$F/G_{\mathcal{W}} = \frac{\sum_{g \in \mathcal{G}_{\mathcal{W}}}\, \#\{t \in g : \text{fire}_t = 1\}}{|\mathcal{G}_{\mathcal{W}}|}$$

This is the single primary characterizer of a $(S, W, W_0, \tau_{\max}, w)$ parameter set on a given fixture window. It is reported in Backtest UI as the live preview metric as the dial moves, and regenerated in the bakeoff artifact for the current official incident corpus.

Two caveats worth knowing. First, $F/G$ is averaged across games of very different lengths and information densities — a Game-7 closeout fires more than a December regular-season blowout. Per-game variance is large and the mean is the relevant aggregate. Second, the metric implicitly assumes the labeled-event base rate is approximately constant across the fixture set; when comparing fire rates across windows with different event densities, recall on labeled events from the generated bakeoff is the comparable quantity, not $F/G$ alone.`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  Detector parameters (board-mad)
  // ──────────────────────────────────────────────────────────────────────────

  "bucket-seconds": {
    title: "Bucket size (seconds)",
    eli5: String.raw`The bucket is the heartbeat of the detector. Every 60 seconds we tally up every quote change across every market on the game, weight them, and stamp that minute with one number — the "intensity." That number is what gets compared against the trailing baseline to decide if something just happened. So the bucket is basically asking: at what resolution do we want to see the board breathe?

Sixty seconds is the sweet spot for live sports. Short enough that a real news-driven move shows up in the same window the books are repricing, long enough that one twitchy market-maker doesn't look like a fire. Shrink it to 15 or 30 and the intensity gets jumpy — you'll see more candidate fires but more of them will be noise, and you'll need proportionally more buckets to warm up. Stretch it to 120 or 300 and the detector goes blind to anything that resolves in under two minutes, which is most of what we care about.`,
    formal: String.raw`$\texttt{bucketSeconds}$ defines the fixed window $\Delta t$ over which volume-weighted absolute implied-probability deltas are aggregated into the intensity series $I_t$. With $\Delta t = 60$ s (live default, see \`scripts/board_signal_v2.py\`), the detector operates at one-minute granularity: each bucket emits a single $I_t$ scalar consumed by the MAD rule.

$$I_t = \sum_{m \in \mathcal{M}} \sum_{i \in t} w_{m,i} \cdot \left| p_{m,i} - p_{m,i-1} \right|$$

where $\mathcal{M}$ is the set of markets on the game, $p_{m,i}$ is the implied probability of the $i$-th tick of market $m$, and $w_{m,i}$ is its weight (see \`weighting\`). Smaller $\Delta t$ raises temporal resolution but inflates the variance of $I_t$ and demands a longer trailing window to keep median/MAD stable; larger $\Delta t$ smooths $I_t$ at the cost of detection lag bounded below by $\Delta t$ itself. Sixty seconds matches the dominant repricing cadence observed in the backtest set.`,
  },

  "trailing-buckets": {
    title: "Filter memory (buckets)",
    eli5: String.raw`This is how much recent elapsed game time the state-space model treats as relevant when it decides what "normal" feels like right now. Twenty buckets at one minute each means a roughly twenty-minute adaptation horizon: the latent level and scale can still move, but they do so with that much recent context in mind.

Make it shorter — say 10 — and the latent state gets twitchy. One quiet stretch followed by a normal flurry can still look special because the model forgot the recent higher-volatility regime too quickly. Make it longer — say 40 — and the detector is slow to notice that the game has changed phase. Quarter starts, scoring runs, injury news settling in: all of those shift the natural intensity level, and a long memory keeps dragging the old regime forward. Twenty is the compromise: long enough to be stable, short enough to adapt within a single game's arc.`,
    formal: String.raw`$\texttt{trailingBuckets}$ sets the state filter's effective memory horizon $W$ in bucket units. In the current sidecar it shapes the latent state's decay and innovation-scale adaptation, so smaller $W$ values track local non-stationarity faster while larger $W$ values stabilize the baseline at the cost of regime lag.

The trigger is still displayed as an intensity-space threshold in the UI, but that line is derived from the latent prediction plus the configured innovation trigger. Canonical runtime: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "warmup-buckets": {
    title: "Alert holdoff (buckets)",
    eli5: String.raw`This is the opening lockout. For the first N bucket durations, the detector refuses to fire no matter how jumpy the board looks. That is separate from Filter memory: holdoff says "not yet"; memory says "once we are allowed to fire, how much current-game history counts as normal?"

Lowering the gate lets the detector act earlier, which is probably worth testing for basketball. The risk is that the latent state may still be under-anchored. With too little opening context, ordinary movement can still look like a giant shock.`,
    formal: String.raw`$\texttt{warmupBuckets}$ defines $W_0$, an elapsed holdoff measured as $W_0 \cdot \Delta t$. No fire is emitted before that elapsed time, regardless of $I_i$:

$$\text{active}_i \iff e_i \ge W_0 \cdot \Delta t$$

Once active, the state-space runtime does not subtract $W_0$ from the memory horizon. It uses prior board-move observations inside the elapsed filter-memory duration $W = \texttt{trailingBuckets} \cdot \Delta t$:

$$\mathcal{B}_i = \{I_j : e_i - W \le e_j < e_i\}$$

So with $W_0=8$ and $\Delta t=60s$, the first active alert check is the first board observation at or after 8 elapsed game minutes. Opening-ramp mode can judge that alert check against \`openingBaselineBuckets\` from the start of the game, then fade that anchor out toward the live state. See \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "fresh-cap-seconds": {
    title: "Freshness cap (seconds)",
    eli5: String.raw`When we compute the price change for a market, we look at its current quote and its previous quote. But what if that previous quote is from twelve minutes ago because the market was suspended, or the book pulled it, or the feed dropped? The "delta" you'd compute is real arithmetic but it's not a real move — it's a market reopening at a new level. Counting that toward intensity would light up the detector every time a book unfreezes after a TV timeout.

The freshness cap is the cutoff. If consecutive ticks on the same market are more than five minutes apart, we throw the delta away — that market simply doesn't contribute to this bucket. Five minutes is long enough to span normal between-play quiet periods and short suspensions, short enough that anything genuinely stale gets filtered. The market rejoins the intensity calculation as soon as it ticks twice within the window again.`,
    formal: String.raw`$\texttt{freshCapSeconds}$ defines $\tau_{\max}$, the maximum permissible gap between two consecutive ticks of a single market $m$ for the delta between them to enter $I_t$. For ticks at times $s_{m,i-1}$ and $s_{m,i}$:

$$\Delta p_{m,i} = \begin{cases} \left| p_{m,i} - p_{m,i-1} \right| & \text{if } s_{m,i} - s_{m,i-1} \leq \tau_{\max} \\ 0 & \text{otherwise} \end{cases}$$

The cap exists because the implied-probability delta is only a meaningful signal of repricing when the prior tick reflects the book's view at a comparable point in the game state. A 300-second gap routinely spans suspensions, feed dropouts, and TV-timeout quiets during which the underlying truth has moved without the market quoting; the first post-gap tick is a re-anchor, not an update. $\tau_{\max} = 300$ s is the live default in \`scripts/board_signal_v2.py\`, chosen as the upper edge of the empirical inter-tick distribution for active markets in-play — gaps below this are predominantly genuine quiet, gaps above are predominantly suspension artifacts.`,
  },

  weighting: {
    title: "Delta weighting",
    eli5: String.raw`When two markets each move one cent, are they telling us the same thing? Not really. A penny move on a market that just took six figures of action is a much louder signal than a penny move on a market nobody is touching. Volume weighting bakes that intuition into the math: every delta gets multiplied by how much money was actually trading on it.

We use $\log(1 + v)$ rather than raw volume, and that's deliberate. Raw volume has an ugly right tail — one whale's bet can be a hundred times the median ticket — and if you weight linearly, that single bet dominates the entire intensity number and the detector basically becomes a whale-spotter. The log compresses that tail so big money matters more than small money, but not pathologically more. Volume is the live default. Equal weighting (every delta counts as 1) is available mostly as a backtest sanity check — useful for diagnosing whether a fire was driven by price action or by where the money was.`,
    formal: String.raw`$\texttt{weighting}$ selects the function $w_{m,i}$ applied to each per-market delta before summation into $I_t$. The two options:

$$w_{m,i} = \begin{cases} \log(1 + v_{m,i}) & \texttt{weighting = "volume"} \\ 1 & \texttt{weighting = "equal"} \end{cases}$$

where $v_{m,i}$ is the traded volume associated with the $i$-th tick of market $m$. The "volume" mode is the live default in \`scripts/board_signal_v2.py\`. The motivation is signal-to-noise: a fixed-size implied-probability move carries more information about consensus repricing when it clears against meaningful size, so weighting by a monotone function of volume sharpens the detector against a uniform-weight baseline. $\log(1 + v)$ is chosen over raw $v$ because trade-size distributions in betting markets are heavy-tailed (approximately log-normal to power-law in the upper decile); under linear weighting a single large ticket can contribute more than the rest of the bucket combined, collapsing $I_t$ onto an order-flow statistic rather than a board-repricing statistic. The $\log(1+\cdot)$ form is also defined at $v=0$ and grows slowly enough that the cross-market sum remains well-conditioned. "equal" is retained as a diagnostic baseline for attribution analysis.`,
  },

  "fanout-window": {
    title: "Fanout window (±5 min PBP cap)",
    eli5: String.raw`This is the "why did it fire" panel. Above is the bucket and its surrounding context — but this section explains what was actually happening on the floor and in the books at the moment of the fire.

Two halves. On the left, the play-by-play around the fire: every game event within five minutes either side, sorted by closeness to the moment the detector triggered. On the right, the markets that moved: which specific lines the money was pushing, ranked by how much each one contributed to the overall board-wide spike. Together they answer "what did people see, and how did the book react?"

The five-minute cap is deliberate and important. The research is blunt about it: beyond five minutes, information is worthless — the books have already moved, the edge is gone, anything you do is reactive at best. Inside three minutes you have something. Under one minute, you have gold. The color tiers on the timeline (yellow / hi / md) map exactly to that scale: pay attention to yellow, glance at the rest.`,
    formal: String.raw`The fanout view materializes two independent windows centered on a fired bucket:

$$\mathcal{W}_{\rm PBP} = [t_b - 300\,{\rm s},\; t_b + 300\,{\rm s}], \qquad \mathcal{W}_{\rm mvr} = [t_b,\; t_b + \Delta t)$$

where $t_b$ is the bucket-start timestamp and $\Delta t = 60\,{\rm s}$ matches the detector's bucket granularity. The PBP window is symmetric and strict — any row with $|\Delta t_{\rm event}| > 300\,{\rm s}$ is unconditionally excluded — chosen as a hard cap rather than a soft decay because the empirical post-event price-stabilization halflife on liquid order books is on the order of seconds (Foucault, Pagano & Röell, "Market Liquidity" §7; arxiv:2304.11567 §3 reports a ~3.6 s mean stabilization time in centralized limit-order books across NBA-relevant Kalshi instruments).

The mover contribution is the per-market term of the detector's intensity decomposition:

$$c_m = \sum_{i \in t_b} \mathbf{1}\!\left[ s_{m,i} - s_{m,i-1} \leq \tau_{\max} \right] \cdot \log(1 + v_{m,i}) \cdot |p_{m,i} - p_{m,i-1}|, \qquad \%_m = \frac{c_m}{\sum_m c_m} \cdot 100$$

with the same $\tau_{\max} = 300\,{\rm s}$ freshness cap as the board-mad detector — so the top-mover ranking is exactly the marginal contribution of each market to the fire's intensity. Recency tiers on the PBP dots and movers' time chips ($|\Delta t| < 60\,{\rm s}$: accent-yellow gold; $[60, 180)$: text-hi; $[180, 300)$: text-md) reflect the same Kalshi-minute-candlestick granularity at which the upstream event/price relationship is empirically informative.`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  Other detectors
  // ──────────────────────────────────────────────────────────────────────────

  "off-price-print": {
    title: "Off-price print detector",
    eli5: String.raw`This is the other detector on the board, and it does something completely different from board-MAD. Board-MAD watches everyone wiggle together. Off-price-print watches one market and asks: is a big chunk of today's volume printing far away from where the book agrees the price should be?

Translation: somebody is dumping or absorbing in size, and they don't care about the mid. That's a tell. Maybe they know something. Maybe they're a forced seller. Either way, it's worth a look.

The two defaults: at least 10% of recent volume has to be clustered in the off-price prints (otherwise it's noise), and the prints have to be at least 40 IP cents away from the mid (otherwise it's just normal spread-crossing). This one is Polymarket-only — Bet365 and Kalshi don't give us a trade tape we can dig into the same way.`,
    formal: String.raw`The off-price-print detector identifies concentrated trade clusters far from the prevailing mid-price on a per-market basis. Over a sliding window, it groups recent trades into price clusters and flags any cluster $C$ satisfying both:

$$\frac{V_C}{V_{\text{window}}} \geq \theta_v \quad \text{and} \quad |p_C - p_{\text{mid}}| \geq \theta_d$$

where $V_C$ is the cluster's traded volume, $V_{\text{window}}$ is total window volume, $p_C$ is the cluster's volume-weighted price, and $p_{\text{mid}}$ is the prevailing best-bid/best-ask midpoint in IP units. Defaults: $\theta_v = 0.10$ (\`minVolumeShare\`) and $\theta_d = 0.40$ (\`minOffPriceDistance\`).

Unlike board-MAD, this is a single-market detector — it does not require board-wide synchrony. It is registered only for Polymarket because the print-level trade tape needed to identify clusters is not available from Bet365 (OddsAPI provides quotes, not prints) or Kalshi at the granularity required. It complements board-MAD by catching information-arrival events that show up as one-sided volume concentration rather than synchronized board volatility.`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  Data concepts and sanitations
  // ──────────────────────────────────────────────────────────────────────────

  "implied-probability": {
    title: "Implied probability",
    eli5: String.raw`Implied probability is the market's price translated into a percentage. Decimal odds of 2.50 mean a 40% chance. American +150 means 40%. A Polymarket share trading at 62 cents means 62%. Same number, three different wrappers.

For your job, this is the only price unit worth caring about when you're comparing across books. Bet365 quotes you decimals, Kalshi quotes you cents, Polymarket quotes you a share price — but a 3-cent move on Polymarket and a swing from 1.83 to 1.92 on Bet365 are the same kind of event once you convert. The detector lives in IP-space for exactly this reason.

You don't need to do the conversion in your head. Just remember: everything on the board, every market, every source, is sitting on a 0-to-1 line. That's what the detector watches move.`,
    formal: String.raw`Implied probability normalizes a quote into the unit interval so cross-venue markets become comparable. For decimal odds $d$ (Bet365 via OddsAPI), $\text{IP} = 1/d$. For American odds $a$, $\text{IP} = 100/(a+100)$ when $a>0$ and $\text{IP} = -a/(-a+100)$ when $a<0$. For Polymarket and Kalshi, the contract price is already in IP units: a share trading at $0.62$ is $\text{IP} = 0.62$.

$$\text{IP} = \begin{cases} 1/d & \text{(decimal)} \\ 100/(a+100) & \text{(American, } a>0\text{)} \\ p_{\text{contract}} & \text{(Polymarket, Kalshi)} \end{cases}$$

The board-MAD detector operates on $\Delta \text{IP}$ rather than $\Delta \text{odds}$ because IP is bounded in $[0,1]$ and dimensionally consistent across sources. A 0.03 IP move means the same thing whether it came from a binary contract or a converted moneyline. This is why ingestion converts every venue's native quote to IP at the worker layer before any signal logic runs.`,
  },

  "volume-log1p": {
    title: "Volume weighting (log1p)",
    eli5: String.raw`Not every market deserves an equal vote. A penny move on a market with $100k of volume sitting on it is real information — somebody with size is pushing. A penny move on a market with $12 of volume is two guys in a group chat. We don't want the detector treating those the same.

But we also don't want one mega-volume market — a championship moneyline with millions on it — to drown out everything else on the board. So instead of weighting by raw volume, we weight by log1p of volume. That means a market with 100x more volume gets maybe 2-3x more weight, not 100x.

It's a compromise: liquid markets count more, but the board still gets to vote as a board. No single fat market hijacks the signal.`,
    formal: String.raw`Each market's contribution to the board statistic is weighted by $w(v) = \log(1 + v)$, where $v$ is the market's volume over the relevant window. The $+1$ avoids the singularity at $v=0$ for cold markets.

$$w(v) = \log(1 + v)$$

Linear weighting ($w(v) = v$) was rejected because NBA market volume is heavy-tailed: a handful of moneyline and spread markets carry 10-100x the volume of long-tail props, and linear weights let those few markets dictate the board statistic — defeating the purpose of a multi-market consensus detector. Square-root weighting ($w(v) = \sqrt{v}$) was also tested but left too much tail influence: the top 3 markets still accounted for the majority of board mass in typical games. Log1p compresses 6 decades of volume into roughly 14 weight units, producing a board statistic where liquid markets are favored but no single market exceeds roughly 5-10% of total weight in practice.`,
  },

  "heartbeat-tick": {
    title: "Heartbeat tick",
    eli5: String.raw`A heartbeat is a row in the database that says "this market is still alive, nothing changed." When no new quote has come in for a market for a while, the ingestion worker writes one of these so we can tell the difference between "market is quiet" and "the feed died."

That's useful for monitoring. It's noise for the detector. A heartbeat tick has the same price as the previous real tick, so if we left them in, we'd be measuring a bunch of zero-deltas that aren't really information — they're just timestamps. Worse, in some edge cases they distort the trailing windows.

So before any signal math runs, we drop every row where \`is_heartbeat = true\`. Whatever is left is real price activity from real quotes.`,
    formal: String.raw`Heartbeat ticks are synthetic rows emitted by the ingestion worker on a fixed cadence when no genuine quote update has arrived for a market within the heartbeat interval. They carry the previous quote's price unchanged and exist solely to distinguish a quiet market from a dead feed for liveness monitoring.

$$T_{\text{clean}} = \{ t \in T : t.\text{isHeartbeat} = \text{false} \}$$

The sanitation pass filters $T_{\text{clean}}$ before any consecutive-tick delta computation $\Delta p_m = p_{m,i} - p_{m,i-1}$. Leaving heartbeats in would inject structural zero-deltas at the heartbeat cadence, biasing the trailing MAD downward (the denominator in the fire rule), which would in turn inflate the standardized score and produce spurious fires once a real quote finally arrived. Filtering occurs at the bucketing layer in \`scripts/board_signal_v2.py\`, upstream of both the board-MAD and off-price-print detectors so every downstream consumer sees only genuine price observations.`,
  },

  "opening-anchor-0500": {
    title: "Opening anchor (Polymarket 0.500)",
    eli5: String.raw`When a Polymarket market first opens, the book seeds it at 50 cents — exactly 0.500 — before any real trading has happened. It's a placeholder, not an opinion. Whoever made the market hasn't priced anything yet; they just need a starting point.

Then the first real trade comes in. Maybe it prints at 0.62. If we didn't filter, the detector would see a 12-cent move on tick one and light up like the building was on fire. But nothing actually happened — it's just the market waking up.

So we drop every Polymarket tick that sits at exactly 0.500. Yes, in theory a real market could legitimately trade at exactly 0.500 later in its life — but exact 0.500 prints on a continuous-priced market are rare enough that we accept the collateral. The alternative, leaving the anchors in, would generate huge false fires on every market open.`,
    formal: String.raw`Polymarket's market-maker seeds new markets at exactly $\text{IP} = 0.500$ prior to genuine price discovery. The first real quote can be far from this anchor — moves of 0.10-0.30 IP units on the transition from anchor to first organic price are typical — producing a delta that would dominate any trailing MAD baseline and trigger spurious board-MAD fires at every market open in a game.

$$T_{\text{clean}} = \{ t \in T : \neg(t.\text{source} = \text{Polymarket} \land t.\text{impliedProbability} = 0.500) \}$$

The sanitation pass drops any Polymarket tick where the implied probability is exactly $0.500$, prior to delta computation. The exactness of the equality test matters: organic Polymarket prices are quoted in cents but the actual order book can produce values like $0.4998$ or $0.5002$ that are not synthetic anchors. A real later tick landing on exactly $0.500$ is statistically rare and treated as acceptable collateral loss; the alternative — leaving anchors in — generates large, predictable false positives at every market open and is the worse failure mode for a precision-sensitive detector.`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  //  US-053 — Signal timing controls + Settings tooltip audit
  // ──────────────────────────────────────────────────────────────────────────

  "trailing-window-memory": {
    title: "Filter memory",
    eli5: String.raw`Filter memory is how much recent game context the board state-space model treats as relevant when it updates the current regime. While the trigger controls how surprising a bucket has to be, memory controls how fast the baseline is allowed to adapt.

The number is a bucket count, and the small time readout is exact: bucket count × bucketSeconds. With the current one-minute buckets, 20 means 20 minutes. If the bucket size changes, the parenthetical minutes/seconds update with it.

Twenty minutes (the default) is the current compromise: long enough that one quiet stretch doesn't jerk the baseline around, short enough that the model still adapts when the game shifts gears. Crank it down and the filter reacts faster; crank it up and it stays steadier but lags regime changes more.

Filter memory is paired with Alert holdoff in the UI because the opening minutes depend on both. At the default setup, the first active alert check happens only after enough elapsed time has passed for the model to trust its state.`,
    formal: String.raw`This slider controls the state filter's effective memory horizon. In the current sidecar implementation it sets the decay and adaptation scale of the latent level/trend state, so smaller values make the baseline track local non-stationarity faster while larger values stabilize the latent state at the cost of regime lag. Canonical runtime implementation: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "settings-detector-defaults": {
    title: "Detector defaults",
    eli5: String.raw`These are the values the live Recent and Live pages use when they run the whole-board state-space model. Backtest lets you compare changes in a replay window, but the live path still needs one fixed configuration per run — these are it.

Editing a value here writes a JSON file the API picks up within five seconds. There's no restart, no deploy, no commit. The next request reads the new defaults and the board-model version string gets a hash suffix so any cached results for the old defaults get re-computed.

Use this when the labeled-event set shifts and the canonical sensitivity or signal timing should move with it. Don't use this for one-off comparisons — that's what Backtest is for.`,
    formal: String.raw`The detector-defaults service backs \`POST /v1/settings/detector-defaults\` with a Zod-validated, atomically-written JSON file at \`~/signal-console/data/detector-defaults.json\`. Live board requests and Backtest parameter promotion both read from this file at request time with a 5-second in-process TTL cache.

Cache invalidation: the runtime \`board-mad\` detector version is derived as \`detector.version + '+def.<8-hex>'\` from the SHA-256 of the resolved defaults whenever they diverge from the package-declared baseline. The cache discriminator \`(detector_id, detector_version, params_hash, source_watermark_hash, scope, ...)\` therefore changes whenever any default changes, and the next cache lookup misses — no manual \`/v1/cache\` flush needed.`,
  },

  "settings-k-mad-live": {
    title: "Live trigger",
    eli5: String.raw`This is the innovation trigger the Recent list and the Live page use by default. Lower values make it easier for a bucket to count as surprising; higher values make the board model calmer.

If you're calibrating against real market behavior, this is still the knob you'll move most. Move it up and the Live page reports fewer board fires; move it down and it reports more — both within seconds, no restart.`,
    formal: String.raw`Runtime override for the state-space model's innovation trigger strength. The request field still uses the legacy \`kMadLive\` name for compatibility, but the live Python sidecar interprets it as the trigger parameter that sets the standardized-innovation gate for whole-board alerts.`,
  },

  "settings-bucket-seconds": {
    title: "Bucket size",
    eli5: String.raw`How wide each board-volatility measurement is. Sixty seconds is the live default for the opening-ramp profile. The historical profile can use thirty seconds so quick timeout and late-game bursts do not disappear inside a full minute.

Changing this is a real detector change, not a cosmetic chart setting. It changes which quote ticks are summed into each intensity bucket, so cached runs recompute.`,
    formal: String.raw`Runtime default for \`bucketSeconds\`, the aggregation width $\Delta t$ used by Board MAD prebucket. The historical/live profile keeps memory in game-clock minutes but still measures current intensity in fixed wall-clock buckets, so $\Delta t=30$ s can coexist with a 12-game-minute memory horizon. Canonical implementation: \`packages/detectors/src/board-mad/prebucket.ts\`.`,
  },

  "settings-baseline-mode": {
    title: "Prior anchor",
    eli5: String.raw`Which causal anchor the live board model trusts while it builds its baseline. Pure trailing state trusts only the filter's recent state. Opening anchor ramp starts from the opening game buckets, then fades toward the live filter. Historical prior blend starts from last-five same-side games, then fades toward current-game volatility.

This is the switch that makes Backtest and live behavior match. If you promote historical mode here, live/Recent use the historical prior path too.`,
    formal: String.raw`Runtime default for \`baselineMode\`. \`"trailing"\` uses only the state filter's causal memory. \`"opening-ramp"\` adds an opening-game anchor sized by \`openingBaselineBuckets\` and fades it out by \`openingRampCompleteBuckets\`. \`"historical-blend"\` adds per-game priors from last-five away/home games, mixes them with current-game and recent wall-memory anchors, and fades the historical share by game-clock elapsed time. Canonical runtime: \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`.`,
  },

  "settings-opening-baseline-buckets": {
    title: "Opening anchor sample",
    eli5: String.raw`How many opening buckets define the early-game anchor when Prior anchor is Opening anchor ramp. This decides how much of the early baseline comes from the first stretch of the game instead of the live filter alone.`,
    formal: String.raw`Runtime default for \`openingBaselineBuckets\`, the initial opening-anchor sample duration in bucket units. It only changes detector math when \`baselineMode="opening-ramp"\`, but when active it directly shapes the opening anchor distribution used by the state-space model.`,
  },

  "settings-opening-ramp-complete-buckets": {
    title: "Opening anchor fade-out",
    eli5: String.raw`The bucket where the opening anchor has fully faded out and the live state filter is on its own. Smaller values trust current-game movement faster; larger values keep opening behavior in charge longer.`,
    formal: String.raw`Runtime default for \`openingRampCompleteBuckets\`. Before this elapsed duration, the opening anchor still contributes to the latent baseline; at and after it, the filter relies entirely on its current state and any non-opening priors.`,
  },

  "settings-trailing-buckets": {
    title: "Filter memory",
    eli5: String.raw`Live setting for how much recent elapsed current-game time shapes the board filter's memory horizon. Twenty one-minute buckets means the filter adapts on roughly a 20-minute timescale.`,
    formal: String.raw`Live override for \`trailingBuckets\`, the main state-memory horizon used by the whole-board filter. Smaller values adapt faster to regime changes; larger values stabilize the latent baseline and volatility regime.`,
  },

  "settings-warmup-buckets": {
    title: "Alert holdoff",
    eli5: String.raw`How long the opening lockout lasts before the board model is allowed to fire at all. Default 8 one-minute bucket durations — enough current-game time to estimate a real state, not so much that you miss the entire early game.`,
    formal: String.raw`Live override for the elapsed warmup gate. Buckets with elapsed time below \`warmupBuckets × bucketSeconds\` are unconditionally non-fires regardless of their innovation score.`,
  },

  "settings-fresh-cap-seconds": {
    title: "Freshness cap (seconds)",
    eli5: String.raw`If two consecutive ticks on the same market are more than this many seconds apart, the delta between them doesn't count. Stops suspensions and feed dropouts from looking like sudden price moves.`,
    formal: String.raw`Live override for $\tau_{\max}$, the per-market inter-tick gap threshold above which $\Delta p_{m,i}$ is zeroed. Range $[30, 3600]$ s; default $\tau_{\max} = 300$ s. See \`fresh-cap-seconds\` for the empirical rationale.`,
  },

  "settings-historical-last-games": {
    title: "Historical games",
    eli5: String.raw`How many prior same-side games feed the opening historical prior. Five means "last five Cavs road games" for the away side and "last five Knicks home games" for the home side.`,
    formal: String.raw`Runtime default for \`historicalLastGames\`. The prior builder finds games before the target game where the away team was also away and the home team was also home, then summarizes their opening Board MAD intensities with median and MAD.`,
  },

  "settings-historical-away-weight": {
    title: "Away/home split",
    eli5: String.raw`How the two historical sides are mixed. The default 0.5 is the direct 50/50 idea: half away team in away context, half home team in home context.`,
    formal: String.raw`\`historicalAwayWeight\` combines side priors as $p = w p_{\text{away}} + (1-w)p_{\text{home}}$. Default $w=0.5$. If one side has no usable prior sample, the available side is used alone.`,
  },

  "settings-historical-prior-weight": {
    title: "Opening prior share",
    eli5: String.raw`How much the historical prior matters at the very beginning. Default 1 means the earliest active baseline starts from history, then game data takes over as the ramp progresses.`,
    formal: String.raw`\`historicalPriorWeight\` is the starting share of the historical prior before ramp-out. The effective share is $\alpha_t = \alpha_0 \max(0, 1 - e_t / R)$ where $e_t$ is game-clock elapsed seconds and $R$ is \`historicalRampCompleteGameMinutes\` in seconds.`,
  },

  "settings-historical-ramp-complete-game-minutes": {
    title: "History ramp-out",
    eli5: String.raw`The game-clock minute where the historical prior has fully faded out and the baseline is current-game only. Default 12 game minutes.`,
    formal: String.raw`Runtime default for the historical ramp horizon. At elapsed game time $e_t \ge R$, historical share is zero and the baseline is built from current-game memory only. Wall-clock timeouts do not advance this ramp unless the PBP clock has advanced.`,
  },

  "settings-trailing-game-minutes": {
    title: "Historical game memory",
    eli5: String.raw`How much current-game action defines the historical-blend live anchor. Default 12 game minutes means timeouts and long dead-ball stretches do not erase useful on-court context just because wall-clock time passed.`,
    formal: String.raw`\`trailingGameMinutes\` defines the game-clock horizon for the current-game anchor inside \`historical-blend\`. It is separate from wall-clock bucket memory, so the model can remember real game action through timeouts and other dead-ball stretches.`,
  },

  "settings-recent-wall-minutes": {
    title: "Recent wall-memory",
    eli5: String.raw`The short wall-clock anchor added on top of game-clock memory. It catches betting bursts during timeouts and other dead-ball stress windows, where the game clock is frozen but the market is still moving fast.`,
    formal: String.raw`\`recentWallMinutes\` adds a short wall-clock anchor to \`historical-blend\`. The sidecar builds a recent transformed-score anchor from that wall window and combines it with the game-clock anchor before the innovation step.`,
  },

  "settings-recent-wall-weight": {
    title: "Recent wall-memory weight",
    eli5: String.raw`How loudly the recent wall-memory anchor speaks compared with the game-clock anchor. Default 1.5 makes the last few wall minutes matter more without replacing the game-clock context entirely.`,
    formal: String.raw`\`recentWallWeight\` is the relative precision weight assigned to the recent wall-clock anchor when both the game-clock and wall-clock anchors exist in \`historical-blend\`. Larger values make timeout-era market stress pull the baseline harder.`,
  },

  "settings-state-space-config": {
    title: "State-space config",
    eli5: String.raw`This is the full advanced model object, not just a loose bag of extra numbers. It contains the internal choices that shape how the board model behaves: trigger math, breadth normalization, process noise, measurement noise, anchor handling, and variance adaptation.

The point of exposing it as one structured JSON object is honesty and portability. Data-engineering or stats people can tune the actual model without spelunking Python literals, and the exact same object can travel through Settings, Backtest, saved defaults, and bakeoff runs.`,
    formal: String.raw`Nested runtime config for the Python board state-space model. The object is validated end-to-end by \`BoardStateSpaceConfigSchema\` in \`packages/detectors/src/board-mad/state-space-config.ts\`, serialized through detector defaults and backtest params, and consumed by \`apps/nba-sidecar/src/nba_sidecar/volatility.py\`. This is the canonical home for advanced tunables such as trigger coefficients, breadth exponent, process-noise terms, observation-noise weights, anchor floors, and variance-adaptation limits.`,
  },

  "settings-pbp-pre-buffer-ms": {
    title: "PBP pre-buffer (ms)",
    eli5: String.raw`How far before the first play-by-play timestamp to start reading quote ticks. 5 minutes by default — long enough to seed the trailing baseline without dragging in pre-game noise.`,
    formal: String.raw`Pre-game buffer applied to \`MIN(nba_play_by_play_actions.time_actual)\` when narrowing the per-game in-play tick window. The same buffer is shared between \`services/board.ts\` and \`services/backtest.ts\` so the Live path and the Backtest path see identical ticks for the same game; without this narrowing, gold-DB \`quote_ticks\` rows for a single game routinely span 24+ hours and inflate fire counts ~14-17×.`,
  },

  "settings-pbp-post-buffer-ms": {
    title: "PBP post-buffer (ms)",
    eli5: String.raw`How far after the last play-by-play timestamp to keep reading ticks. 60 seconds by default — captures the post-event watcher confirmations without bleeding into the next session.`,
    formal: String.raw`Post-game buffer applied to \`MAX(nba_play_by_play_actions.time_actual)\` when narrowing the per-game in-play tick window. Symmetric counterpart to \`settings-pbp-pre-buffer-ms\`; together they bound the in-play tick set that feeds the detector.`,
  },

  "settings-off-price-min-volume-share": {
    title: "Off-price min volume share",
    eli5: String.raw`How big a Polymarket trade-print has to be (as a share of total market volume) before it qualifies as a potential off-price signal. 0.1 (10%) by default — small trades get ignored.`,
    formal: String.raw`\`offPriceMinVolumeShare\` in the runtime detector defaults. Used by both \`/v1/off-price-print/:gameId\` and the offprice lane inside \`/v1/ensemble-or/:gameId\`. The detector requires \`volumeShare >= offPriceMinVolumeShare AND offPriceDistance >= offPriceMinOffPriceDistance\` to fire. Editing this invalidates off-price cache rows via the runner's paramsHash on next access.`,
  },

  "settings-off-price-min-off-price-distance": {
    title: "Off-price min distance",
    eli5: String.raw`How far the trade price has to deviate from the most recent quoted implied probability before it counts as an off-price print. 0.4 by default — trades within 40% of the standing market are noise; trades farther away are the headline signal.`,
    formal: String.raw`\`offPriceMinOffPriceDistance\` in the runtime detector defaults. The detector compares \`|trade_price - latest_pre-event_implied_probability|\` to this threshold (computed at query time via a causal subquery in \`services/loaders/microstructure-loader.ts\`). Editing this invalidates off-price cache rows via the runner's paramsHash on next access.`,
  },

  "settings-db-path": {
    title: "Gold DB path",
    eli5: String.raw`The absolute path to the 54 GB read-only tick store. All API code opens this through a four-guard wrapper (URI mode=ro, options.readonly:true, fileMustExist:true, PRAGMA query_only=ON) and throws if any of those fails. Nothing in the API layer can write to it.`,
    formal: String.raw`\`GOLD_DB_PATH\` from \`packages/db/src/open.ts\`. Opens via \`openGoldDb(path)\` which applies four independent read-only guards and verifies \`PRAGMA query_only\` reads back as 1, throwing at startup otherwise. The path is fixed at \`~/signal-console/data/signal-console.sqlite\` after the Phase-0 relocation.`,
  },

  "settings-db-mode": {
    title: "DB mode",
    eli5: String.raw`Should always say "read-only". If it ever says anything else (or shows the red banner above), something has bypassed the openGoldDb wrapper — that's a bug, not a configuration issue, and the API will refuse to start.`,
    formal: String.raw`Reported by the settings service as \`'read-only'\` when \`openGoldDb()\` succeeds and the post-open \`PRAGMA query_only\` read confirms the guard is active, else \`'error'\` with an attached \`openError\` message. The four guards (URI \`mode=ro\`, \`{ readonly: true, fileMustExist: true }\`, \`busy_timeout=5000\`, \`PRAGMA query_only=ON\`) are documented in \`packages/db/src/open.ts\` and project CLAUDE.md.`,
  },

  "settings-db-wal-bytes": {
    title: "WAL bytes",
    eli5: String.raw`SQLite's write-ahead log. When the value is greater than zero against this read-only DB, it means a writer (the ingest worker, the nba-predict shadow, etc.) is currently appending — the read snapshot is consistent up to its commit point. A persistently large WAL with no writer attached can indicate a stale checkpoint.`,
    formal: String.raw`Size in bytes of \`signal-console.sqlite-wal\` measured via \`fs.statSync\`. Co-exists with the read-only handle: WAL mode is the gold DB's persistent journal mode, and read transactions see a snapshot at their start point regardless of concurrent writes. Persistent large WAL with no active writer suggests a missing \`PRAGMA wal_checkpoint(TRUNCATE)\` from the writer side.`,
  },

  "settings-db-page-count": {
    title: "Page count",
    eli5: String.raw`Number of fixed-size pages allocated to the gold DB file. Total file size ≈ page count × page size. Useful for sanity-checking against the human-readable bytes figure above.`,
    formal: String.raw`\`PRAGMA page_count\` against the gold DB handle. Page count × page size approximates \`SELECT page_size * page_count FROM PRAGMA_PAGE_COUNT\` and equals on-disk size minus the WAL and freelist overhead.`,
  },

  "settings-db-page-size": {
    title: "Page size",
    eli5: String.raw`Bytes per SQLite page on the gold DB. 4096 by default; better-sqlite3 doesn't change this without a vacuum. Mostly informational.`,
    formal: String.raw`\`PRAGMA page_size\`. Fixed at file-creation time; changing requires a \`VACUUM\` rebuild. 4096 is the SQLite default and the value used by the gold DB.`,
  },

  "settings-db-last-modified": {
    title: "Last modified",
    eli5: String.raw`Filesystem mtime of the gold DB. If the writer (ingest worker or nba-predict shadow) is running, you'll see this advance every few minutes; if it's flat, the writer is paused or the file is sealed.`,
    formal: String.raw`\`fs.statSync(path).mtime.toISOString()\`. Reflects last write to the main DB file; WAL appends update the WAL file's mtime separately, so a moving \`settings-db-wal-bytes\` with a stationary main-file mtime is the normal pattern for an active writer.`,
  },

  "settings-source-heartbeat": {
    title: "Source heartbeat",
    eli5: String.raw`When the ingest worker is running, it writes a small heartbeat file every cycle reporting per-source last-sync timestamps and last errors. If the file is missing, the Sources section shows "Ingest paused" with the last-known values from the prior session — that's the right read when you've intentionally stopped the worker.`,
    formal: String.raw`Heartbeat path: \`~/signal-console/apps/worker/data/heartbeat.json\`. Schema: \`{ sources: Record<string, { lastSyncAt, lastError, rateLimitCooldown }> }\`. Absence of the file flips the response to the \`ingestPaused: true\` variant with the last known values from the prior settings snapshot. The route does not interpret pause state — it simply reports what's on disk.`,
  },

  "settings-source-last-sync": {
    title: "Last sync",
    eli5: String.raw`Timestamp of the most recent successful pull from this source. If it's older than the heartbeat interval and "Last error" is blank, the source is up but quiet (no new quotes since); if "Last error" has text, the source has been failing since at least this timestamp.`,
    formal: String.raw`\`lastSyncAt\` field in the heartbeat per-source entry. ISO 8601 string or null. Compared against current time to derive a freshness indicator in the table.`,
  },

  "settings-source-last-error": {
    title: "Last error",
    eli5: String.raw`The most recent error string the worker logged for this source. HTTP 429s, parse failures, auth rotations all surface here. Useful first-line debugging when fires drop unexpectedly: if one source is silent, the board-MAD sum is missing that source's contribution and intensity will be lower.`,
    formal: String.raw`\`lastError\` field in the heartbeat per-source entry. Free-text string carried verbatim from the worker's error logger; null when the source is healthy.`,
  },

  "settings-source-rate-limit": {
    title: "Rate-limit cooldown",
    eli5: String.raw`If the source returned a 429 with a Retry-After header, this is how long the worker is parking before it tries again. Format is ISO-8601 duration (e.g. PT30S = 30 seconds).`,
    formal: String.raw`\`rateLimitCooldown\` field in the heartbeat per-source entry. ISO 8601 duration string; the worker stops issuing requests to this source for the duration after a 429. Null when no cooldown is active.`,
  },

  "settings-errors-filter": {
    title: "Errors filter",
    eli5: String.raw`The Errors panel tails the last 200 lines of the API log. Use this dropdown to filter to a single severity level — usually you want "error" or "warn" when chasing an incident.`,
    formal: String.raw`Filters the in-memory tail of \`~/signal-console/apps/api/data/api.log\` by Pino \`level\` (\`info | warn | error | debug | fatal | trace\`). The cap is enforced after filtering, so the filtered view shows up to 200 entries at the selected level.`,
  },

  "settings-app-version": {
    title: "App version",
    eli5: String.raw`The version string from the API's package.json — useful when reproducing a bug to know exactly which build is running.`,
    formal: String.raw`Sourced from \`apps/api/package.json#version\` at startup. Sent to clients verbatim; not derived from git tags.`,
  },

  "settings-detector-versions": {
    title: "Detector versions",
    eli5: String.raw`Each registered detector and its current version string. When you change a detector's algorithm or default parameters, the version bumps and cached results for the old version naturally become misses. For board-mad, you'll see a "+def.<hash>" suffix when the runtime defaults file overrides the package baseline — that's how the cache invalidates when you tune sensitivity.`,
    formal: String.raw`For each entry in \`@signal-console/detectors/registry\`, reports its package-declared version. For \`board-mad\` specifically, the version is \`detector.version + '+def.<sha256(defaults).slice(0,8)>'\` whenever the resolved detector-defaults JSON differs from the package baseline. The SemVer build-metadata suffix is ignored by version comparators but does discriminate cache rows.`,
  },

  "settings-db-schema-version": {
    title: "DB schema version",
    eli5: String.raw`The integer SQLite \`user_version\` stamped on the gold DB at migration time. Useful to confirm the read-only handle is seeing the schema you expect.`,
    formal: String.raw`Read via \`PRAGMA user_version\` against the gold DB at request time. The writer (ingest worker / nba-predict shadow) bumps this on every successful migration; readers use it as a sanity check that the file they opened matches the schema they expect.`,
  },
} as const satisfies Record<string, Explainer>;

export type ExplainerId = keyof typeof explainers;
