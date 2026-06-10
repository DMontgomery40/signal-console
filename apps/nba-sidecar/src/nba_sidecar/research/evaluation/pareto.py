"""pareto: Pareto-front dominance analysis for the Quant Lab model bakeoff.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, June 2026):

    "The Pareto triplet — calibration, discrimination/sharpness, and burden.
     No single objective. Any model that improves one without regressing the
     others is a Pareto improvement. We pick our operating point from the
     nondominated front."

Signal console analog:
    The three dimensions are:
        1. incident_recall      — maximize (more true positives)
        2. fires_per_game       — minimize (lower alert burden on traders)
        3. calibration_ece      — minimize (Phase 3 wires it in; pass None until then)

    A model A DOMINATES model B if:
        A.recall >= B.recall
        AND A.fires_per_game <= B.fires_per_game
        AND A.ece <= B.ece             (only when both ece values are provided)
        AND at least one of those inequalities is strict.

    The PARETO FRONT is the set of models not dominated by any other model.
    These are the only candidates worth discussing with the trading desk.

Usage:
    from nba_sidecar.research.evaluation.pareto import (
        ParetoPoint,
        build_pareto_front,
        print_pareto_report,
        dominates,
    )

    points = [
        ParetoPoint("robust_mad",          recall=0.267, fires_per_game=15.55),
        ParetoPoint("state_space_current", recall=0.000, fires_per_game=0.75),
    ]
    front, dominated = build_pareto_front(points)
    print_pareto_report(front, dominated)

CLI:
    uv run --extra research python -m nba_sidecar.research.evaluation.pareto \\
        --snapshot /path/to/snapshot \\
        --models robust_mad state_space_current virtual_source_state_space

References:
    Ingram (Swish workshop June 2026) — the calibration/sharpness/burden triplet.
    docs/moniac-pipeline-plan-and-code-draft.md (Phase 2 source material).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ParetoPoint:
    """One model's position in the Pareto objective space.

    All objectives are compared as LOWER IS BETTER internally; recall is
    converted to a cost (1 - recall) so the dominance logic is uniform.

    Args:
        name:            model identifier string
        recall:          incident_recall in [0, 1]  (higher is better)
        fires_per_game:  mean fires per game         (lower is better)
        ece:             calibration ECE              (lower is better)
                         Pass None if not yet computed (the dimension is then
                         excluded from dominance comparisons).
        extra:           additional metadata (bundle fields, params, ...) kept
                         for reporting but never used in dominance logic.
    """

    name: str
    recall: float  # stored as-is for display
    fires_per_game: float
    ece: Optional[float] = None
    extra: dict = field(default_factory=dict)

    @property
    def _recall_cost(self) -> float:
        """Convert recall to a cost (lower is better) for uniform dominance."""
        return 1.0 - self.recall

    def objective_vector(self) -> list[Optional[float]]:
        """Objectives as costs (lower is better): [recall_cost, fires_per_game, ece].

        None marks a dimension as unavailable.
        """
        return [self._recall_cost, self.fires_per_game, self.ece]


# ---------------------------------------------------------------------------
# Dominance and Pareto front
# ---------------------------------------------------------------------------


def dominates(a: ParetoPoint, b: ParetoPoint) -> bool:
    """Return True if model A Pareto-dominates model B.

    A dominates B iff A is at least as good as B on every available dimension
    and strictly better on at least one. Dimensions where either point has
    ece=None are skipped (not compared) — Phase 2 runs without ECE, Phase 3
    adds it seamlessly.
    """
    a_vec = a.objective_vector()
    b_vec = b.objective_vector()

    at_least_as_good_all = True
    strictly_better_one = False

    for a_val, b_val in zip(a_vec, b_vec, strict=True):
        # Skip dimension if either value is unavailable.
        if a_val is None or b_val is None:
            continue

        if a_val > b_val + 1e-9:
            # A is strictly worse on this dimension → cannot dominate.
            at_least_as_good_all = False
            break

        if b_val > a_val + 1e-9:
            # A is strictly better on this dimension.
            strictly_better_one = True

    return at_least_as_good_all and strictly_better_one


def build_pareto_front(
    points: list[ParetoPoint],
) -> tuple[list[ParetoPoint], dict[str, list[str]]]:
    """Identify the Pareto-nondominated frontier.

    Returns:
        (front, dominated_by) where ``front`` is the nondominated subset and
        ``dominated_by`` maps each dominated model name to the names that
        dominate it.

    Algorithm: O(n^2) pairwise dominance check — fine for the model counts the
    Quant Lab will ever have.
    """
    n = len(points)
    dominated_by: dict[str, list[str]] = {p.name: [] for p in points}

    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            if dominates(points[i], points[j]):
                dominated_by[points[j].name].append(points[i].name)

    front = [p for p in points if len(dominated_by[p.name]) == 0]
    dominated_map = {
        name: dominators for name, dominators in dominated_by.items() if dominators
    }

    return front, dominated_map


def pareto_rank(points: list[ParetoPoint]) -> list[tuple[int, ParetoPoint]]:
    """Assign Pareto ranks: rank 1 = nondominated front, rank k = nondominated
    after removing ranks 1..k-1. Sorted by rank ascending, then recall
    descending within a rank — a total ordering for a ranked leaderboard."""
    remaining = list(points)
    ranked: list[tuple[int, ParetoPoint]] = []
    current_rank = 1

    while remaining:
        front, _ = build_pareto_front(remaining)
        front_names = {p.name for p in front}
        for p in front:
            ranked.append((current_rank, p))
        remaining = [p for p in remaining if p.name not in front_names]
        current_rank += 1

    ranked.sort(key=lambda x: (x[0], -(x[1].recall)))
    return ranked


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def print_pareto_report(
    front: list[ParetoPoint],
    dominated_by: dict[str, list[str]],
    all_points: Optional[list[ParetoPoint]] = None,
) -> None:
    """Print a human-readable Pareto analysis to stdout."""
    _line = "─" * 72

    print()
    print("=" * 72)
    print("PARETO FRONT ANALYSIS — Signal Console Quant Lab bakeoff")
    print("(calibration/sharpness/burden triplet framing; see pareto.py docstring)")
    print("=" * 72)
    print()

    print("PARETO-NONDOMINATED FRONT (the only models worth discussing as")
    print("operating points):")
    print()
    print(f"  {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}")
    print("  " + _line)
    best_recall = max((p.recall for p in front), default=0.0)
    for p in sorted(front, key=lambda x: -x.recall):
        ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
        marker = "  <- best recall" if p.recall == best_recall else ""
        print(
            f"  {p.name:<28} {p.recall:>8.3f} {p.fires_per_game:>12.2f} "
            f"{ece_str:>8}{marker}"
        )
    print()

    if dominated_by:
        print("DOMINATED MODELS (strictly worse than another model on every")
        print("measured dimension — not candidate operating points):")
        print()
        print(
            f"  {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}  Dominated by"
        )
        print("  " + _line)
        if all_points:
            point_map = {p.name: p for p in all_points}
            for name, dominators in sorted(dominated_by.items()):
                p = point_map[name]
                ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
                dom_str = ", ".join(dominators[:3])
                if len(dominators) > 3:
                    dom_str += f" +{len(dominators) - 3} more"
                print(
                    f"  {name:<28} {p.recall:>8.3f} {p.fires_per_game:>12.2f} "
                    f"{ece_str:>8}  {dom_str}"
                )
        print()

    if all_points and len(all_points) > len(front):
        ranked = pareto_rank(all_points)
        print("FULL PARETO RANKING (rank 1 = nondominated front):")
        print()
        print(f"  {'Rank':<6} {'Model':<28} {'Recall':>8} {'Fires/game':>12} {'ECE':>8}")
        print("  " + _line)
        for rank, p in ranked:
            ece_str = f"{p.ece:.4f}" if p.ece is not None else "  n/a  "
            print(
                f"  {rank:<6} {p.name:<28} {p.recall:>8.3f} "
                f"{p.fires_per_game:>12.2f} {ece_str:>8}"
            )
        print()

    print("HOW TO READ THIS:")
    print("  - A model on the front cannot improve one dimension without getting")
    print("    worse on another; front members are different operating points")
    print("    (high-recall/high-burden vs low-burden/low-recall).")
    print("  - A dominated model has no use case: another model is strictly")
    print("    better on at least one metric and no worse on any other.")
    print("  - Moving the FRONT itself (not picking a point on it) requires a")
    print("    different architecture, not threshold tuning.")
    print()


def pareto_points_from_snapshot(
    model_names: list[str],
    snapshot_path: Path,
) -> list[ParetoPoint]:
    """Score the named registered models against the snapshot as ParetoPoints.

    Convenience used by the CLI and by Phase 3/4 to build points without
    hand-running the scorer. ``ece`` stays None until the calibration
    diagnostic (Phase 3) fills it.
    """
    # Imported here to keep the dominance machinery import-light (the pure
    # functions above need no pandas/snapshot stack).
    from nba_sidecar.research.evaluation.evaluator import evaluate_model
    from nba_sidecar.research.models import list_models

    registered = set(list_models())
    points: list[ParetoPoint] = []

    for name in model_names:
        if name not in registered:
            print(f"  WARNING: model '{name}' not in registry — skipping", file=sys.stderr)
            continue

        bundle, _, _ = evaluate_model(name, snapshot_path)

        points.append(
            ParetoPoint(
                name=name,
                recall=bundle.incident_recall,
                fires_per_game=bundle.fires_per_game,
                ece=None,  # populated by the Phase 3 calibration diagnostic
                extra={
                    "tape_outlier_recall": bundle.tape_outlier_recall,
                    "per_game_outlier_burden": bundle.per_game_outlier_burden,
                    "residual_coverage": bundle.residual_coverage,
                },
            )
        )

    return points


def save_pareto_results(
    points: list[ParetoPoint],
    front: list[ParetoPoint],
    dominated_by: dict[str, list[str]],
    output_path: Path,
) -> None:
    """Persist the Pareto analysis as JSON for downstream use."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ranked = pareto_rank(points)
    rank_map = {p.name: r for r, p in ranked}

    data = {
        "pareto_front": [p.name for p in front],
        "dominated": dominated_by,
        "all_models": [
            {
                "name": p.name,
                "pareto_rank": rank_map.get(p.name, -1),
                "recall": p.recall,
                "fires_per_game": p.fires_per_game,
                "ece": p.ece,
                **p.extra,
            }
            for p in points
        ],
    }
    output_path.write_text(json.dumps(data, indent=2))
    print(f"Pareto results saved to {output_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Run Pareto front analysis on registered board models.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--snapshot",
        type=Path,
        required=True,
        help="Path to the Quant Lab snapshot directory",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        required=True,
        help="Space-separated list of registered model names to compare",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("outputs/nba-quant-lab/pareto-results.json"),
        help="Where to save the JSON results",
    )
    args = parser.parse_args()

    print(f"Scoring {len(args.models)} models against snapshot: {args.snapshot}")
    points = pareto_points_from_snapshot(args.models, args.snapshot)

    if not points:
        print("ERROR: No models scored successfully. Check model names.", file=sys.stderr)
        sys.exit(1)

    front, dominated_by = build_pareto_front(points)
    print_pareto_report(front, dominated_by, all_points=points)
    save_pareto_results(points, front, dominated_by, args.output)


if __name__ == "__main__":
    _cli()


__all__ = [
    "ParetoPoint",
    "dominates",
    "build_pareto_front",
    "pareto_rank",
    "print_pareto_report",
    "pareto_points_from_snapshot",
    "save_pareto_results",
]
