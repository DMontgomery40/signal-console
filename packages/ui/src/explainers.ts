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
    title: "Board MAD detector",
    eli5: String.raw`This is the headline suspend signal the app exists to surface. The idea is simple: when every market on the same game starts wiggling at once — moneyline, spread, totals, player props all moving together — somebody knows something the market doesn't. A single market moving is noise; a whole board moving in unison is information arriving.

The detector watches every quoted market on a game in real time. Each minute, it sums up how much the implied probabilities are changing across the entire board, weighted by where the money is. Then it compares that minute to how wiggly the board has been over the prior twenty minutes. If the current minute is much wigglier than the prior twenty, it fires — and that's the suspend signal you'd send to a trading desk: "pause this game, prices may be stale."

Two knobs to know about: the dial ($K_{\rm MAD}$) controls how big the spike has to be before firing — lower K = more fires, higher K = quieter. And the warmup gate controls how many minutes of history we need before allowing any fires at all (early in the game we have too little history to compare against). Everything else is set and forget.`,
    formal: String.raw`The detector computes a per-game, per-bucket intensity $I_t$ as the weighted sum of absolute implied-probability deltas across all markets $m \in \mathcal{M}_g$ on game $g$ during bucket $t$ (default $\Delta t = 60$ s):

$$I_t = \sum_{m \in \mathcal{M}_g} \sum_{i \in t} w(v_{m,i}) \cdot \left| \Delta p_{m,i} \right|$$

where $\Delta p_{m,i}$ is the implied-probability change between consecutive in-bucket ticks of market $m$ (subject to the $\tau_{\max}$ freshness cap), and $w(v) = \log(1+v)$ is the volume weight. A bucket fires when it exceeds a trailing causal baseline:

$$\text{fire}_t \iff I_t > \mathrm{median}(I_{t-W..t-1}) + K \cdot \mathrm{MAD}(I_{t-W..t-1})$$

with trailing window $W$ (default 20), warmup $W_0$ (default 8), and the K-multiplier $K$ (default 3.0 live, 6.0 comparison preset). MAD over standard deviation is deliberate: a single outlier bucket would dominate $\sigma$ but barely move the median, so the threshold remains stable through transient spikes. Canonical reference: \`scripts/board_signal_v2.py\`.`,
  },

  "k-mad": {
    title: "K (the Cry Wolf dial)",
    eli5: String.raw`$K$ is the dial — the only knob most people will ever touch. It controls how big a board-wide spike has to be before the detector calls it a fire. Lower $K$ means more fires (we catch more events but you'll also see more false alarms); higher $K$ means fewer fires (calmer, but you might miss some real events).

The intuition: every minute we compare the current wiggle to the median wiggle of the prior twenty minutes plus $K$ times their typical variation. So at $K = 3$ the current minute has to be three "typical variations" above the median to count; at $K = 6$ it has to be six. Higher bar = fewer fires.

Two presets are labeled on the dial: "Sensitive" at $K = 3$ and "Calm" at $K = 6$. Sensitive is what runs in production all day — about 18 fires per game, caught 5 of 6 known suspend events in backtest. Calm is for comparison — about 9 fires per game, quieter but with edge-case misses. The dial in Backtest lets you sweep between them and see what each setting would have caught on past games.`,
    formal: String.raw`$K$ is the multiplier on the trailing MAD in the board-MAD fire rule:

$$\text{fire}_t \iff I_t > \mathrm{median}(I_{t-W..t-1}) + K \cdot \mathrm{MAD}(I_{t-W..t-1})$$

Choice of $K$ trades recall against precision. In the suspend-signal application the per-fire review cost (seconds of human attention) is much smaller than the miss cost (an exposed stale market exploited by an informed counterparty), so recall is prioritized and the live default is $K = 3.0$.

Empirical anchors on the 64-game PBP-anchored backtest fixture set:

| $K$ | Fires/game (volume-weighted) | Recall on labeled events |
|---|---|---|
| 3.0 | $\approx 19.5$ | 5 of 6 |
| 6.0 | $\approx 8.6$  | high-confidence subset |

$K$ is a compute parameter only — it never enters the gold DB. Both anchor values are declared once in \`packages/detectors/src/board-mad/config.ts\`; changing either bumps the detector version so cache rows invalidate naturally and downstream consumers recompute on first read.`,
  },

  "k-mad-sensitive": {
    title: "K = 3.0 — Sensitive (live default)",
    eli5: String.raw`This is the production setting. Every Recent and Live screen you see in this app is running at $K = 3$ behind the scenes. The Backtest dial lets you compare other values, but everything else lives here.

What you get at $K = 3$: about 18 candidate fires per game across the 64-game backtest set, with 5 of 6 known suspend events recovered. That's a high-recall configuration — you'll see more fires than you'd manually act on, and that's intentional. The expected use case is a desk operator scanning Recent's per-game fire counts, opening anything that looks elevated, and confirming or ignoring at a glance.

If the volume feels like too many false alarms in practice, the right answer isn't to nudge $K$ up — it's to add a second filter downstream (a confidence score, a phase-of-game gate, anything you can validate). $K$ is locked at 3 for the live path because the empirical recall curve is steepest right around this value.`,
    formal: String.raw`$K_{\rm MAD,live} = 3.0$ with volume weighting is the canonical live operating point, declared in \`packages/detectors/src/board-mad/config.ts\` and matching the \`BOARD_VW_K_MAD = 3\` constant in the legacy \`nba-predict\` TypeScript runtime at \`game-state-volatility.ts:24-340\`.

Empirical characterization on the project's 64-game PBP-anchored fixture set:

$$\overline{F/G}\bigg|_{K=3,\,\text{vol}} \approx 19.5, \qquad \text{recall on } \mathcal{E}_{\text{labeled}} = 5/6$$

The recall floor of 5 of 6 known events is the load-bearing decision criterion — the one missed event (Reaves on \`nba-0042500223/224\`) is the report's honest null case for the board lane and is not recoverable by reducing $K$ alone (the event has no board-wide volatility signature; it appears in the off-price-print lane instead). The contract test \`packages/detectors/src/board-mad/__tests__/canonical.test.ts\` pins the K=3 outcomes against committed JSON fixtures to prevent silent drift.`,
  },

  "k-mad-calm": {
    title: "K = 6.0 — Calm (backtest comparison preset)",
    eli5: String.raw`This is the calmer comparison point on the dial. At $K = 6$ the detector fires about half as often as it does at $K = 3$ — roughly 9 per game on the backtest set instead of 18 — because we're requiring six "typical variations" above the median wiggle to trigger, twice the threshold.

Calm exists on the dial as a reference point, not a recommended setting. It's the value the original research backtest was written around (the Python script's default), and pinning it as a labeled snap makes it cheap to sanity-check: move the dial to Calm, see which fires survive, ask whether they're the right ones.

In production we never run the live system at $K = 6$ — too many real events get missed at that sensitivity. If the dial in Backtest shows you something interesting at $K = 6$ specifically, it's almost certainly a high-confidence event also visible at $K = 3$. The interesting comparison is usually the other direction: things that fire at $K = 3$ but not at $K = 6$ are the edge-case sensitivity gains.`,
    formal: String.raw`$K_{\rm MAD,calm} = 6.0$ is the comparison-only preset, matching the original Python research backtest's default \`K_MAD = 6.0\` in \`scripts/board_signal_v2.py:33\`. It is exposed only in Backtest UI and never used by Live or Recent surfaces.

Empirical anchors from the same 64-game PBP-anchored set as the live preset:

$$\overline{F/G}\bigg|_{K=6,\,\text{eq}} = 9.3 \pm 1.0, \qquad \overline{F/G}\bigg|_{K=6,\,\text{vol}} = 8.6 \pm 1.0$$

Contract tests pin two specific event-level outcomes at $K=6$: (1) Hartenstein (event \`2026-05-08T03:12:36.8Z\`, game \`nba-0042500222\`) fires with bucket-start \`03:12:00Z\` and watcher-confirmation bucket-end \`03:13:00Z\` ($\approx$ T+23 s after the event); and (2) Reaves (event \`2026-05-12T04:51:40.2Z\`, games \`nba-0042500223/224\`) does **not** fire on either game — the report's honest null case for the board lane. These outcomes are locked in \`packages/detectors/src/board-mad/__tests__/canonical.test.ts\` against committed JSON fixtures; any drift is a review event.`,
  },

  mad: {
    title: "MAD — Median Absolute Deviation",
    eli5: String.raw`MAD is a way to measure how spread-out a list of numbers is, without letting one weird value mess up the measurement. Think of it as the "typical wiggle" — most numbers stay within one MAD of the median; a number more than several MADs out is genuinely unusual.

The everyday alternative is standard deviation, and the two answer the same question — but standard deviation is fragile. One contaminated value can dominate it. If twenty minutes of intensity look like \`[12, 14, 13, 11, 15, 12, 14, 13, 12, 14, 13, 12, 11, 14, 13, 12, 13, 14, 12, 88]\` because some weird thing happened in the last bucket, standard deviation will tell you the typical wiggle is huge. MAD will tell you the typical wiggle is ~1, because the median didn't move and most absolute deviations from it are still ~1.

In this app, MAD is what sets the spike threshold for the suspend detector. We want the threshold to reflect "what normal felt like" — and "normal" should not be redefined by the one outlier we're trying to detect.`,
    formal: String.raw`The Median Absolute Deviation of a sample $x = (x_1, \ldots, x_n)$ is:

$$\mathrm{MAD}(x) = \mathrm{median}_i\!\left(\left|x_i - \mathrm{median}(x)\right|\right)$$

a robust scale estimator with a 50% asymptotic breakdown point (vs the 0% breakdown of standard deviation). For approximately Gaussian samples, $\mathrm{MAD}$ relates to the population standard deviation by $\sigma \approx 1.4826 \cdot \mathrm{MAD}$, but the board-MAD detector does NOT apply this constant — the rule is parameterized directly in MAD units via $K$, so any rescaling would just multiply through $K$.

We choose MAD over $\hat\sigma$ in the fire rule because the trailing window is contaminated by definition: it is contaminated by the events we're trying to detect, plus benign outliers (timeout-end repricing bursts, single-market liquidation cascades) that don't constitute board-wide signal. With $\hat\sigma$, a single such outlier inflates the threshold for $W$ subsequent buckets, suppressing detections we'd want to see. With MAD, the threshold is essentially unmoved by isolated outliers — the median absorbs the location shift and the median of absolute deviations from it remains close to the bulk's natural scale. A small floor (\`max(MAD, 1e-9)\`) prevents division-by-zero on degenerate quiet windows; see \`scripts/board_signal_v2.py\`.`,
  },

  "trailing-baseline": {
    title: "Trailing causal baseline (median + K·MAD)",
    eli5: String.raw`This is the heart of the detector — the rule that decides whether the current minute deserves to fire. Read it like a sentence: "the current minute's wiggle is greater than the median wiggle of the prior twenty minutes, plus K times their typical variation."

Two things to know. First: it's *causal*. We only look backward. The current bucket is judged against history that happened before it — no peeking at future data, no centered windows. This makes the detector usable in real time: at any moment we can score the current bucket against everything we know, with no future-leakage cheating.

Second: it's *trailing*. The window slides. As time moves forward, old buckets fall off the back and new ones join the front. That means the baseline adapts to the game — it knows that the third quarter is naturally noisier than the first, and that what counts as a spike in a sleepy second quarter would just be background activity in clutch time. The threshold breathes with the game.`,
    formal: String.raw`For bucket $t$ with intensity $I_t$ and a trailing window of length $W$:

$$\text{fire}_t \iff I_t > \mathrm{median}(I_{t-W..t-1}) + K \cdot \mathrm{MAD}(I_{t-W..t-1})$$

This is a robust, causal, one-sided z-score-style rule. Causal: the comparison set is strictly prior buckets (no leakage). Robust: both $\mathrm{median}$ and $\mathrm{MAD}$ have 50% breakdown — a single contaminated bucket inside the window shifts the threshold by $O(1/W)$ rather than $O(1)$, so the detector self-attenuates against the very signal it is designed to find. Adaptive: as the game progresses, the window slides forward and the threshold tracks regime changes (quarter transitions, late-game leverage, halftime quiets) without explicit phase modeling.

Equivalent formulations under various assumptions (e.g. assuming $I_t \overset{\text{iid}}{\sim}$ Gaussian, the rule corresponds to a one-sided $z$-test at $z = K / 1.4826$) are noted only for intuition — the detector does not invoke any distributional assumption in practice and is validated empirically on the labeled-event fixture set in \`canonical.test.ts\`.`,
  },

  "fires-per-game": {
    title: "Fires per game",
    eli5: String.raw`This is the rate at which the detector calls a board-wide spike on a given game. Take a window — last 24 hours, the backtest range, whatever — count how many buckets fired across all games in that window, divide by how many games. That's "fires per game."

It's the cheapest possible quality metric for a detector. Too low, you're missing things. Too high, you're crying wolf. The whole reason this dial exists is to let you see the trade-off between these two failure modes by sliding $K$ around.

Some reference numbers from the backtest set: at the live $K = 3$, about 18 fires per game on average. At the comparison $K = 6$, about 9. Real games vary — a tight, slow game might fire 5 times; a chaotic playoff game with three lead changes might fire 30. The number is most useful as a comparison ("game X is firing twice as much as the median tonight") rather than an absolute ("more than 15 = real").`,
    formal: String.raw`For a window $\mathcal{W}$ containing games $\mathcal{G}_{\mathcal{W}}$:

$$F/G_{\mathcal{W}} = \frac{\sum_{g \in \mathcal{G}_{\mathcal{W}}}\, \#\{t \in g : \text{fire}_t = 1\}}{|\mathcal{G}_{\mathcal{W}}|}$$

This is the single primary characterizer of a $(K, W, W_0, \tau_{\max}, w)$ parameter set on a given fixture window. It is reported in Backtest UI as the live preview metric as the dial moves, and committed in contract tests at the live and calm anchor values: $\overline{F/G}|_{K=3,\,\text{vol}} \approx 19.5$ and $\overline{F/G}|_{K=6,\,\text{vol}} = 8.6 \pm 1.0$ on the 64-game backtest fixture set.

Two caveats worth knowing. First, $F/G$ is averaged across games of very different lengths and information densities — a Game-7 closeout fires more than a December regular-season blowout. Per-game variance is large and the mean is the relevant aggregate. Second, the metric implicitly assumes the labeled-event base rate is approximately constant across the fixture set; when comparing fire rates across windows with different event densities, recall on labeled events (cited as e.g. $5/6$) is the comparable quantity, not $F/G$ alone.`,
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
    title: "Trailing window (buckets)",
    eli5: String.raw`This is how far back the detector looks to figure out what "normal" feels like right now. Twenty buckets at one minute each means a rolling twenty-minute memory: the median of those twenty numbers is the baseline, and the spread among them sets how big a spike has to be to count. Everything the fire rule does is relative to this window.

Make it shorter — say 10 — and the baseline gets twitchy. One quiet stretch followed by a normal flurry will look like a spike because the recent memory was artificially calm. Make it longer — say 40 — and the detector is slow to notice that the game has changed phase. Quarter starts, scoring runs, injury news settling in: all of those shift the natural intensity level, and a long window keeps dragging the old regime forward. Twenty is the compromise: long enough to be stable, short enough to adapt within a single game's arc.`,
    formal: String.raw`$\texttt{trailingBuckets}$ sets $W$, the length of the lookback window used to estimate both the location (median) and scale (MAD) of the intensity distribution under the null of "no event." The fire rule evaluated at bucket $t$ uses $\{I_{t-W}, \ldots, I_{t-1}\}$:

$$I_t > \mathrm{median}(I_{t-W..t-1}) + K \cdot \mathrm{MAD}(I_{t-W..t-1})$$

with $\mathrm{MAD}(x) = \mathrm{median}\!\left(|x_i - \mathrm{median}(x)|\right)$. Both statistics are chosen for robustness — a single contaminated bucket inside the window shifts the threshold by $O(1/W)$ rather than $O(1)$ as a mean/stdev pair would. The choice $W=20$ balances estimator variance (which falls roughly as $1/\sqrt{W}$) against non-stationarity: intra-game regime shifts (quarter transitions, late-game leverage) have characteristic durations on the order of $W \cdot \Delta t \approx 20$ min, so a longer window would systematically lag the current regime. Declared in \`packages/detectors/src/board-mad/config.ts\` and referenced canonically in \`scripts/board_signal_v2.py\`.`,
  },

  "warmup-buckets": {
    title: "Warmup (buckets)",
    eli5: String.raw`For the first eight minutes of a game we simply refuse to fire, no matter what the intensity looks like. The reason is mechanical: you can't compare today's wiggle to a trailing median until there's enough history to compute a trailing median you trust. Early in the game we don't have that — books are still settling in, volume is thin, and a "spike" off two prior buckets means nothing.

Eight is the smallest warmup that gets us past the worst of the cold-open noise without burning real signal. Even after warmup ends, the trailing window keeps growing — it starts at 8 buckets at minute 8, walks up by one each minute, and only reaches its full 20-bucket size by minute 20. So the detector is, in effect, "more confident" as the game gets older. Fires earlier in the game are evaluated against a smaller, noisier baseline; we accept that as the cost of being able to fire at all before the second quarter.`,
    formal: String.raw`$\texttt{warmupBuckets}$ defines $W_0$, the number of leading buckets for which no fire is emitted regardless of $I_t$. With $W_0 = 8$, buckets $t < W_0$ are unconditionally suppressed. The effective trailing window at bucket $i$ is $W_i = \max(0,\, i - W_0)$ growing to the full $W$ once $i \geq W_0 + W$, per \`scripts/board_signal_v2.py:131\`:

$$W_i = \max(0,\, i - W_0), \qquad i = 0, 1, 2, \ldots$$

The warmup exists because the robust statistics $\mathrm{median}$ and $\mathrm{MAD}$ require at least a handful of observations to produce a meaningful threshold — with $W_i < 3$ the MAD is structurally near-zero and any nonzero $I_t$ would trip the rule. $W_0 = 8$ is the minimum integer such that the MAD has converged to within a small constant factor of its asymptotic value under the empirical bucket distribution in the backtest set, while still allowing detections in the first quarter where roughly a third of labeled events occur. The ramp from $W_0$ to $W$ produces a known precision profile: early fires are evaluated against a smaller baseline and are correspondingly weaker evidence than late-game fires at the same $K$.`,
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
} as const satisfies Record<string, Explainer>;

export type ExplainerId = keyof typeof explainers;
