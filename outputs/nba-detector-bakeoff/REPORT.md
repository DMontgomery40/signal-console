# NBA Detector Bake-Off

Generated: 2026-05-25T21:36:29.357Z

This is an offline research artifact, not an official NBA source of truth. It scores every locally surfaced incident candidate we could ground from the previous report and archive trail, then labels anchor/data gaps instead of pretending they are misses. Positive lead seconds mean the first matching fire happened after the disputed play; negative lead seconds mean a pre-play warning.

## Coverage

- Incidents surfaced: 26
- Exact UTC anchors: 16
- Locally scoreable incidents: 14
- Denominator games with PBP windows: 1292
- Algorithms tested: 21

## Top Rows

| Algorithm                   | Caught | Pre/post caught | Mean fires/game | Episodes/game | P95 fires | Max fires | Outlier games | Median lag seconds | Report read                                                                                                                  |
| --------------------------- | -----: | --------------: | --------------: | ------------: | --------: | --------: | ------------: | -----------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| A09_volume_heavy_short      |   8/14 |             4/4 |            8.91 |          4.74 |        47 |        81 |            67 |               -1.9 | caution: Highest recall, but it is a noisy volume amplifier until flow/depth normalization and episode ranking are in place. |
| A06_wall4_timeout_sensitive |   8/14 |             4/4 |            9.86 |          5.47 |        51 |        76 |            69 |               16.1 | weak: The worst fire burden in the current run; short wall memory alone is too jumpy.                                        |
| A16_rv_bv_jump              |   6/14 |             2/4 |            7.89 |          4.84 |        43 |        95 |            67 |                131 | caution: A rough jump proxy, not true RV/BV over signed high-frequency returns.                                              |
| A12_board_fanout_range      |   6/14 |             2/4 |            8.21 |          4.75 |        46 |        78 |            67 |               66.6 | caution: 67 game(s) hit the fire-count outlier rule.                                                                         |
| A19_historical5_fanout      |   6/14 |             5/1 |            8.95 |             5 |        49 |        76 |            66 |              -18.5 | caution: Fanout guard needs independent-market de-duplication; current raw fanout can still add fires.                       |
| A18_historical5_live_ramp   |   6/14 |             5/1 |            9.43 |          5.07 |        53 |        85 |            67 |              -18.5 | caution: Historical prior is directionally important, but this incident set mostly does not validate opening behavior.       |
| A05_game6_fast              |   6/14 |             1/5 |            9.57 |          4.34 |        55 |       100 |            66 |                131 | caution: 66 game(s) hit the fire-count outlier rule.                                                                         |
| A15_cusum_shift             |   6/14 |             4/2 |            9.75 |          5.14 |        54 |        93 |            66 |              -18.5 | caution: 66 game(s) hit the fire-count outlier rule.                                                                         |
| A03_opening_ramp_30         |   6/14 |             5/1 |            10.2 |          4.67 |     56.45 |        97 |            65 |              -18.5 | weak: Opening-ramp shape is directionally right, but this row catches too little for its fire burden.                        |
| A01_legacy_60_vw_k3         |   5/14 |             3/2 |            4.44 |          2.86 |     22.45 |        44 |            65 |               -3.9 | caution: Useful sensitive control, but fixed 60s wall buckets mix live play, whistles, timeouts, and free throws.            |

## Fire-Count Outliers

| Algorithm           | Game           | Fires | Episodes | Quote pairs | Active markets | Diagnosis                                                                                                                                  |
| ------------------- | -------------- | ----: | -------: | ----------: | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A01_legacy_60_vw_k3 | nba-0022500922 |    44 |       21 |        3181 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500973 |    41 |       20 |        2479 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500932 |    40 |       23 |        1715 |             58 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500935 |    40 |       22 |        2006 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500947 |    39 |       17 |        2773 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500932 |    39 |       23 |        1715 |             58 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500947 |    39 |       17 |        2773 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500992 |    38 |       22 |        2356 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500986 |    37 |       16 |        2902 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500973 |    36 |       20 |        2479 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A03_opening_ramp_30 | nba-0022501058 |    97 |       27 |        2087 |             62 | episode burst: repeated adjacent buckets should be reviewed as one alert episode; threshold-heavy: high fires despite modest quote density |
| A03_opening_ramp_30 | nba-0022501024 |    93 |       30 |         786 |             62 | episode burst: repeated adjacent buckets should be reviewed as one alert episode; threshold-heavy: high fires despite modest quote density |

## Actionable Formula Adjustments

| Adjustment                                    | Formula                                                                                                                            | Why it matters                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Game-clock plus wall-clock blend              | `center = (median(last12GameMin) + 1.5 * median(last4WallMin)) / 2.5; scale uses the same weights.`                                | Game action should define the main memory, while timeout/dead-ball betting pressure still gets a heavier short wall-clock overlay.  |
| Historical opening prior with sample strength | `hist = 0.5 * awayLast5AwayOpening + 0.5 * homeLast5HomeOpening; eta = ramp * priorN / (priorN + liveN + c).`                      | Keeps the user-specified home/away travel/home split while preventing tiny samples from acting fully authoritative.                 |
| Calendar zero buckets                         | `x_t = 0 when no quote/trade movement; normalize by activeMarkets_t * bucketSeconds.`                                              | Sparse-only buckets delete quiet time and make calm games look statistically absent instead of calm.                                |
| Short-window robust scale floor               | `scale = max(Qn_or_Sn(prior), 1.4826 * MAD(prior), rho * median(nonzero x), eps).`                                                 | Tiny/tied MAD windows make any nonzero move look enormous; Qn/Sn and a data-derived floor are safer for two-to-eight-minute starts. |
| Flow, not cumulative volume                   | `flow_t = max(0, volume_t - volume_{t-1}); score = sum(abs(deltaLogit) * log1p(flow_t)).`                                          | Prevents high-liquidity markets from looking alarming just because their cumulative or 24h volume is large.                         |
| Signed coherence                              | `coh = abs(sum(w_i * signedDelta_i)) / sum(w_i * absDelta_i); score *= coh.`                                                       | Board churn in mixed directions should not count like one-sided repricing.                                                          |
| Latency-tolerant source confirmation          | `confirm if another source/family has same signed move inside t +/- sourceLag.`                                                    | Same-bucket cross-source gates mostly test ingestion synchrony, not market agreement.                                               |
| Alert episodes                                | `merge fires within 90s per game/stat family; rank episodes/game and caught per 100 episodes.`                                     | A 300-fire game is usually one or several regimes repeatedly paging, not 300 separate operator decisions.                           |
| Continuous clutch/foul leverage               | `leverage = exp(-abs(margin)/4) / sqrt(max(1, secondsRemaining/24)); foulMode = sigmoid(clock, margin, FT/foul count, deadRatio).` | NBA clutch and foul modes are continuous risk regimes, not only hard final-five/final-sixty switches.                               |
| Order-flow imbalance row                      | `OFI = deltaBidSize - deltaAskSize + signedTradeSize; impact = OFI / max(depthNearMid, eps).`                                      | Depth and order flow are better microstructure signals than raw volume once book snapshots are available.                           |

## Artifact Files

- `report.html`: interactive standalone report.
- `research/bakeoff-results.json`: machine-readable source of truth.
- `research/incident-registry-expanded.json`: copied incident registry plus archive-only extras.
