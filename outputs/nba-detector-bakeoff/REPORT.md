# NBA Detector Bake-Off

Generated: 2026-05-25T08:29:54.287Z

This is an offline research artifact, not an official NBA source of truth. It scores every locally surfaced incident candidate we could ground from the previous report and archive trail, then labels anchor/data gaps instead of pretending they are misses. Positive lead seconds mean the first matching fire happened after the disputed play; negative lead seconds mean a pre-play warning.

## Coverage

- Incidents surfaced: 19
- Exact UTC anchors: 9
- Locally scoreable incidents: 6
- Denominator games with PBP windows: 62
- Algorithms tested: 21

## Top Rows

| Algorithm                       | Caught | Pre/post caught | Mean fires/game | Episodes/game | P95 fires | Max fires | Outlier games | Median lag seconds | Report read                                                                                                                  |
| ------------------------------- | -----: | --------------: | --------------: | ------------: | --------: | --------: | ------------: | -----------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| A16_rv_bv_jump                  |    5/6 |             3/2 |           14.63 |         12.94 |     34.55 |        75 |             4 |               -6.8 | caution: A rough jump proxy, not true RV/BV over signed high-frequency returns.                                              |
| A09_volume_heavy_short          |    5/6 |             2/3 |           20.35 |         15.52 |     36.85 |        79 |             3 |               45.7 | caution: Highest recall, but it is a noisy volume amplifier until flow/depth normalization and episode ranking are in place. |
| A06_wall4_timeout_sensitive     |    5/6 |             2/3 |            25.5 |         19.65 |      44.7 |        79 |             1 |               45.7 | weak: The worst fire burden in the current run; short wall memory alone is too jumpy.                                        |
| A21_historical5_fanout_cooldown |    4/6 |             2/2 |           12.27 |         12.27 |        19 |        36 |             1 |               14.9 | caution: 1 game(s) hit the fire-count outlier rule.                                                                          |
| A01_legacy_60_vw_k3             |    4/6 |             2/2 |           12.85 |         10.44 |     25.85 |        41 |             2 |               40.4 | caution: Useful sensitive control, but fixed 60s wall buckets mix live play, whistles, timeouts, and free throws.            |
| A18_historical5_live_ramp       |    4/6 |             2/2 |           16.77 |         13.47 |     38.45 |        81 |             4 |               14.9 | caution: Historical prior is directionally important, but this incident set mostly does not validate opening behavior.       |
| A15_cusum_shift                 |    4/6 |             2/2 |              18 |         14.85 |     39.45 |        79 |             4 |               14.9 | caution: 4 game(s) hit the fire-count outlier rule.                                                                          |
| A19_historical5_fanout          |    4/6 |             2/2 |           19.02 |         15.06 |     39.55 |        81 |             3 |               14.9 | caution: Fanout guard needs independent-market de-duplication; current raw fanout can still add fires.                       |
| A20_coverage_norm_historical5   |    4/6 |             1/3 |           19.19 |         15.53 |      36.6 |        73 |             3 |               44.9 | caution: 3 game(s) hit the fire-count outlier rule.                                                                          |
| A13_cross_source_confirm        |    3/6 |             1/2 |           12.27 |         10.52 |        22 |        25 |             0 |               36.6 | pending: Same-bucket cross-source confirmation mostly measures source coverage and latency.                                  |

## Fire-Count Outliers

| Algorithm           | Game           | Fires | Episodes | Quote pairs | Active markets | Diagnosis                                                                   |
| ------------------- | -------------- | ----: | -------: | ----------: | -------------: | --------------------------------------------------------------------------- |
| A01_legacy_60_vw_k3 | nba-0042500313 |    41 |       36 |       12438 |            300 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A01_legacy_60_vw_k3 | nba-0042500314 |    40 |       40 |        9710 |            318 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A02_legacy_60_vw_k6 | nba-0042500314 |    40 |       40 |        9710 |            318 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A02_legacy_60_vw_k6 | nba-0042500313 |    32 |       28 |       12438 |            300 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A02_legacy_60_vw_k6 | nba-0042500302 |    23 |       21 |       11892 |            374 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500313 |    82 |       50 |       12438 |            300 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500302 |    51 |       35 |       11892 |            374 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500314 |    47 |       46 |        9710 |            318 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500303 |    38 |       19 |        8541 |            329 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A04_game12_recent4  | nba-0042500313 |    79 |       50 |       12438 |            300 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A04_game12_recent4  | nba-0042500314 |    46 |       46 |        9710 |            318 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A04_game12_recent4  | nba-0042500302 |    43 |       30 |       11892 |            374 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |

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
