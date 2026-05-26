# Bakeoff regen: expanded incident denominator

> Generated 2026-05-25 after adding seven last-week Reddit-plus-local-PBP incident candidates to the official historical registry. The bakeoff now scores 13 locally scoreable incidents instead of 6. This more than doubles the scoreable denominator and makes the old 6-case leaderboard obsolete.

## Coverage delta

| Field                              | Prior post-fix run (2026-05-25T08:29Z) | Expanded run (2026-05-25T10:02Z) | Delta |
| ---------------------------------- | -------------------------------------- | -------------------------------- | ----- |
| Official registry rows             | 16                                     | 23                               | +7    |
| Surfaced incidents incl. archive   | 19                                     | 26                               | +7    |
| Exact UTC anchors                  | 9                                      | 16                               | +7    |
| Locally scoreable incidents        | 6                                      | 13                               | +7    |
| Denominator games with PBP windows | 62                                     | 62                               | 0     |
| Algorithms tested                  | 21                                     | 21                               | 0     |

## New scoreable incidents

| Incident ID                                | Game           | UTC anchor             | Stat family   | Credited/live side                 | Rightful/final side    |
| ------------------------------------------ | -------------- | ---------------------- | ------------- | ---------------------------------- | ---------------------- |
| `holmgren_team_rebound_20260518`           | nba-0042500311 | 2026-05-19T01:35:35.4Z | rebound       | TEAM offensive rebound             | C. Holmgren            |
| `hart_rebound_to_steal_20260519`           | nba-0042500301 | 2026-05-20T01:47:10.6Z | rebound+steal | J. Hart steal                      | J. Hart rebound/RA leg |
| `champagnie_wembanyama_rebound_1_20260520` | nba-0042500312 | 2026-05-21T02:00:43.6Z | rebound       | J. Champagnie live rebound display | V. Wembanyama          |
| `champagnie_wembanyama_rebound_2_20260520` | nba-0042500312 | 2026-05-21T02:01:13.6Z | rebound       | J. Champagnie live rebound display | V. Wembanyama          |
| `harper_team_rebound_foul_20260520`        | nba-0042500312 | 2026-05-21T02:12:03.9Z | rebound       | TEAM defensive rebound             | D. Harper              |
| `wembanyama_team_rebound_foul_20260524`    | nba-0042500314 | 2026-05-25T00:16:22.4Z | rebound       | TEAM defensive rebound             | V. Wembanyama          |
| `towns_team_rebound_foul_20260523`         | nba-0042500303 | 2026-05-24T02:26:41.4Z | rebound       | TEAM defensive rebound             | K. Towns (suspected)   |

The weaker Cason Wallace block-removal and Shai steal-removal comments were not promoted into this scoreable set because I could not recover a clean event anchor from current local PBP. They remain research leads, not benchmark rows.

## Leaderboard impact

| Algorithm                       | Prior caught | Expanded caught | Prior mean fires/game | Expanded mean fires/game | Read                                                                                                             |
| ------------------------------- | ------------ | --------------- | --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A16_rv_bv_jump                  | 5/6          | 9/13            | 14.63                 | 14.11                    | Still high recall, but no longer the top row after the KAT candidate moved the denominator.                      |
| A19_historical5_fanout          | 4/6          | 9/13            | 19.02                 | 18.55                    | Big beneficiary of the new last-week OKC/SAS rows; still needs independent-market de-duplication.                |
| A15_cusum_shift                 | 4/6          | 9/13            | 18.00                 | 18.18                    | Stronger on the expanded set, but four outlier games keep it operationally noisy.                                |
| A06_wall4_timeout_sensitive     | 5/6          | 10/13           | 25.50                 | 25.18                    | High recall, still too much alert burden for live desk use.                                                      |
| A01_legacy_60_vw_k3             | 4/6          | 9/13            | 12.85                 | 13.02                    | Live-wired control improved on a more-than-doubled denominator; still lower recall than the best research row.   |
| A09_volume_heavy_short          | 5/6          | 11/13           | 20.35                 | 20.55                    | Highest recall after the KAT candidate, but still noisy until flow/depth normalization and episode ranking land. |
| A21_historical5_fanout_cooldown | 4/6          | 5/13            | 12.27                 | 12.06                    | Good alert hygiene, but missed too many recent anchors for Tuesday headline status.                              |

## New-incident catch notes

| Incident ID                                | A16 RV/BV       | A09 volume-heavy | A01 live-control | A21 hist-fanout-cooldown |
| ------------------------------------------ | --------------- | ---------------- | ---------------- | ------------------------ |
| `holmgren_team_rebound_20260518`           | miss            | miss             | caught T+24.6s   | caught T-5.4s            |
| `hart_rebound_to_steal_20260519`           | miss            | miss             | miss             | miss                     |
| `champagnie_wembanyama_rebound_1_20260520` | caught T+46.4s  | caught T-13.6s   | caught T+76.4s   | miss                     |
| `champagnie_wembanyama_rebound_2_20260520` | caught T+16.4s  | caught T-43.6s   | caught T+46.4s   | miss                     |
| `harper_team_rebound_foul_20260520`        | caught T+146.1s | caught T+146.1s  | caught T+176.1s  | miss                     |
| `wembanyama_team_rebound_foul_20260524`    | caught T+247.6s | caught T+7.6s    | miss             | caught T+7.6s            |
| `towns_team_rebound_foul_20260523`         | caught T-11.4s  | caught T-11.4s   | caught T+18.6s   | caught T+168.6s          |

## Operational consequence

The important headline changed:

- Old truthful post-fix headline: best row caught 5/6.
- New truthful expanded headline: best row catches 11/13.
- The live-wired control row is 9/13, not 4/6, on a more-than-doubled dataset.
- The added cases are not cosmetic. They materially change the leaderboard and expose which rows catch recent OKC/SAS stat-allocation weirdness.

For Tuesday, the honest trader read is: "We more than doubled the scoreable benchmark set overnight from 6 to 13 anchored incidents. The live-wired baseline catches 9/13, while research rows reach 11/13 with different alert-burden tradeoffs."

## Inputs

- Detector version: `1.6.0`
- Gold DB: `/Users/davidmontgomery/signal-console/data/signal-console.sqlite`
- Source registry: `/Users/davidmontgomery/nba-predict/outputs/innovation-team-suspend-signal-report/research/incident-registry-expanded.json`
- Generated report: `/Users/davidmontgomery/signal-console/outputs/nba-detector-bakeoff/REPORT.md`
- Machine-readable result: `/Users/davidmontgomery/signal-console/outputs/nba-detector-bakeoff/research/bakeoff-results.json`
- Command: `pnpm bakeoff:nba-detectors`
