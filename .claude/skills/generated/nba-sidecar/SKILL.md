---
name: nba-sidecar
description: "Skill for the Nba_sidecar area of signal-console. 27 symbols across 3 files."
---

# Nba_sidecar

27 symbols | 3 files | Cohesion: 95%

## When to Use

- Working with code in `apps/`
- Understanding how get_game, get_play_by_play, normalize_live_scoreboard_payload work
- Modifying nba_sidecar-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | _now_iso, _captured_at_from_meta, _coerce_int, _pick, _participant_from_live (+10) |
| `apps/nba-sidecar/src/nba_sidecar/service.py` | get_game, get_live_play_by_play_payload, get_play_by_play, _is_past_date, _looks_like_stale_historical_preview (+3) |
| `apps/nba-sidecar/src/nba_sidecar/main.py` | get_game, get_play_by_play, health_ready, get_scoreboard |

## Entry Points

Start here when exploring this area:

- **`get_game`** (Function) — `apps/nba-sidecar/src/nba_sidecar/main.py:47`
- **`get_play_by_play`** (Function) — `apps/nba-sidecar/src/nba_sidecar/main.py:55`
- **`normalize_live_scoreboard_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:88`
- **`normalize_stats_scoreboard_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:173`
- **`normalize_schedule_league_payload`** (Function) — `apps/nba-sidecar/src/nba_sidecar/normalizers.py:262`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `get_game` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 47 |
| `get_play_by_play` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 55 |
| `normalize_live_scoreboard_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 88 |
| `normalize_stats_scoreboard_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 173 |
| `normalize_schedule_league_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 262 |
| `normalize_live_boxscore_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 287 |
| `normalize_live_playbyplay_payload` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 336 |
| `health_ready` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 16 |
| `get_scoreboard` | Function | `apps/nba-sidecar/src/nba_sidecar/main.py` | 39 |
| `is_today` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 364 |
| `get_game` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 127 |
| `get_live_play_by_play_payload` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 131 |
| `get_play_by_play` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 171 |
| `get_scoreboard` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 77 |
| `get_live_scoreboard_payload` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 111 |
| `get_schedule_scoreboard` | Method | `apps/nba-sidecar/src/nba_sidecar/service.py` | 118 |
| `_now_iso` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 18 |
| `_captured_at_from_meta` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 22 |
| `_coerce_int` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 39 |
| `_pick` | Function | `apps/nba-sidecar/src/nba_sidecar/normalizers.py` | 49 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Get_scoreboard → _now_iso` | cross_community | 6 |
| `Get_scoreboard → _pick` | cross_community | 6 |
| `Get_scoreboard → _coerce_int` | cross_community | 5 |
| `Normalize_stats_scoreboard_payload → _now_iso` | intra_community | 4 |
| `Normalize_stats_scoreboard_payload → _pick` | intra_community | 4 |
| `Get_scoreboard → _schedule_date_matches` | cross_community | 4 |
| `Normalize_stats_scoreboard_payload → _coerce_int` | intra_community | 3 |

## How to Explore

1. `gitnexus_context({name: "get_game"})` — see callers and callees
2. `gitnexus_query({query: "nba_sidecar"})` — find related execution flows
3. Read key files listed above for implementation details
