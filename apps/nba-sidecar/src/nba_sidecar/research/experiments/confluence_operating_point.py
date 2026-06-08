"""Whole-board CONFLUENCE operating-point eval (the REAL bar, not the gate).

The kill-test (confluence_killtest.py) answered the falsification question and
passed decisively: labeled misattributions show far more per-prop co-occurrence
than equally-busy moments in the same game (13/14 stand out, binom p~1e-12,
rank-AUC 0.972). That is NECESSARY but NOT SUFFICIENT.

This module answers the bar the user actually set, which is an OPERATING POINT
under extreme class imbalance (15 incidents vs ~hundreds-of-thousands of board
windows):

    Is there ONE global threshold at which we catch >= 70% of misattributions
    (>= 11 of 15) at a false-alarm ratio no worse than 3:1
    (<= 3 false alerts per true catch)?

The kill-test's "standout" fired at each game's 90th percentile -> a 10% per
-window false-positive rate -> thousands of raw false alarms per game. That is
nowhere near 3:1. So we must measure the deployable operating point directly.

================  DEPLOYABLE-DESIGN CHOICES (pinned before running)  ============
These are NEW choices beyond the frozen detection Params. They are pinned here
*before* inspecting the operating-point outcome, and the full threshold sweep is
reported (not a cherry-picked point), so the result is honest.

1. STATISTIC = whole-board confluence count per 60s window (distinct props with a
   causal price/volume anomaly), exactly as in the kill-test.

2. NORMALIZATION = causal, per-game, trailing-only robust z:
       z(w) = (count_w - median(trailing)) / max(MAD_SCALE*mad(trailing), MIN_SCALE)
   trailing = confluence counts of EARLIER active windows in the same game only
   (past-only -> deployable live; no future leakage like the kill-test's p90).
   Needs >= MIN_HISTORY trailing active windows; earlier windows are unscorable.
   MIN_SCALE regularizes the denominator so "+1 coincident prop over a dead-flat
   baseline" cannot manufacture an infinite z.

3. ALERT (the FP unit) = a CLUSTER of consecutive flagged windows (merged across
   gaps <= MERGE_GAP windows). This is what a Stage-2 analyst actually zooms into
   once, not a per-window count. TP = a cluster overlapping an incident's +-60s
   span; FP = a cluster overlapping no incident. recall = incidents with >=1
   flagged window in span / total incidents. ratio = FP alerts / true catches.

reaves_hayes (nba-0042500224) has no usable in-play player-prop ticks (bet365
pregame only) -> it can never be caught; it is a guaranteed miss against the
15-incident denominator and is reported as such (not hidden).
===============================================================================

Read-only. Same config-driven paths as the kill-test.

Run:
  cd apps/nba-sidecar && uv run python -m nba_sidecar.research.experiments.confluence_operating_point
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import sqlite3

from nba_sidecar.research.experiments.confluence_killtest import (
    MAD_SCALE,
    Params,
    _mad,
    confluence_by_window,
    floor_win,
    load_game_props,
    load_incidents,
    resolve_db_path,
    resolve_out_root,
    resolve_registry_path,
    span_windows,
)


@dataclass(frozen=True)
class OpParams:
    """Deployable-design knobs, pinned before inspecting the operating point."""

    min_history: int = 10  # trailing active windows required before a window is scorable
    min_scale: float = 1.0  # denominator floor (1 coincident prop) -> regularized z
    baseline_window: int = 0  # 0 = expanding from first tick; >0 = rolling last-N.
    #   EMPIRICAL (2026-06-01): expanding is the LEAST-BAD option. The per-game tick
    #   span is 1-9 DAYS (pre/post-game prop markets), so I hypothesized the expanding
    #   baseline was contaminated by quiet pregame windows and a rolling recent
    #   baseline would recover precision. It did the OPPOSITE: rolling-{30,60,90,120}
    #   pushed FP@(11/15) from ~17:1 to ~190:1. Reason: incidents do NOT stand out
    #   against their RECENT in-play neighbors -- only against quiet pregame. So the
    #   raw confluence COUNT separates incidents from QUIET moments (kill-test, AUC
    #   0.972) but NOT from the busiest LEGITIMATE in-play moments, which is exactly
    #   what a misattribution must be told apart from. This is a real signal limit of
    #   the count statistic, not a normalization artifact -- see the baseline_comparison
    #   in result.json and memory nba-miscredit-pooled-features-negative-result.
    merge_gap: int = 1  # flagged windows <= this many windows apart join one alert
    target_recall: float = 0.70  # >= 11 of 15
    max_fp_ratio: float = 3.0  # <= 3 false alerts per true catch
    n_incidents_denom: int = 15  # the user's bar is over all 15 labeled incidents


# ----------------------------------------------------------------------------
# Pure functions (unit-tested in tests/test_confluence_operating_point.py)
# ----------------------------------------------------------------------------
def trailing_robust_z(
    counts_by_win: dict[int, int],
    op: OpParams,
) -> dict[int, float]:
    """Causal per-game robust z for each active window vs its EARLIER active windows.

    Past-only (deployable live). Windows with < op.min_history trailing active
    windows are unscorable and omitted from the result.
    """
    wins = sorted(counts_by_win)
    hist: list[float] = []
    out: dict[int, float] = {}
    for w in wins:
        c = float(counts_by_win[w])
        ref = hist[-op.baseline_window :] if op.baseline_window else hist
        if len(ref) >= op.min_history:
            med = statistics.median(ref)
            denom = max(MAD_SCALE * _mad(ref), op.min_scale)
            out[w] = (c - med) / denom
        hist.append(c)
    return out


def cluster_alerts(flagged_wins: list[int], window_sec: int, merge_gap: int) -> list[tuple[int, int]]:
    """Merge sorted flagged window-starts into (start, end) alert clusters.

    Two flagged windows join the same alert when their starts are within
    (merge_gap + 1) * window_sec of each other (i.e. <= merge_gap empty windows
    between them).
    """
    if not flagged_wins:
        return []
    ws = sorted(set(flagged_wins))
    span = (merge_gap + 1) * window_sec
    clusters: list[tuple[int, int]] = []
    start = prev = ws[0]
    for w in ws[1:]:
        if w - prev <= span:
            prev = w
            continue
        clusters.append((start, prev))
        start = prev = w
    clusters.append((start, prev))
    return clusters


def cluster_overlaps_any(cluster: tuple[int, int], incident_wins: set[int], window_sec: int) -> bool:
    """Does an alert cluster cover any incident window (inclusive of its end window)?"""
    lo, hi = cluster
    return any(lo <= iw <= hi for iw in incident_wins)


# ----------------------------------------------------------------------------
# Orchestration (read-only DB)
# ----------------------------------------------------------------------------
def _build_game_scores(con: sqlite3.Connection, game_id: str, incs: list[dict], p: Params, op: OpParams):
    """-> (z_by_win, incident_spans {inc_id: set(win)}, unusable_incident_ids)."""
    ticks_by_prop, anoms_by_prop = load_game_props(con, game_id)
    if not ticks_by_prop:
        return None
    conf = confluence_by_window(anoms_by_prop, ticks_by_prop, p.window_sec)
    counts = {w: c for w, (c, _a) in conf.items()}  # active windows only (a>=1 implied)
    z_by_win = trailing_robust_z(counts, op)
    incident_spans: dict[str, set[int]] = {}
    for inc in incs:
        incident_spans[inc["id"]] = set(span_windows(inc["event_epoch"], p.incident_half_window_sec, p.window_sec))
    return counts, z_by_win, incident_spans


def evaluate_threshold(games: list[dict], thr: float, window_sec: int, op: OpParams) -> dict:
    """Aggregate recall and FP:TP across all games at a single global z threshold."""
    caught = 0
    fp_alerts = 0
    tp_alerts = 0
    per_inc_caught: dict[str, bool] = {}
    for g in games:
        z_by_win = g["z_by_win"]
        all_incident_wins: set[int] = set()
        for s in g["incident_spans"].values():
            all_incident_wins |= s
        flagged = [w for w, z in z_by_win.items() if z >= thr]
        clusters = cluster_alerts(flagged, window_sec, op.merge_gap)
        for cl in clusters:
            if cluster_overlaps_any(cl, all_incident_wins, window_sec):
                tp_alerts += 1
            else:
                fp_alerts += 1
        flagged_set = set(flagged)
        for inc_id, span in g["incident_spans"].items():
            hit = bool(span & flagged_set)
            per_inc_caught[inc_id] = hit
            if hit:
                caught += 1
    ratio = (fp_alerts / caught) if caught else float("inf")
    return {
        "threshold": round(thr, 3),
        "caught": caught,
        "fp_alerts": fp_alerts,
        "tp_alerts": tp_alerts,
        "fp_ratio": None if math.isinf(ratio) else round(ratio, 3),
        "recall_over_denom": round(caught / op.n_incidents_denom, 3),
        "per_inc_caught": per_inc_caught,
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
    scorable_incident_ids: list[str] = []
    for game_id, game_incs in by_game.items():
        built = _build_game_scores(con, game_id, game_incs, p, op)
        if built is None:
            unusable.extend(inc["id"] for inc in game_incs)
            continue
        counts_by_win, z_by_win, incident_spans = built
        # An incident is scorable only if its span windows are within the scored grid range.
        scored_wins = set(z_by_win)
        for inc in game_incs:
            span = incident_spans[inc["id"]]
            if span & scored_wins:
                scorable_incident_ids.append(inc["id"])
            else:
                unusable.append(inc["id"])
        games.append({
            "game_id": game_id,
            "counts_by_win": counts_by_win,
            "z_by_win": z_by_win,
            "incident_spans": incident_spans,
        })
    con.close()

    # Sweep a global threshold. Candidate set = a fixed grid plus every incident's
    # own peak z (so the curve passes through each incident's catch point).
    inc_peak_z: list[float] = []
    for g in games:
        for span in g["incident_spans"].values():
            zs = [g["z_by_win"][w] for w in span if w in g["z_by_win"]]
            if zs:
                inc_peak_z.append(max(zs))
    grid_thr = [round(x * 0.25, 3) for x in range(-4, 49)]  # -1.0 .. 12.0 step 0.25
    thresholds = sorted(set(grid_thr) | {round(z, 3) for z in inc_peak_z})

    sweep = [evaluate_threshold(games, t, p.window_sec, op) for t in thresholds]

    # Best operating point = highest recall with fp_ratio <= max_fp_ratio;
    # tie-break on lower fp_ratio then higher threshold.
    feasible = [s for s in sweep if s["fp_ratio"] is not None and s["fp_ratio"] <= op.max_fp_ratio]
    best = None
    if feasible:
        best = sorted(feasible, key=lambda s: (-s["caught"], s["fp_ratio"], -s["threshold"]))[0]

    meets_bar = bool(
        best is not None
        and best["caught"] >= math.ceil(op.target_recall * op.n_incidents_denom)
    )

    # Also: the max recall achievable at ANY fp_ratio (the separation ceiling).
    max_recall_point = sorted(sweep, key=lambda s: (-s["caught"], (s["fp_ratio"] if s["fp_ratio"] is not None else 1e9)))[0]

    # Transparent baseline comparison (expanding vs rolling) so the logged artifact
    # shows WHY the conclusion holds, not just the headline number. Same games/grid;
    # only the normalization baseline changes.
    baseline_comparison = _baseline_comparison(games, p.window_sec, op, thresholds)

    need = math.ceil(op.target_recall * op.n_incidents_denom)
    fp_at_bar = [s for s in sweep if s["caught"] >= need and s["fp_ratio"] is not None]
    fp_ratio_at_bar = min((s["fp_ratio"] for s in fp_at_bar), default=None)

    return {
        "op_params": asdict(op),
        "n_incidents_total": len(incidents),
        "n_incidents_scorable": len(scorable_incident_ids),
        "unusable_incident_ids": sorted(set(unusable)),
        "n_games": len(games),
        "meets_bar": meets_bar,
        "best_feasible_point": best,
        "max_recall_point": {k: v for k, v in max_recall_point.items() if k != "per_inc_caught"},
        "fp_ratio_at_target_recall": fp_ratio_at_bar,
        "ratio_is_lower_bound_note": (
            "Only 15 incidents are labeled; an unlabeled-but-real board anomaly counts "
            "as a false positive here, so the measured FP:TP is a LOWER BOUND on precision "
            "given current labels (true precision may be better)."
        ),
        "baseline_comparison": baseline_comparison,
        "interpretation": (
            "Whole-board confluence COUNT is necessary screening signal (recall ceiling "
            f"{max_recall_point['caught']}/{op.n_incidents_denom}) but insufficient alone: best FP:TP at the "
            f">={need}/{op.n_incidents_denom} bar is ~{fp_ratio_at_bar}:1 (target <= {op.max_fp_ratio}:1). The count "
            "cannot separate misattributions from the busiest legitimate in-play moments. "
            "Hitting the bar needs richer per-window features and/or Stage-2 per-prop/pbp "
            "attribution, consistent with the prior pooled-features negative result."
        ),
        "sweep": [{k: v for k, v in s.items() if k != "per_inc_caught"} for s in sweep],
    }


def _baseline_comparison(games: list[dict], window_sec: int, op: OpParams, thresholds: list[float]) -> list[dict]:
    """For each baseline choice, recompute z and report best-feasible + FP@target-recall."""
    import dataclasses

    # Reconstruct per-game raw counts from the already-scored windows is lossy, so
    # the caller passes games carrying z for the CONFIGURED baseline only. To compare
    # baselines we need the raw counts; recompute is done in run() via games' counts.
    need = math.ceil(op.target_recall * op.n_incidents_denom)
    rows = []
    for bw in (0, 30, 60, 90, 120):
        op_bw = dataclasses.replace(op, baseline_window=bw)
        games_bw = [
            {
                "game_id": g["game_id"],
                "z_by_win": trailing_robust_z(g["counts_by_win"], op_bw),
                "incident_spans": g["incident_spans"],
            }
            for g in games
        ]
        sweep = [evaluate_threshold(games_bw, t, window_sec, op_bw) for t in thresholds]
        feas = [s for s in sweep if s["fp_ratio"] is not None and s["fp_ratio"] <= op.max_fp_ratio]
        best = sorted(feas, key=lambda s: (-s["caught"], s["fp_ratio"]))[0] if feas else None
        at_bar = [s for s in sweep if s["caught"] >= need and s["fp_ratio"] is not None]
        fp_bar = min((s["fp_ratio"] for s in at_bar), default=None)
        ceil = max(sweep, key=lambda s: s["caught"])
        rows.append({
            "baseline": "expanding" if bw == 0 else f"rolling-{bw}",
            "best_feasible_caught": best["caught"] if best else 0,
            "best_feasible_fp_ratio": best["fp_ratio"] if best else None,
            "fp_ratio_at_target_recall": fp_bar,
            "recall_ceiling": ceil["caught"],
        })
    return rows


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Whole-board confluence operating-point eval")
    ap.add_argument("--registry", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    db_path = resolve_db_path()
    registry = resolve_registry_path(args.registry)
    report = run(db_path, registry)

    out_dir = Path(resolve_out_root(args.out)) / "confluence-operating-point"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "result.json"
    out_file.write_text(json.dumps(report, indent=2))

    op = report["op_params"]
    need = math.ceil(op["target_recall"] * op["n_incidents_denom"])
    print("=== Confluence operating-point eval ===")
    print(
        f"incidents total={report['n_incidents_total']} scorable={report['n_incidents_scorable']} "
        f"games={report['n_games']} unusable={report['unusable_incident_ids']}"
    )
    print(f"BAR: catch >= {need}/{op['n_incidents_denom']} at FP:TP <= {op['max_fp_ratio']}:1")
    b = report["best_feasible_point"]
    if b:
        print(
            f"best feasible (<= {op['max_fp_ratio']}:1): thr={b['threshold']} "
            f"caught={b['caught']}/{op['n_incidents_denom']} (recall={b['recall_over_denom']}) "
            f"fp_ratio={b['fp_ratio']}:1 (fp_alerts={b['fp_alerts']}, true_catches={b['caught']})"
        )
    else:
        print("best feasible (<= 3:1): NONE — no threshold meets the FP ratio")
    mr = report["max_recall_point"]
    print(
        f"separation ceiling: max caught={mr['caught']}/{op['n_incidents_denom']} "
        f"at thr={mr['threshold']} fp_ratio={mr['fp_ratio']}:1"
    )
    print(f"MEETS BAR: {report['meets_bar']}")
    print(f"wrote {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
