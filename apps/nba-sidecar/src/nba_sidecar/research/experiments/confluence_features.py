"""Step 2: does a RICHER whole-board statistic beat the raw confluence COUNT?

The operating-point eval (confluence_operating_point.py) showed the count of
distinct coincident anomalies fails the bar (~17:1 FP at 11/15) because it can't
separate a misattribution from the busiest LEGITIMATE in-play moment. The cheap
next question, before committing to Stage-2 per-prop/pbp attribution: does a
magnitude-weighted statistic separate better?

This module reuses the EXACT operating-point machinery (causal per-game
trailing-z + clustered-alert FP unit + threshold sweep) and only swaps the
per-window statistic, so any improvement is attributable to the feature, not the
harness. Statistics compared (all causal, all per 60s window):

  count      = # distinct props with a price/volume anomaly (the current baseline)
  magnitude  = sum over distinct anomalous props of that prop's MAX excess
               magnitude in the window (a 6σ coincident move counts more than 3σ)
  max_mag    = the single largest per-prop excess magnitude in the window
               (is one violent move, not breadth, the tell?)

Honest framing: this is still a whole-board screen. If magnitude does not pull
FP@target meaningfully toward 3:1, that is positive evidence that the bar needs
Stage-2 attribution, not just a better pooled statistic.

Read-only. Same config-driven paths. Writes confluence_features.json at the
output-tree root for the lab surface.

Run:
  cd apps/nba-sidecar && uv run python -m nba_sidecar.research.experiments.confluence_features
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Optional

from nba_sidecar.research.experiments.confluence_killtest import (
    Params,
    _TICK_SQL,
    confluence_by_window,
    detect_prop_anomalies,
    detect_prop_anomaly_magnitudes,
    floor_win,
    load_incidents,
    parse_epoch,
    per_interval_volumes,
    resolve_db_path,
    resolve_out_root,
    resolve_registry_path,
    span_windows,
)
from nba_sidecar.research.experiments.confluence_operating_point import (
    OpParams,
    evaluate_threshold,
    trailing_robust_z,
)


# ----------------------------------------------------------------------------
# Pure window-statistic builders (unit-tested)
# ----------------------------------------------------------------------------
def magnitude_by_window(
    mag_events_by_prop: dict[str, list[tuple[float, float]]],
    active_wins: set[int],
    window_sec: int,
    reducer: str = "sum",
) -> dict[int, float]:
    """Per active window, reduce per-prop MAX excess magnitudes across distinct props.

    reducer='sum' -> breadth×depth (sum of per-prop maxima); 'max' -> the single
    largest per-prop move. Windows that are active but had no anomaly get 0.0, so
    the trailing baseline spans the same grid as the count statistic.
    """
    per_win_prop: dict[int, dict[str, float]] = defaultdict(dict)
    for prop, evs in mag_events_by_prop.items():
        for epoch, mag in evs:
            w = floor_win(epoch, window_sec)
            if mag > per_win_prop[w].get(prop, 0.0):
                per_win_prop[w][prop] = mag
    out: dict[int, float] = {}
    for w in active_wins:
        mags = per_win_prop.get(w, {})
        if not mags:
            out[w] = 0.0
        elif reducer == "max":
            out[w] = max(mags.values())
        else:
            out[w] = sum(mags.values())
    return out


def count_by_window(conf: dict[int, tuple[int, int]]) -> dict[int, float]:
    """Active-window -> distinct-anomaly count (the current baseline statistic)."""
    return {w: float(c) for w, (c, _a) in conf.items()}


# ----------------------------------------------------------------------------
# Orchestration (read-only DB)
# ----------------------------------------------------------------------------
def _load_game(con: sqlite3.Connection, game_id: str, p: Params):
    """-> (ticks_by_prop, count_anoms_by_prop, mag_events_by_prop) for one game."""
    rows = con.execute(_TICK_SQL, (game_id,)).fetchall()
    by_prop: dict[str, list[tuple[float, float, Optional[float]]]] = defaultdict(list)
    for mkt, cap, prob, vol in rows:
        try:
            e = parse_epoch(cap)
        except Exception:
            continue
        by_prop[mkt].append((e, float(prob), None if vol is None else float(vol)))
    ticks_by_prop: dict[str, list[float]] = {}
    count_anoms_by_prop: dict[str, list[float]] = {}
    mag_events_by_prop: dict[str, list[tuple[float, float]]] = {}
    for mkt, series in by_prop.items():
        series.sort(key=lambda r: r[0])
        epochs = [r[0] for r in series]
        probs = [r[1] for r in series]
        vols = per_interval_volumes([r[2] for r in series])
        ticks_by_prop[mkt] = epochs
        anoms = detect_prop_anomalies(epochs, probs, vols, p)
        if anoms:
            count_anoms_by_prop[mkt] = anoms
        mags = detect_prop_anomaly_magnitudes(epochs, probs, vols, p)
        if mags:
            mag_events_by_prop[mkt] = mags
    return ticks_by_prop, count_anoms_by_prop, mag_events_by_prop


def _sweep_statistic(games: list[dict], stat_key: str, op: OpParams, window_sec: int) -> dict:
    """Run the operating-point sweep for one window-statistic across all games."""
    games_z = [
        {
            "game_id": g["game_id"],
            "z_by_win": trailing_robust_z(g[stat_key], op),
            "incident_spans": g["incident_spans"],
        }
        for g in games
    ]
    inc_peak_z: list[float] = []
    for g in games_z:
        for span in g["incident_spans"].values():
            zs = [g["z_by_win"][w] for w in span if w in g["z_by_win"]]
            if zs:
                inc_peak_z.append(max(zs))
    grid = [round(x * 0.25, 3) for x in range(-4, 49)]
    thresholds = sorted(set(grid) | {round(z, 3) for z in inc_peak_z})
    sweep = [evaluate_threshold(games_z, t, window_sec, op) for t in thresholds]
    need = math.ceil(op.target_recall * op.n_incidents_denom)
    feasible = [s for s in sweep if s["fp_ratio"] is not None and s["fp_ratio"] <= op.max_fp_ratio]
    best = sorted(feasible, key=lambda s: (-s["caught"], s["fp_ratio"]))[0] if feasible else None
    at_bar = [s for s in sweep if s["caught"] >= need and s["fp_ratio"] is not None]
    fp_bar = min((s["fp_ratio"] for s in at_bar), default=None)
    ceil = max(sweep, key=lambda s: s["caught"])
    return {
        "statistic": stat_key,
        "best_feasible_caught": best["caught"] if best else 0,
        "best_feasible_fp_ratio": best["fp_ratio"] if best else None,
        "fp_ratio_at_target_recall": fp_bar,
        "recall_ceiling": ceil["caught"],
        "meets_bar": bool(best is not None and best["caught"] >= need),
    }


def run(db_path: str, registry_path: str) -> dict:
    p = Params()
    op = OpParams()
    incidents = load_incidents(registry_path)
    by_game: dict[str, list[dict]] = defaultdict(list)
    for inc in incidents:
        by_game[inc["game_id"]].append(inc)

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    games: list[dict] = []
    unusable: list[str] = []
    for game_id, game_incs in by_game.items():
        ticks_by_prop, count_anoms, mag_events = _load_game(con, game_id, p)
        if not ticks_by_prop:
            unusable.extend(inc["id"] for inc in game_incs)
            continue
        conf = confluence_by_window(count_anoms, ticks_by_prop, p.window_sec)
        active_wins = set(conf)
        counts = count_by_window(conf)
        mags_sum = magnitude_by_window(mag_events, active_wins, p.window_sec, "sum")
        mags_max = magnitude_by_window(mag_events, active_wins, p.window_sec, "max")
        spans = {
            inc["id"]: set(span_windows(inc["event_epoch"], p.incident_half_window_sec, p.window_sec))
            for inc in game_incs
        }
        games.append({
            "game_id": game_id,
            "count": counts,
            "magnitude": mags_sum,
            "max_mag": mags_max,
            "incident_spans": spans,
        })
    con.close()

    comparison = [
        _sweep_statistic(games, stat, op, p.window_sec)
        for stat in ("count", "magnitude", "max_mag")
    ]
    best_overall = min(
        (c for c in comparison if c["fp_ratio_at_target_recall"] is not None),
        key=lambda c: c["fp_ratio_at_target_recall"],
        default=None,
    )
    any_meets = any(c["meets_bar"] for c in comparison)
    return {
        "op_params": {"target_recall": op.target_recall, "max_fp_ratio": op.max_fp_ratio, "n_incidents_denom": op.n_incidents_denom},
        "n_incidents_total": len(incidents),
        "unusable_incident_ids": sorted(set(unusable)),
        "n_games": len(games),
        "meets_bar": any_meets,
        "best_statistic": best_overall["statistic"] if best_overall else None,
        "best_fp_ratio_at_target_recall": best_overall["fp_ratio_at_target_recall"] if best_overall else None,
        "comparison": comparison,
        "ratio_is_lower_bound_note": (
            "Only ~15 incidents are labeled; an unlabeled-but-real anomaly counts as a "
            "false positive, so every FP:TP here is a LOWER BOUND on precision."
        ),
        "interpretation": (
            "If magnitude/max_mag do not pull FP@target meaningfully below the count's "
            "~17:1 toward the 3:1 bar, the whole-board pooled signal is exhausted and the "
            "bar requires Stage-2 per-prop/pbp attribution, not a richer pooled statistic."
        ),
    }


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Confluence richer-feature comparison vs the count baseline")
    ap.add_argument("--registry", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    db_path = resolve_db_path()
    registry = resolve_registry_path(args.registry)
    report = run(db_path, registry)

    out_dir = Path(resolve_out_root(args.out)) / "confluence-features"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "result.json"
    out_file.write_text(json.dumps(report, indent=2))

    print("=== Confluence richer-feature comparison ===")
    print(f"games={report['n_games']} unusable={report['unusable_incident_ids']}")
    print(f"{'statistic':<12}{'best<=3:1':<14}{'fp@11/15':<12}{'ceiling':<9}{'meets_bar'}")
    for c in report["comparison"]:
        bf = f"{c['best_feasible_caught']}@{c['best_feasible_fp_ratio']}" if c["best_feasible_fp_ratio"] is not None else "none"
        fp = c["fp_ratio_at_target_recall"]
        print(f"{c['statistic']:<12}{bf:<14}{str(fp):<12}{str(c['recall_ceiling'])+'/15':<9}{c['meets_bar']}")
    print(f"best statistic: {report['best_statistic']} @ {report['best_fp_ratio_at_target_recall']}:1  MEETS BAR: {report['meets_bar']}")
    print(f"wrote {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
