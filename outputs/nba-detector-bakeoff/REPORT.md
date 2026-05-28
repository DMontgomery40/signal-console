# NBA Detector Bake-Off

Generated: 2026-05-28T04:41:01.985Z

This is an offline research artifact, not an official NBA source of truth. It scores every locally surfaced incident candidate we could ground from the previous report and archive trail, then labels anchor/data gaps instead of pretending they are misses. Positive lead seconds mean the first matching fire happened after the disputed play; negative lead seconds mean a pre-play warning.

## Coverage

- Incidents surfaced: 26
- Exact UTC anchors: 16
- Locally scoreable incidents: 15
- Market-native outlier episodes: 5537
- Denominator games with PBP windows: 1294
- Algorithms tested: 21

## Top Rows

| Algorithm                     | Incident caught | Tape outliers caught | Fires inside tape windows | Mean fires/game | Episodes/game | P95 fires | Max fires | Outlier games | Median lag seconds | Report read                                                                                                                  |
| ----------------------------- | --------------: | -------------------: | ------------------------: | --------------: | ------------: | --------: | --------: | ------------: | -----------------: | ---------------------------------------------------------------------------------------------------------------------------- |
| A06_wall4_timeout_sensitive   |            8/15 |    4498/5537 (81.2%) |                     25.2% |           25.78 |         17.21 |     51.35 |        85 |            29 |               16.1 | weak: The worst fire burden in the current run; short wall memory alone is too jumpy.                                        |
| A09_volume_heavy_short        |            8/15 |    4221/5537 (76.2%) |                     29.2% |           21.86 |         14.15 |        47 |        86 |            63 |               -1.9 | caution: Highest recall, but it is a noisy volume amplifier until flow/depth normalization and episode ranking are in place. |
| A03_opening_ramp_30           |            6/15 |    4577/5537 (82.7%) |                     35.6% |           21.01 |          11.8 |        57 |        97 |            67 |              -18.5 | weak: Opening-ramp shape is directionally right, but this row catches too little for its fire burden.                        |
| A05_game6_fast                |            6/15 |    4458/5537 (80.5%) |                     38.8% |           19.12 |         11.02 |     55.35 |       100 |            65 |                131 | caution: 65 game(s) hit the fire-count outlier rule.                                                                         |
| A15_cusum_shift               |            6/15 |    4415/5537 (79.7%) |                     38.2% |           18.37 |         11.62 |        54 |        93 |            68 |              -18.5 | caution: 68 game(s) hit the fire-count outlier rule.                                                                         |
| A18_historical5_live_ramp     |            6/15 |    4408/5537 (79.6%) |                     31.4% |           20.44 |         13.74 |     50.35 |        83 |            65 |              -18.5 | caution: Historical prior is directionally important, but this incident set mostly does not validate opening behavior.       |
| A12_board_fanout_range        |            6/15 |    4368/5537 (78.9%) |                     50.1% |           12.47 |          7.92 |        46 |        78 |            70 |               66.6 | caution: 70 game(s) hit the fire-count outlier rule.                                                                         |
| A19_historical5_fanout        |            6/15 |    4290/5537 (77.5%) |                     43.1% |           14.15 |          8.67 |        48 |        76 |            72 |              -18.5 | caution: Fanout guard needs independent-market de-duplication; current raw fanout can still add fires.                       |
| A16_rv_bv_jump                |            6/15 |    4236/5537 (76.5%) |                     37.7% |            14.8 |         11.35 |        43 |        95 |            69 |                131 | caution: A rough jump proxy, not true RV/BV over signed high-frequency returns.                                              |
| A20_coverage_norm_historical5 |            5/15 |    4175/5537 (75.4%) |                     45.7% |           12.68 |          8.03 |     44.35 |        73 |            65 |              -23.4 | caution: 65 game(s) hit the fire-count outlier rule.                                                                         |

## Market-Native Outlier Episodes

| Game           | Matchup   | Start                    | End                      | Peak severity | Price-move z | Breadth z | Offprice z | Diagnosis                                      |
| -------------- | --------- | ------------------------ | ------------------------ | ------------: | -----------: | --------: | ---------: | ---------------------------------------------- |
| nba-0022500014 | MIL @ ATL | 2026-01-19T18:26:00.000Z | 2026-01-19T18:26:30.000Z |         3.913 |        3.363 |     1.101 |          0 | price move outlier; broad market participation |
| nba-0022500014 | MIL @ ATL | 2026-01-19T18:54:00.000Z | 2026-01-19T18:54:30.000Z |         4.074 |        3.404 |      1.34 |          0 | price move outlier; broad market participation |
| nba-0022500014 | MIL @ ATL | 2026-01-19T20:28:00.000Z | 2026-01-19T20:28:30.000Z |         3.968 |        3.968 |         0 |          0 | price move outlier; broad market participation |
| nba-0022500014 | MIL @ ATL | 2026-01-19T20:35:00.000Z | 2026-01-19T20:37:30.000Z |         4.752 |        4.025 |     1.727 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T19:39:00.000Z | 2026-01-19T19:39:30.000Z |         4.811 |        4.811 |         0 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T20:51:00.000Z | 2026-01-19T20:51:30.000Z |         4.565 |        4.565 |         0 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T20:55:00.000Z | 2026-01-19T20:55:30.000Z |         3.729 |        3.245 |     0.967 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T21:01:00.000Z | 2026-01-19T21:01:30.000Z |         4.465 |        4.465 |         0 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T21:05:00.000Z | 2026-01-19T21:05:30.000Z |         4.558 |        4.558 |         0 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T21:10:00.000Z | 2026-01-19T21:11:30.000Z |          5.09 |         5.09 |     0.492 |          0 | extreme price move; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T21:16:00.000Z | 2026-01-19T21:16:30.000Z |         3.921 |        3.784 |     0.274 |          0 | price move outlier; broad market participation |
| nba-0022500015 | OKC @ CLE | 2026-01-19T21:20:00.000Z | 2026-01-19T21:21:30.000Z |         5.876 |        5.539 |     0.674 |          0 | extreme price move; broad market participation |

## Fire-Count Outliers

| Algorithm           | Game           | Fires | Episodes | Quote pairs | Active markets | Diagnosis                                                                                                                                  |
| ------------------- | -------------- | ----: | -------: | ----------: | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A01_legacy_60_vw_k3 | nba-0022500922 |    44 |       21 |        3181 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500904 |    42 |       24 |        2217 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500973 |    41 |       20 |        2479 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500932 |    40 |       23 |        1715 |             58 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A01_legacy_60_vw_k3 | nba-0022500935 |    40 |       22 |        2006 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500932 |    39 |       23 |        1715 |             58 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500947 |    39 |       17 |        2773 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500904 |    38 |       21 |        2217 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500992 |    38 |       22 |        2356 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
| A02_legacy_60_vw_k6 | nba-0022500986 |    37 |       16 |        2902 |             62 | threshold-heavy: high fires despite modest quote density                                                                                   |
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
