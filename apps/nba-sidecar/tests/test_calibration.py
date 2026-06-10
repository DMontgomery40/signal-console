"""Tests for evaluation/calibration.py — the ECE diagnostic.

Coverage intent from docs/moniac-pipeline-plan-and-code-draft.md Phase 3 Step 2,
converted to the current prediction frame: top-level ``score`` + synthetic truthOutcome labels plus
the optional flattened ``warmed``/``regimeScore`` diagnostics. The retired
top-level ``regime_score``/``warmed_up`` names are never written.

Run with:
    cd apps/nba-sidecar
    uv run --extra research --extra dev python -m pytest tests/test_calibration.py -v
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from nba_sidecar.research.evaluation.calibration import (
    calibration_bins,
    compute_ece,
    compute_ece_for_model,
    print_calibration_report,
    truth_outcome_labels,
)
from nba_sidecar.research.evaluation.truth import SnapshotTruth

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_predictions(
    scores: list[float] | None = None,
    outcomes: list[bool] | None = None,
    warmed: list[bool] | None = None,
) -> pd.DataFrame:
    """Synthetic frame whose truthOutcome column is the TRUTH label the bins
    target (never the model's own fired gate)."""
    values = scores or []
    outcomes = outcomes or []
    n = len(values)
    assert len(outcomes) == n, "scores and outcomes must have same length"
    if warmed is None:
        warmed = [True] * n
    return pd.DataFrame({"score": values, "truthOutcome": outcomes, "warmed": warmed})


def _perfect_calibration_df(n_per_bin: int = 50, n_bins: int = 10) -> pd.DataFrame:
    """Perfectly calibrated frame: in each bin centred at c, outcome rate = c."""
    scores: list[float] = []
    outcomes: list[bool] = []
    bin_centres = [(i + 0.5) / n_bins for i in range(n_bins)]
    rng = np.random.default_rng(seed=42)
    for c in bin_centres:
        bin_scores = (
            rng.uniform(c - 0.5 / n_bins, c + 0.5 / n_bins, size=n_per_bin)
            .clip(0, 1)
            .tolist()
        )
        n_pos = int(round(c * n_per_bin))
        bin_outcomes = [True] * n_pos + [False] * (n_per_bin - n_pos)
        scores.extend(bin_scores)
        outcomes.extend(bin_outcomes)
    return _make_predictions(scores, outcomes)


# ---------------------------------------------------------------------------
# calibration_bins()
# ---------------------------------------------------------------------------


class TestCalibrationBins:
    def test_returns_correct_number_of_bins(self):
        df = _make_predictions(scores=[0.1, 0.5, 0.9], outcomes=[False, False, True])
        assert len(calibration_bins(df, n_bins=10)) == 10

    def test_bin_edges_cover_zero_to_one_contiguously(self):
        df = _make_predictions(scores=[0.0, 0.5, 1.0], outcomes=[False, False, True])
        bins = calibration_bins(df, n_bins=5)
        assert math.isclose(bins[0].bin_lower, 0.0, abs_tol=1e-9)
        assert math.isclose(bins[-1].bin_upper, 1.0, abs_tol=1e-9)
        for i in range(len(bins) - 1):
            assert math.isclose(bins[i].bin_upper, bins[i + 1].bin_lower, abs_tol=1e-9)

    def test_counts_sum_to_total_warmed_buckets(self):
        df = _make_predictions(scores=[0.1, 0.2, 0.5, 0.7, 0.9], outcomes=[False] * 5)
        assert sum(b.count for b in calibration_bins(df, n_bins=10)) == 5

    def test_unwarmed_buckets_excluded(self):
        df = _make_predictions(
            scores=[0.5, 0.5, 0.5],
            outcomes=[True, True, True],
            warmed=[True, False, False],
        )
        assert sum(b.count for b in calibration_bins(df, n_bins=10)) == 1

    def test_empty_dataframe_returns_empty_list(self):
        assert calibration_bins(_make_predictions(), n_bins=10) == []

    def test_all_unwarmed_returns_empty_list(self):
        df = _make_predictions(
            scores=[0.5, 0.5], outcomes=[True, True], warmed=[False, False]
        )
        assert calibration_bins(df, n_bins=10) == []

    def test_score_exactly_one_goes_in_last_bin(self):
        bins = calibration_bins(_make_predictions([1.0], [True]), n_bins=10)
        assert bins[-1].count == 1
        assert bins[-1].outcome_rate == 1.0

    def test_score_exactly_zero_goes_in_first_bin(self):
        bins = calibration_bins(_make_predictions([0.0], [False]), n_bins=10)
        assert bins[0].count == 1
        assert bins[0].outcome_rate == 0.0

    def test_outcome_rate_computed_correctly(self):
        df = _make_predictions(
            scores=[0.05, 0.10, 0.15, 0.19], outcomes=[True, False, False, False]
        )
        first_bin = calibration_bins(df, n_bins=5)[0]
        assert first_bin.count == 4
        assert math.isclose(first_bin.outcome_rate, 0.25, rel_tol=1e-6)

    def test_mean_score_computed_correctly(self):
        df = _make_predictions(scores=[0.10, 0.20], outcomes=[False, False])
        # 0.10 lands in [0.0, 0.2); 0.20 lands in [0.2, 0.4).
        bins = calibration_bins(df, n_bins=5)
        assert math.isclose(bins[0].mean_score, 0.10, rel_tol=1e-6)
        assert math.isclose(bins[1].mean_score, 0.20, rel_tol=1e-6)

    def test_gap_is_abs_difference(self):
        df = _make_predictions(scores=[0.80, 0.85, 0.90], outcomes=[False, False, False])
        high_bin = next(b for b in calibration_bins(df, n_bins=10) if b.count > 0)
        assert math.isclose(
            high_bin.gap, abs(high_bin.outcome_rate - high_bin.mean_score), rel_tol=1e-9
        )

    def test_weighted_gap_is_weight_times_gap(self):
        bins = calibration_bins(_perfect_calibration_df(20, 5), n_bins=5)
        for b in bins:
            if b.count > 0:
                assert math.isclose(b.weighted_gap, b.weight * b.gap, rel_tol=1e-9)

    def test_weights_sum_to_one(self):
        bins = calibration_bins(_perfect_calibration_df(30, 10), n_bins=10)
        assert math.isclose(sum(b.weight for b in bins), 1.0, rel_tol=1e-9)

    def test_raises_on_missing_column(self):
        df = pd.DataFrame({"truthOutcome": [True], "warmed": [True]})
        with pytest.raises(ValueError, match="missing required columns"):
            calibration_bins(df, n_bins=10)

    def test_raises_on_out_of_range_scores(self):
        df = _make_predictions(scores=[0.5, 1.5], outcomes=[False, True])
        with pytest.raises(ValueError, match="score must be in"):
            calibration_bins(df, n_bins=10)

    def test_raises_on_negative_scores(self):
        df = _make_predictions(scores=[-0.1, 0.5], outcomes=[False, True])
        with pytest.raises(ValueError, match="score must be in"):
            calibration_bins(df, n_bins=10)

    def test_custom_column_names(self):
        df = pd.DataFrame(
            {"score": [0.3, 0.7], "alert": [False, True], "ready": [True, True]}
        )
        bins = calibration_bins(
            df, n_bins=5, score_col="score", outcome_col="alert", warmed_col="ready"
        )
        assert sum(b.count for b in bins) == 2

    def test_missing_warmed_column_defaults_to_all_warmed(self):
        df = pd.DataFrame({"score": [0.5, 0.7], "truthOutcome": [False, True]})
        assert sum(b.count for b in calibration_bins(df, n_bins=10)) == 2


# ---------------------------------------------------------------------------
# compute_ece()
# ---------------------------------------------------------------------------


class TestComputeEce:
    def test_perfect_calibration_ece_near_zero(self):
        result = compute_ece(_perfect_calibration_df(200, 10), n_bins=10)
        assert result.ece < 0.05, f"expected ECE < 0.05, got {result.ece:.4f}"

    def test_high_score_rare_fire_is_overconfident(self):
        scores = [0.9] * 200
        outcomes = [True] * 20 + [False] * 180  # 10% outcome rate
        result = compute_ece(_make_predictions(scores, outcomes), n_bins=10)
        assert result.ece > 0.5  # ≈ |0.10 - 0.90|
        assert result.overconfident

    def test_low_score_frequent_fire_is_underconfident_with_high_ece(self):
        scores = [0.1] * 200
        outcomes = [True] * 160 + [False] * 40  # 80% outcome rate
        result = compute_ece(_make_predictions(scores, outcomes), n_bins=10)
        assert result.ece > 0.5  # ≈ |0.80 - 0.10|
        # All mass sits below 0.5, so the upper-bin bias probe abstains —
        # honesty over fabrication; the note says it cannot assess bias.
        assert not result.overconfident
        assert any("cannot assess confidence bias" in n for n in result.notes)

    def test_binary_perfect_model_ece_near_zero(self):
        scores = [0.0] * 100 + [1.0] * 100
        outcomes = [False] * 100 + [True] * 100
        result = compute_ece(_make_predictions(scores, outcomes), n_bins=10)
        assert result.ece < 0.01

    def test_ece_is_nan_for_empty_predictions(self):
        result = compute_ece(_make_predictions(), n_bins=10)
        assert math.isnan(result.ece)

    def test_ece_is_nan_for_all_unwarmed(self):
        df = _make_predictions(
            scores=[0.5, 0.5], outcomes=[True, True], warmed=[False, False]
        )
        result = compute_ece(df, n_bins=10)
        assert math.isnan(result.ece)

    def test_total_buckets_counts_only_warmed(self):
        df = _make_predictions(
            scores=[0.5, 0.5, 0.5, 0.5],
            outcomes=[True, True, False, False],
            warmed=[True, True, False, False],
        )
        assert compute_ece(df, n_bins=10).total_buckets == 2

    def test_empty_bins_counted_correctly(self):
        scores = [0.45, 0.50, 0.55] * 10
        result = compute_ece(_make_predictions(scores, [False] * 30), n_bins=10)
        assert result.empty_bins >= 8

    def test_sparse_data_note_added(self):
        df = _make_predictions(scores=[0.05, 0.55, 0.95], outcomes=[False, False, True])
        result = compute_ece(df, n_bins=10)
        assert any(
            "populated bins" in n.lower() or "unreliable" in n.lower()
            for n in result.notes
        )

    def test_model_name_propagated(self):
        result = compute_ece(
            _perfect_calibration_df(10), n_bins=10, model_name="virtual_source_state_space"
        )
        assert result.model_name == "virtual_source_state_space"

    def test_n_bins_respected(self):
        result = compute_ece(_perfect_calibration_df(20, 5), n_bins=5)
        assert result.n_bins == 5
        assert len(result.bins) == 5

    def test_max_gap_property(self):
        df = _make_predictions(scores=[0.05, 0.95], outcomes=[True, False])
        result = compute_ece(df, n_bins=10)
        expected = max(b.gap for b in result.bins if b.count > 0)
        assert math.isclose(result.max_gap, expected, rel_tol=1e-9)

    def test_populated_bins_property(self):
        result = compute_ece(
            _make_predictions(scores=[0.1, 0.9], outcomes=[False, True]), n_bins=10
        )
        assert all(b.count > 0 for b in result.populated_bins)

    def test_ece_bounded_zero_to_one(self):
        rng = np.random.default_rng(seed=123)
        for _ in range(20):
            n = int(rng.integers(10, 200))
            scores = rng.uniform(0, 1, size=n).tolist()
            outcomes = rng.choice([True, False], size=n).tolist()
            result = compute_ece(_make_predictions(scores, outcomes), n_bins=10)
            if not math.isnan(result.ece):
                assert 0.0 <= result.ece <= 1.0

    def test_calibrated_beats_anticalibrated(self):
        scores = [0.3] * 50 + [0.7] * 50
        outcomes_good = [False] * 50 + [True] * 50  # low score → no event
        outcomes_bad = [True] * 50 + [False] * 50  # low score → event
        good = compute_ece(_make_predictions(scores, outcomes_good), n_bins=10)
        bad = compute_ece(_make_predictions(scores, outcomes_bad), n_bins=10)
        assert good.ece < bad.ece

    def test_five_bin_mode_for_sparse_data(self):
        df = _make_predictions(
            scores=[0.1, 0.3, 0.5, 0.7, 0.9], outcomes=[False, False, True, False, True]
        )
        result = compute_ece(df, n_bins=5)
        assert len(result.bins) == 5
        assert result.n_bins == 5


# ---------------------------------------------------------------------------
# print_calibration_report() smoke tests
# ---------------------------------------------------------------------------


class TestPrintCalibrationReport:
    def test_prints_without_error_perfect(self, capsys):
        result = compute_ece(
            _perfect_calibration_df(50, 10), n_bins=10, model_name="test_model"
        )
        print_calibration_report(result)
        captured = capsys.readouterr()
        assert "CALIBRATION REPORT" in captured.out
        assert "test_model" in captured.out

    def test_prints_excellent_for_low_ece(self, capsys):
        result = compute_ece(_perfect_calibration_df(200, 10), n_bins=10)
        result.ece = 0.01  # force the band deterministically
        print_calibration_report(result)
        assert "Excellent" in capsys.readouterr().out

    def test_prints_poor_for_high_ece(self, capsys):
        result = compute_ece(
            _make_predictions([0.9] * 100, [False] * 100),
            n_bins=10,
            model_name="bad_model",
        )
        print_calibration_report(result)
        assert "Poor" in capsys.readouterr().out

    def test_prints_nan_ece_gracefully(self, capsys):
        result = compute_ece(
            _make_predictions([0.5], [True], warmed=[False]),
            n_bins=10,
            model_name="no_warmup_model",
        )
        print_calibration_report(result)
        assert "CALIBRATION REPORT" in capsys.readouterr().out

    def test_reliability_diagram_contains_bars(self, capsys):
        scores = [0.85] * 50
        outcomes = [True] * 40 + [False] * 10
        result = compute_ece(_make_predictions(scores, outcomes), n_bins=10)
        print_calibration_report(result)
        assert "▓" in capsys.readouterr().out

    def test_notes_printed_when_present(self, capsys):
        result = compute_ece(
            _make_predictions([0.1, 0.5, 0.9], [False, False, True]), n_bins=10
        )
        result.notes = ["This is a test diagnostic note for rendering."]
        print_calibration_report(result)
        out = capsys.readouterr().out
        assert "NOTES" in out
        assert "test diagnostic note" in out

    def test_overconfident_label_printed(self, capsys):
        result = compute_ece(_make_predictions([0.9] * 100, [False] * 100), n_bins=10)
        print_calibration_report(result)
        assert "OVERCONFIDENT" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# truth_outcome_labels() — calibration target comes from TRUTH, never fired
# ---------------------------------------------------------------------------

_C0 = 1_700_000_000  # fixture epoch


def _cal_iso(sec: int) -> str:
    return datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _bucket_frame(game_id: str, base: int, n: int, fired: list[bool] | None = None) -> pd.DataFrame:
    fired = fired or [False] * n
    rows = []
    for i in range(n):
        s = base + i * 60
        rows.append(
            {
                "game_id": game_id,
                "bucket_start": _cal_iso(s),
                "bucket_end": _cal_iso(s + 60),
                "score": 0.1,
                "fired": fired[i],
                "warmed": True,
            }
        )
    return pd.DataFrame(rows)


def _truth(
    window: tuple[str, int, int] | None = None,
    episode: tuple[str, int, int] | None = None,
) -> SnapshotTruth:
    incidents_rows = []
    window_rows = []
    if window is not None:
        gid, ws, we = window
        incidents_rows.append(
            {
                "incident_id": "inc1",
                "canonical_game_id": gid,
                "has_local_window": True,
                "scoreable": True,
                "confidence": "high",
                "anchor_type": "second",
                "utc_time": _cal_iso(ws),
                "event_sec": ws,
                "stat": "rebound",
                "credited_player": "A",
                "rightful_player": "B",
                "official_correction": False,
            }
        )
        window_rows.append(
            {
                "incident_id": "inc1",
                "game_id": gid,
                "window_start": _cal_iso(ws),
                "window_end": _cal_iso(we),
                "window_start_sec": ws,
                "window_end_sec": we,
            }
        )
    episode_rows = []
    if episode is not None:
        gid, es, ee = episode
        episode_rows.append(
            {
                "episode_id": f"{gid}:moe:0",
                "game_id": gid,
                "start_sec": es,
                "end_sec": ee,
                "bucket_seconds": 60,
                "bucket_count": 1,
                "peak_severity": 5.0,
                "peak_price_move_z": 4.0,
                "diagnosis": "price move outlier",
            }
        )
    inc_cols = [
        "incident_id", "canonical_game_id", "has_local_window", "scoreable", "confidence",
        "anchor_type", "utc_time", "event_sec", "stat", "credited_player", "rightful_player",
        "official_correction",
    ]
    win_cols = ["incident_id", "game_id", "window_start", "window_end", "window_start_sec", "window_end_sec"]
    epi_cols = [
        "episode_id", "game_id", "start_sec", "end_sec", "bucket_seconds", "bucket_count",
        "peak_severity", "peak_price_move_z", "diagnosis",
    ]
    cov_cols = ["game_id", "source", "market_family", "window", "class", "market_count", "tick_count", "eligible"]
    return SnapshotTruth(
        incidents=pd.DataFrame(incidents_rows, columns=inc_cols),
        score_windows=pd.DataFrame(window_rows, columns=win_cols),
        market_outlier_episodes=pd.DataFrame(episode_rows, columns=epi_cols),
        source_coverage=pd.DataFrame([], columns=cov_cols),
    )


class TestTruthOutcomeLabels:
    def test_window_overlap_labels_positive(self):
        preds = _bucket_frame("G1", _C0, 10)
        truth = _truth(window=("G1", _C0 + 120, _C0 + 180))
        labels = truth_outcome_labels(preds, truth)
        # scorer overlap semantics: bucket [120,180) overlaps; a bucket
        # STARTING exactly at window_end (180) does not (half-open).
        assert labels.tolist() == [0, 0, 1, 0, 0, 0, 0, 0, 0, 0]

    def test_episode_overlap_labels_positive(self):
        preds = _bucket_frame("G1", _C0, 10)
        truth = _truth(episode=("G1", _C0 + 300, _C0 + 360))
        labels = truth_outcome_labels(preds, truth)
        assert labels.sum() > 0
        assert labels.iloc[5] == 1.0

    def test_no_truth_means_all_zero(self):
        preds = _bucket_frame("G1", _C0, 5)
        assert truth_outcome_labels(preds, _truth()).sum() == 0.0

    def test_other_games_truth_does_not_leak(self):
        preds = _bucket_frame("G2", _C0, 5)
        truth = _truth(window=("G1", _C0 + 60, _C0 + 120))
        assert truth_outcome_labels(preds, truth).sum() == 0.0

    def test_labels_are_independent_of_fired(self):
        # The regression Codex flagged: a never-firing model inside a truth
        # window must still get positive outcome labels (and a high-score
        # false positive that fires must NOT look "accurate" via fired).
        preds = _bucket_frame("G1", _C0, 10, fired=[False] * 10)
        truth = _truth(window=("G1", _C0 + 120, _C0 + 180))
        labels = truth_outcome_labels(preds, truth)
        assert labels.sum() > 0  # fired played no role


class TestComputeEceForModelUsesTruth:
    def test_never_firing_model_still_gets_truth_positive_outcomes(self, tmp_path):
        """End-to-end wiring: on a flat tape the model never fires, but truth
        windows exist — the binned outcome rate must reflect TRUTH (positive
        somewhere), which the old fired-based path would have scored all-zero."""
        snap = tmp_path / "cal-snap"
        snap.mkdir()
        n = 30
        board_rows = []
        for i in range(n):
            s = _C0 + i * 60
            board_rows.append(
                {
                    "game_id": "G1",
                    "bucket_start": _cal_iso(s),
                    "bucket_end": _cal_iso(s + 60),
                    "game_elapsed_seconds": float(i * 60),
                    "intensity": 1.0,
                    "active_market_count": 2,
                    "source_count": 2,
                    "source_dominance": 0.5,
                    "source_disagreement": 0.1,
                }
            )
        pd.DataFrame(board_rows).to_parquet(snap / "board_observations.parquet", index=False)
        truth = _truth(
            window=("G1", _C0 + 25 * 60, _C0 + 27 * 60),
            episode=("G1", _C0 + 28 * 60, _C0 + 28 * 60 + 30),
        )
        truth.incidents.to_parquet(snap / "incidents.parquet", index=False)
        truth.score_windows.to_parquet(snap / "score_windows.parquet", index=False)
        truth.market_outlier_episodes.to_parquet(snap / "market_outlier_episodes.parquet", index=False)
        truth.source_coverage.to_parquet(snap / "source_coverage.parquet", index=False)

        result = compute_ece_for_model("virtual_source_state_space", snap, n_bins=5)
        assert not math.isnan(result.ece)
        positives = sum(b.count * b.outcome_rate for b in result.bins)
        assert positives > 0  # truth labels, not the (never-True) fired gate
