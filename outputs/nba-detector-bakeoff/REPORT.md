# NBA Detector Bake-Off

Generated: 2026-05-25T01:39:46.247Z

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
| A09_volume_heavy_short          |    6/6 |             1/5 |           23.05 |         16.68 |     38.75 |        73 |             1 |               66.7 | caution: Highest recall, but it is a noisy volume amplifier until flow/depth normalization and episode ranking are in place. |
| A16_rv_bv_jump                  |    5/6 |             3/2 |           16.48 |            15 |      29.9 |        63 |             1 |               -6.8 | caution: A rough jump proxy, not true RV/BV over signed high-frequency returns.                                              |
| A01_legacy_60_vw_k3             |    5/6 |             2/3 |           16.71 |         11.77 |     29.95 |        33 |             0 |               23.2 | caution: Useful sensitive control, but fixed 60s wall buckets mix live play, whistles, timeouts, and free throws.            |
| A21_historical5_fanout_cooldown |    4/6 |             2/2 |           11.94 |         11.94 |     17.95 |        26 |             0 |               14.9 | usable comparator; no special warning from the current report rules.                                                         |
| A04_game12_recent4              |    4/6 |             2/2 |           15.29 |         12.37 |      27.9 |        57 |             2 |               14.9 | caution: 2 game(s) hit the fire-count outlier rule.                                                                          |
| A07_final5_close_suppressed     |    4/6 |             2/2 |           16.31 |         13.13 |     28.85 |        59 |             2 |               14.9 | pending: Late-game suppression is not proven because the current scoreable incident set has no final-five-close fires.       |
| A08_final60_foul_mode           |    4/6 |             2/2 |           16.31 |         13.13 |     28.85 |        59 |             2 |               14.9 | pending: Final-minute foul-mode suppression is untested by the current incident denominator.                                 |
| A12_board_fanout_range          |    4/6 |             2/2 |              17 |         14.03 |        26 |        58 |             1 |               14.9 | caution: 1 game(s) hit the fire-count outlier rule.                                                                          |
| A17_clutch_har_fanout           |    4/6 |             2/2 |           17.11 |          13.9 |     29.85 |        60 |             1 |               14.9 | pending: Name overstates proof; HAR/clutch behavior needs late-game scoreable incidents.                                     |
| A18_historical5_live_ramp       |    4/6 |             2/2 |           17.97 |         14.18 |     30.95 |        55 |             1 |               14.9 | caution: Historical prior is directionally important, but this incident set mostly does not validate opening behavior.       |

## Fire-Count Outliers

| Algorithm           | Game           | Fires | Episodes | Quote pairs | Active markets | Diagnosis                                                                   |
| ------------------- | -------------- | ----: | -------: | ----------: | -------------: | --------------------------------------------------------------------------- |
| A02_legacy_60_vw_k6 | nba-0042500155 |    26 |       18 |        1562 |             62 | threshold-heavy: high fires despite modest quote density                    |
| A02_legacy_60_vw_k6 | nba-0042500312 |    26 |       19 |        7955 |            370 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A02_legacy_60_vw_k6 | nba-0042500107 |    23 |       20 |         821 |             43 | threshold-heavy: high fires despite modest quote density                    |
| A02_legacy_60_vw_k6 | nba-0042500124 |    23 |       15 |         603 |             62 | threshold-heavy: high fires despite modest quote density                    |
| A02_legacy_60_vw_k6 | nba-0042500126 |    23 |       15 |        1146 |             62 | threshold-heavy: high fires despite modest quote density                    |
| A03_opening_ramp_30 | nba-0042500302 |    71 |       43 |        7744 |            371 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500312 |    51 |       27 |        7955 |            370 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A03_opening_ramp_30 | nba-0042500207 |    40 |       19 |       12218 |            344 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A04_game12_recent4  | nba-0042500302 |    57 |       43 |        7744 |            371 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A04_game12_recent4  | nba-0042500312 |    45 |       29 |        7955 |            370 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A05_game6_fast      | nba-0042500302 |    61 |       40 |        7744 |            371 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |
| A05_game6_fast      | nba-0042500312 |    58 |       30 |        7955 |            370 | coverage-heavy: many markets or quote pairs can inflate raw board intensity |

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
