"""calibration: Expected Calibration Error (ECE) diagnostic for board models.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, June 2026):

    "Calibration: when the model says 20%, it happens 20% of the time.
     This is the first leg of the Pareto triplet. A model can have great
     discrimination but terrible calibration — it will still misprice markets."

Signal console analog:
    A bounded score column (0–1) is the model's soft probability of an alert.
    Native predictions always carry a top-level ``score``; models whose primary
    score is unbounded (a z) may also flatten a ``regimeScore`` diagnostic
    column. ECE measures whether score=0.7 corresponds to a 70% empirical fire
    rate:

        ECE = Σ_b (|b| / N) × |acc_b - conf_b|

    where B equal-width bins partition [0, 1] by the selected score column,
    conf_b = mean(score) in bin b (model confidence), acc_b = mean(fired) in
    bin b (empirical fire rate), |b| = warmed buckets in bin b, and N = total
    warmed buckets. A perfectly calibrated model has ECE = 0. Overconfident:
    conf_b > acc_b in the high bins. Underconfident: the reverse.

Reliability diagram:
    The calibration curve plots conf_b against acc_b; perfect calibration lies
    on the diagonal y = x.

Usage:
    from nba_sidecar.research.evaluation.calibration import (
        compute_ece, calibration_bins, CalibrationResult, print_calibration_report,
    )

    result = compute_ece(predictions_df, n_bins=10, score_col="regimeScore")
    print_calibration_report(result)

Integration with the Pareto front (Phase 2):
    build_pareto_points_with_ece() wires result.ece into ParetoPoint.ece.

CLI:
    uv run --extra research python -m nba_sidecar.research.evaluation.calibration \\
        --snapshot /path/to/snapshot --model virtual_source_state_space --bins 10

References:
    Naeini, Cooper, Hauskrecht (2015), "Obtaining Well Calibrated Probabilities
    Using Bayesian Binning" (the standard 10-bin ECE).
    Ingram (Swish workshop June 2026) — the calibration leg of the triplet.
    docs/moniac-pipeline-plan-and-code-draft.md (Phase 3 source material).
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class BinStats:
    """Statistics for one calibration bin.

    Attributes:
        bin_lower:    lower edge of the score bin (inclusive)
        bin_upper:    upper edge (exclusive, except the last bin)
        count:        warmed buckets in this bin
        mean_score:   mean selected score in this bin (confidence)
        fire_rate:    empirical fire rate = mean(fired) in this bin (accuracy)
        gap:          |fire_rate - mean_score|
        weight:       count / total_count
        weighted_gap: weight × gap — the bin's direct ECE contribution
    """

    bin_lower: float
    bin_upper: float
    count: int
    mean_score: float
    fire_rate: float
    gap: float
    weight: float
    weighted_gap: float


@dataclass
class CalibrationResult:
    """Full calibration analysis for one model."""

    ece: float
    n_bins: int
    total_buckets: int
    empty_bins: int
    bins: list[BinStats]
    overconfident: bool
    underconfident: bool
    model_name: str = "unknown"
    notes: list[str] = field(default_factory=list)

    @property
    def max_gap(self) -> float:
        """Largest single-bin gap (worst miscalibration point)."""
        if not self.bins:
            return 0.0
        return max(b.gap for b in self.bins)

    @property
    def populated_bins(self) -> list[BinStats]:
        """Bins that contain at least one bucket."""
        return [b for b in self.bins if b.count > 0]


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------


def calibration_bins(
    predictions_df: pd.DataFrame,
    n_bins: int = 10,
    score_col: str = "score",
    fired_col: str = "fired",
    warmed_col: str = "warmed",
) -> list[BinStats]:
    """Compute per-bin calibration statistics.

    Args:
        predictions_df: one row per bucket prediction. Must carry the selected
                        score column (values in [0, 1]) and ``fired``;
                        ``warmed`` is optional and defaults to True when absent.
        n_bins:         equal-width bins partitioning [0, 1]. 10 is standard
                        (Naeini et al. 2015); use 5 for sparse data.
        score_col:      bounded soft-score column (default: ``score``).
        fired_col:      binary outcome column (default: ``fired``).
        warmed_col:     warmup gate column (default: ``warmed``).

    Returns:
        One BinStats per bin (empty bins carry count=0).

    Raises:
        ValueError: if required columns are missing or scores leave [0, 1].
    """
    required = {score_col, fired_col}
    missing = required - set(predictions_df.columns)
    if missing:
        raise ValueError(
            f"predictions_df is missing required columns: {missing}. "
            f"Available columns: {list(predictions_df.columns)}"
        )

    # Pre-warmup predictions are undefined and must not pollute the estimate.
    if warmed_col not in predictions_df.columns:
        predictions_df = predictions_df.copy()
        predictions_df[warmed_col] = True
    warmed = predictions_df[predictions_df[warmed_col].astype(bool)].copy()

    if warmed.empty:
        return []

    scores = warmed[score_col].astype(float).to_numpy()
    fired = warmed[fired_col].astype(float).to_numpy()

    if np.any(scores < 0.0) or np.any(scores > 1.0):
        bad_count = int(np.sum((scores < 0.0) | (scores > 1.0)))
        raise ValueError(
            f"{score_col} must be in [0, 1] but found {bad_count} values "
            f"outside this range. Min={scores.min():.4f}, Max={scores.max():.4f}. "
            f"Use a bounded score column such as the regimeScore diagnostic."
        )

    total = len(scores)
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    result_bins: list[BinStats] = []

    for i in range(n_bins):
        lower = float(bin_edges[i])
        upper = float(bin_edges[i + 1])

        # Last bin is inclusive on both ends so score=1.0 is captured.
        if i < n_bins - 1:
            mask = (scores >= lower) & (scores < upper)
        else:
            mask = (scores >= lower) & (scores <= upper)

        count = int(mask.sum())
        if count == 0:
            result_bins.append(
                BinStats(
                    bin_lower=lower,
                    bin_upper=upper,
                    count=0,
                    mean_score=0.0,
                    fire_rate=0.0,
                    gap=0.0,
                    weight=0.0,
                    weighted_gap=0.0,
                )
            )
            continue

        mean_score = float(scores[mask].mean())
        fire_rate = float(fired[mask].mean())
        gap = abs(fire_rate - mean_score)
        weight = count / total
        result_bins.append(
            BinStats(
                bin_lower=lower,
                bin_upper=upper,
                count=count,
                mean_score=mean_score,
                fire_rate=fire_rate,
                gap=gap,
                weight=weight,
                weighted_gap=weight * gap,
            )
        )

    return result_bins


def compute_ece(
    predictions_df: pd.DataFrame,
    n_bins: int = 10,
    score_col: str = "score",
    fired_col: str = "fired",
    warmed_col: str = "warmed",
    model_name: str = "unknown",
) -> CalibrationResult:
    """Compute Expected Calibration Error for a model's predictions.

    Only meaningful for a bounded 0–1 score: if the top-level ``score`` is an
    unbounded z, pass ``score_col="regimeScore"`` (the bounded diagnostic).
    NaN ECE means no warmed buckets — never fabricated as 0.
    """
    bins = calibration_bins(
        predictions_df=predictions_df,
        n_bins=n_bins,
        score_col=score_col,
        fired_col=fired_col,
        warmed_col=warmed_col,
    )

    if not bins:
        return CalibrationResult(
            ece=float("nan"),
            n_bins=n_bins,
            total_buckets=0,
            empty_bins=n_bins,
            bins=[],
            overconfident=False,
            underconfident=False,
            model_name=model_name,
            notes=["No warmed-up buckets found — ECE cannot be computed."],
        )

    ece = float(sum(b.weighted_gap for b in bins))
    total_buckets = sum(b.count for b in bins)
    empty_bins = sum(1 for b in bins if b.count == 0)
    populated = [b for b in bins if b.count > 0]

    notes: list[str] = []
    if len(populated) < 4:
        notes.append(
            f"Only {len(populated)} populated bins (of {n_bins}). ECE estimate "
            f"is unreliable. Consider --bins 5 or more data."
        )

    # Systematic bias direction over the upper half of the score range.
    top_bins = [b for b in populated if b.bin_lower >= 0.5]
    if top_bins:
        mean_gap_signed = float(np.mean([b.mean_score - b.fire_rate for b in top_bins]))
        overconfident = mean_gap_signed > 0.05
        underconfident = mean_gap_signed < -0.05
    else:
        overconfident = False
        underconfident = False
        notes.append(
            f"No buckets with {score_col} >= 0.5 — cannot assess confidence bias."
        )

    if overconfident:
        notes.append(
            f"Model is OVERCONFIDENT: {score_col} exceeds the empirical fire "
            "rate in the upper bins. Consider softening the score-to-probability "
            "mapping (e.g. the regime sigmoid steepness) or re-tuning enter_z."
        )
    elif underconfident:
        notes.append(
            f"Model is UNDERCONFIDENT: {score_col} sits below the empirical "
            "fire rate in the upper bins. Consider steepening the mapping."
        )

    if empty_bins > n_bins // 2:
        notes.append(
            f"{empty_bins}/{n_bins} bins are empty: the score distribution is "
            f"concentrated. Common when the trigger is high — most buckets "
            f"cluster near 0 with occasional spikes near 1."
        )

    return CalibrationResult(
        ece=ece,
        n_bins=n_bins,
        total_buckets=total_buckets,
        empty_bins=empty_bins,
        bins=bins,
        overconfident=overconfident,
        underconfident=underconfident,
        model_name=model_name,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def print_calibration_report(result: CalibrationResult) -> None:
    """Print a human-readable calibration report with an ASCII reliability diagram."""
    _line = "─" * 72

    print()
    print("=" * 72)
    print(f"CALIBRATION REPORT — {result.model_name}")
    print("(calibration leg of the calibration/sharpness/burden triplet)")
    print("=" * 72)
    print()

    ece_str = f"{result.ece:.4f}" if not math.isnan(result.ece) else "N/A"
    print(f"  ECE (Expected Calibration Error): {ece_str}")
    print("  Interpretation:")
    if math.isnan(result.ece):
        print("    No warmed-up buckets — cannot evaluate calibration.")
    elif result.ece < 0.02:
        print("    Excellent calibration (ECE < 0.02). Scores are honest.")
    elif result.ece < 0.05:
        print("    Good calibration (ECE < 0.05). Acceptable for desk use.")
    elif result.ece < 0.10:
        print("    Moderate miscalibration (ECE 0.05–0.10). Monitor closely.")
    else:
        print("    Poor calibration (ECE > 0.10). Scores are not trustworthy.")

    print(f"  Total warmed buckets scored: {result.total_buckets}")
    print(f"  Populated bins: {len(result.populated_bins)}/{result.n_bins}")
    if result.overconfident:
        print("  Bias: OVERCONFIDENT (fires less often than its scores suggest)")
    elif result.underconfident:
        print("  Bias: UNDERCONFIDENT (fires more often than its scores suggest)")
    else:
        print("  Bias: balanced (no systematic over/under-confidence detected)")
    print()

    print("  RELIABILITY DIAGRAM (each row = one score bin; bar = empirical")
    print("  fire rate; │ marks the bin's mean score = perfect-calibration mark):")
    print()
    print(f"  {'Bin':<14} {'Count':>6} {'Conf':>6} {'FireRate':>9}  Reliability")
    print("  " + _line)

    bar_width = 30
    for b in result.bins:
        bin_label = f"[{b.bin_lower:.1f}, {b.bin_upper:.1f})"
        if b.count == 0:
            print(f"  {bin_label:<14} {'—':>6} {'—':>6} {'—':>9}  (empty)")
            continue

        fire_pos = int(round(b.fire_rate * bar_width))
        conf_pos = int(round(b.mean_score * bar_width))
        bar = [" "] * (bar_width + 1)
        for k in range(min(fire_pos, bar_width + 1)):
            bar[k] = "▓"
        if 0 <= conf_pos <= bar_width:
            bar[conf_pos] = "┤" if conf_pos < fire_pos else "│"
        gap_marker = f"  gap={b.gap:.3f}" if b.gap > 0.05 else ""
        print(
            f"  {bin_label:<14} {b.count:>6} {b.mean_score:>6.3f} "
            f"{b.fire_rate:>9.3f}  {''.join(bar)}{gap_marker}"
        )
    print()

    print("  PER-BIN DETAIL:")
    print(
        f"  {'Bin':<14} {'Count':>6} {'Weight':>8} {'Conf':>7} "
        f"{'FireRate':>9} {'Gap':>7} {'WtdGap':>8}"
    )
    print("  " + _line)
    for b in result.bins:
        if b.count == 0:
            continue
        print(
            f"  [{b.bin_lower:.1f},{b.bin_upper:.1f})  "
            f"{b.count:>6}  {b.weight:>8.4f}  {b.mean_score:>7.4f}  "
            f"{b.fire_rate:>9.4f}  {b.gap:>7.4f}  {b.weighted_gap:>8.4f}"
        )
    print()

    if result.notes:
        print("  NOTES:")
        for note in result.notes:
            words = note.split()
            line = "    • "
            for word in words:
                if len(line) + len(word) + 1 > 70:
                    print(line)
                    line = "      " + word + " "
                else:
                    line += word + " "
            print(line.rstrip())
        print()

    print("  A model with great discrimination but poor calibration still")
    print("  misprices: ECE < 0.05 is the target before a bounded alert score")
    print("  is trusted for desk decisions.")
    print()


# ---------------------------------------------------------------------------
# Integration with the evaluator and the Pareto front
# ---------------------------------------------------------------------------


def compute_ece_for_model(
    model_name: str,
    snapshot_path: Path,
    n_bins: int = 10,
    score_col: str | None = None,
) -> CalibrationResult:
    """Score a registered model and compute its ECE in one call.

    Uses the shared ``evaluate_model`` path (no hand-rolled snapshot loading),
    then computes reliability over the returned predictions frame. The score
    column defaults to the bounded ``regimeScore`` diagnostic when the model
    emits it, else the top-level ``score``.
    """
    from nba_sidecar.research.evaluation.evaluator import evaluate_model

    _, _, predictions_df = evaluate_model(model_name, snapshot_path)
    selected = score_col
    if selected is None:
        selected = "regimeScore" if "regimeScore" in predictions_df.columns else "score"

    return compute_ece(
        predictions_df=predictions_df,
        n_bins=n_bins,
        score_col=selected,
        warmed_col="warmed",
        model_name=model_name,
    )


def build_pareto_points_with_ece(
    model_names: list[str],
    snapshot_path: Path,
    n_bins: int = 10,
) -> list:
    """ParetoPoints with ECE filled in — the third triplet dimension.

    Drop-in superset of ``pareto.pareto_points_from_snapshot``: models whose
    score cannot support ECE (no bounded column / no warmed buckets) keep
    ece=None and are excluded from that dominance dimension, never penalized
    with a fabricated number.
    """
    from nba_sidecar.research.evaluation.pareto import (
        ParetoPoint,
        pareto_points_from_snapshot,
    )

    points = pareto_points_from_snapshot(model_names, snapshot_path)
    point_map = {p.name: p for p in points}

    enriched: list[ParetoPoint] = []
    for name in model_names:
        if name not in point_map:
            continue
        p = point_map[name]
        try:
            cal_result = compute_ece_for_model(name, snapshot_path, n_bins)
            ece = cal_result.ece if not math.isnan(cal_result.ece) else None
        except (ValueError, KeyError) as e:
            print(f"  NOTE: ECE not available for '{name}': {e}", file=sys.stderr)
            ece = None

        enriched.append(
            ParetoPoint(
                name=p.name,
                recall=p.recall,
                fires_per_game=p.fires_per_game,
                ece=ece,
                extra=p.extra,
            )
        )

    return enriched


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Compute ECE calibration diagnostic for a board model.",
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
        "--model", type=str, required=True, help="Registered model name to evaluate"
    )
    parser.add_argument(
        "--bins",
        type=int,
        default=10,
        help="Number of calibration bins (default 10; use 5 for sparse data)",
    )
    parser.add_argument(
        "--pareto",
        action="store_true",
        help="After ECE, run the full Pareto analysis with the baselines",
    )
    args = parser.parse_args()

    print(f"Computing ECE for model '{args.model}' against snapshot: {args.snapshot}")
    result = compute_ece_for_model(args.model, args.snapshot, args.bins)
    print_calibration_report(result)

    if args.pareto:
        print("\nRunning full Pareto analysis with ECE included...")
        from nba_sidecar.research.evaluation.pareto import (
            build_pareto_front,
            print_pareto_report,
        )

        all_models = ["robust_mad", "state_space_current", args.model]
        points = build_pareto_points_with_ece(all_models, args.snapshot, args.bins)
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)


if __name__ == "__main__":
    _cli()


__all__ = [
    "BinStats",
    "CalibrationResult",
    "calibration_bins",
    "compute_ece",
    "compute_ece_for_model",
    "build_pareto_points_with_ece",
    "print_calibration_report",
]
