---
name: nba-sidecar
description: "Skill for the Nba_sidecar area of signal-console. 59 symbols across 4 files."
---

# Nba_sidecar

59 symbols | 4 files | Cohesion: 69%

## When to Use

- Working with code in `apps/`
- Understanding how get_game, get_play_by_play, normalize_schedule_league_payload work
- Modifying nba_sidecar-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/nba-sidecar/src/nba_sidecar/volatility.py` | _clamp, _clamp01, _prior_level, _prior_scale_score, _historical_share (+22) |
| `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | _parse_utc_iso, _captured_at_from_meta, _pick, _participant_from_live, _scheduled_start_from_live (+14) |
| `apps/nba-sidecar/src/nba_sidecar/service.py` | get_schedule_scoreboard, get_game, get_live_play_by_play_payload, get_play_by_play, _is_past_date (+3) |
| `apps/nba-sidecar/src/nba_sidecar/main.py` | get_game, get_play_by_play, health_ready, get_scoreboard, post_board_volatility_state_space |

## Entry Points

Start here when exploring this area:

- **`get_game`** (Function) — `apps/nba-sidecar/src/nba_sidecar/main.py:49`
- **`get_play_by_play`** (Function) — `apps/nba-sidecar/src/nba_sidecar/main.py:57`
- **`normalize_schedule_league_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:302`
- **`normalize_live_boxscore_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:327`
- **`normalize_live_playbyplay_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:378`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `get_game` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 49 |
| `get_play_by_play` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 57 |
| `normalize_schedule_league_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 302 |
| `normalize_live_boxscore_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 327 |
| `normalize_live_playbyplay_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 378 |
| `normalize_live_scoreboard_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 122 |
| `normalize_stats_scoreboard_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 210 |
| `health_ready` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 18 |
| `get_scoreboard` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 41 |
| `is_today` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 406 |
| `post_board_volatility_state_space` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 76 |
| `enter_z_threshold_from_k` | Function | `apps/nba-sidecar/src/nba_sidecar/volatility.py` | 41 |
| `score_volatility_state_space` | Function | `apps/nba-sidecar/src/nba_sidecar/volatility.py` | 526 |
| `get_schedule_scoreboard` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 118 |
| `get_game` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 127 |
| `get_live_play_by_play_payload` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 131 |
| `get_play_by_play` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 171 |
| `get_scoreboard` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 77 |
| `get_live_scoreboard_payload` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 111 |
| `_parse_utc_iso` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 30 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Score_volatility_state_space → _clamp` | cross_community | 7 |
| `Get_scoreboard → _coerce_optional_str` | cross_community | 6 |
| `Get_scoreboard → _coerce_int` | cross_community | 6 |
| `Normalize_stats_scoreboard_payload → _coerce_optional_str` | cross_community | 5 |
| `Get_scoreboard → _pick` | cross_community | 5 |
| `Normalize_stats_scoreboard_payload → _coerce_int` | intra_community | 4 |
| `Normalize_stats_scoreboard_payload → _pick` | cross_community | 4 |
| `Normalize_live_boxscore_payload → _coerce_optional_str` | cross_community | 4 |
| `Get_scoreboard → _schedule_date_matches` | cross_community | 4 |
| `Score_volatility_state_space → _breadth_normalizer` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "get_game"})` — see callers and callees
2. `gitnexus_query({query: "nba_sidecar"})` — find related execution flows
3. Read key files listed above for implementation details
