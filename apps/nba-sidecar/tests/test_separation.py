"""Behavior tests for the incident-alignment / feature-separation diagnostic.

These are fully hermetic: every test builds tiny in-memory board-observation
frames and a hand-built ``SnapshotTruth`` -- no snapshot directory, no gold DB,
no network. They pin the contract the research note relies on:

1. NEGATIVE CONTROL: a synthetic feature constructed to separate incident from
   non-incident buckets must score AUC -> 1. (Proves the metric can detect
   separation when it exists, so a ~0.5 reading on real features is a finding,
   not a broken metric.)
2. NULL CONTROL: a feature with identical in/out distribution scores AUC == 0.5.
3. FAIL CLOSED: an absent or all-null feature column reports
   ``insufficient_support`` and ``auc=None`` -- never a fabricated number; a
   snapshot with no scoreable window fails the whole report closed.
4. DECLARED KNOB: changing ``control_percentile`` changes the reported output.
5. CONTROL FEATURE EXCLUDED: the control-defining feature's circular AUC does not
   drive the verdict.

An optional real-snapshot regression runs only when ``NBA_RESEARCH_SNAPSHOT_PATH``
points at an exported snapshot (otherwise skipped), so the suite is green with no
data present.
"""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import pytest

from nba_sidecar.research.evaluation.separation import (
    DEFAULT_FEATURES,
    SeparationReport,
    feature_separation,
    rank_auc,
    run_separation,
)
from nba_sidecar.research.evaluation.truth import SnapshotTruth

_T0 = 1_700_000_000  # fixed unix-second epoch base; bucket i spans [T0+60i, T0+60(i+1))
_BUCKET = 60


def _ts(sec: int) -> pd.Timestamp:
    return pd.Timestamp(sec, unit="s", tz="UTC")


def _board(rows: list[dict], game_id: str = "g1") -> pd.DataFrame:
    """Build a board_observations frame; each row dict gives ``i`` + feature cols."""
    recs = []
    for r in rows:
        i = r["i"]
        start = _T0 + i * _BUCKET
        rec = {
            "game_id": game_id,
            "bucket_start": _ts(start),
            "bucket_end": _ts(start + _BUCKET),
        }
        rec.update({k: v for k, v in r.items() if k != "i"})
        recs.append(rec)
    return pd.DataFrame(recs)


def _truth(window_buckets: tuple[int, int], game_id: str = "g1", scoreable: bool = True) -> SnapshotTruth:
    """One scoreable incident whose window covers buckets [lo, hi)."""
    lo, hi = window_buckets
    incidents = pd.DataFrame([{"incident_id": "inc1", "scoreable": scoreable}])
    score_windows = pd.DataFrame(
        [{
            "incident_id": "inc1",
            "game_id": game_id,
            "window_start_sec": _T0 + lo * _BUCKET,
            "window_end_sec": _T0 + hi * _BUCKET,
        }]
    )
    empty_ep = pd.DataFrame(columns=["game_id"])
    empty_cov = pd.DataFrame(columns=["game_id"])
    return SnapshotTruth(
        incidents=incidents,
        score_windows=score_windows,
        market_outlier_episodes=empty_ep,
        source_coverage=empty_cov,
    )


def _by_feature(report: SeparationReport) -> dict[str, object]:
    return {f.feature: f for f in report.features}


# ---------------------------------------------------------------------------
# rank_auc unit behavior
# ---------------------------------------------------------------------------


def test_rank_auc_perfect_and_null_and_empty():
    assert rank_auc([1, 1, 1], [0, 0]) == 1.0      # all pos > all neg
    assert rank_auc([0, 0], [1, 1, 1]) == 0.0      # all pos < all neg
    assert rank_auc([7, 7, 7], [7, 7]) == 0.5      # ties -> exactly 0.5
    assert rank_auc([], [1, 2]) is None            # empty group -> None, never NaN
    assert rank_auc([1, 2], []) is None
    assert rank_auc([float("nan")], [1, 2]) is None  # all-NaN pos -> None


# ---------------------------------------------------------------------------
# 1. NEGATIVE CONTROL — a feature built to separate must score AUC -> 1
# ---------------------------------------------------------------------------


def test_synthetic_separable_feature_scores_auc_one():
    # buckets 0..19; window covers 8..13 (5 in-window). Out-of-window buckets
    # 18,19 are high-intensity so a control set exists; 'sep' is high in-window.
    rows = []
    for i in range(20):
        in_win = 8 <= i < 13
        rows.append({
            "i": i,
            "intensity": (100.0 if i in (18, 19) else (10.0 if in_win else 5.0)),
            "sep": (1.0 if in_win else 0.0),
            "flat": 7.0,
            "source_count": 2,
        })
    report = feature_separation(
        _board(rows), _truth((8, 13)),
        control_percentile=90.0,
        features=("intensity", "sep", "flat"),
    )
    feats = _by_feature(report)
    assert report.support == "ok"
    assert report.n_in_window_buckets == 5
    assert feats["sep"].auc_vs_control == pytest.approx(1.0)
    # and the verdict must recognize an elevated feature exists
    assert "viable" in report.verdict.lower() or "elevated" in report.verdict.lower()


# ---------------------------------------------------------------------------
# 2. NULL CONTROL — a flat feature scores exactly 0.5 (no separation)
# ---------------------------------------------------------------------------


def test_flat_feature_scores_half_and_verdict_is_negative():
    rows = []
    for i in range(20):
        in_win = 8 <= i < 13
        rows.append({
            "i": i,
            "intensity": (100.0 if i in (18, 19) else (10.0 if in_win else 5.0)),
            "flat": 7.0,
            "source_count": 1,
        })
    report = feature_separation(
        _board(rows), _truth((8, 13)),
        control_percentile=90.0,
        features=("intensity", "flat"),
    )
    feats = _by_feature(report)
    assert feats["flat"].auc_vs_control == pytest.approx(0.5)
    # only deviation is intensity (control feature, excluded) -> verdict negative
    assert "not" in report.verdict.lower() or "no pooled feature" in report.verdict.lower()


# ---------------------------------------------------------------------------
# 3. FAIL CLOSED
# ---------------------------------------------------------------------------


def test_absent_feature_is_insufficient_support_not_a_number():
    rows = [{"i": i, "intensity": (100.0 if i >= 18 else 5.0), "src": 1} for i in range(20)]
    report = feature_separation(
        _board(rows), _truth((8, 13)),
        features=("intensity", "does_not_exist"),
    )
    feats = _by_feature(report)
    assert feats["does_not_exist"].support == "insufficient_support"
    assert feats["does_not_exist"].auc_vs_control is None
    assert "not present" in feats["does_not_exist"].note


def test_all_null_feature_is_insufficient_support():
    rows = [{"i": i, "intensity": (100.0 if i >= 18 else 5.0), "empty": float("nan")} for i in range(20)]
    report = feature_separation(
        _board(rows), _truth((8, 13)),
        features=("intensity", "empty"),
    )
    feats = _by_feature(report)
    assert feats["empty"].support == "insufficient_support"
    assert feats["empty"].auc_vs_control is None
    assert "all-null" in feats["empty"].note


def test_no_scoreable_window_fails_report_closed():
    rows = [{"i": i, "intensity": 5.0} for i in range(20)]
    # incident present but NOT scoreable -> no scoreable window
    report = feature_separation(
        _board(rows), _truth((8, 13), scoreable=False),
        features=("intensity",),
    )
    assert report.support == "insufficient_support"
    assert report.n_scoreable_windows == 0
    assert "no scoreable" in report.verdict.lower()


def test_no_high_intensity_control_fails_closed():
    # all out-of-window intensity identical AND <= in-window: control still exists
    # (>= percentile threshold). To force NO control, make every bucket in-window.
    rows = [{"i": i, "intensity": 5.0} for i in range(6)]
    report = feature_separation(
        _board(rows), _truth((0, 6)),
        features=("intensity",),
    )
    # all buckets in-window -> no out-of-window control bucket
    assert report.support == "insufficient_support"
    assert "control" in report.verdict.lower()


# ---------------------------------------------------------------------------
# 4. DECLARED KNOB — control_percentile changes the output
# ---------------------------------------------------------------------------


def test_control_percentile_changes_control_set():
    # graded out-of-window intensities so p50 vs p90 select different control sizes
    rows = []
    for i in range(20):
        in_win = 8 <= i < 13
        rows.append({
            "i": i,
            "intensity": (10.0 if in_win else float(i)),  # 0..19 outside, 10 inside
            "sep": (1.0 if in_win else 0.0),
        })
    r90 = feature_separation(_board(rows), _truth((8, 13)), control_percentile=90.0, features=("sep",))
    r50 = feature_separation(_board(rows), _truth((8, 13)), control_percentile=50.0, features=("sep",))
    f90 = _by_feature(r90)["sep"]
    f50 = _by_feature(r50)["sep"]
    assert f50.n_control > f90.n_control  # lower percentile -> larger control set
    assert r50.control_intensity_threshold < r90.control_intensity_threshold


# ---------------------------------------------------------------------------
# 5. CONTROL FEATURE EXCLUDED FROM VERDICT (no circular "separation")
# ---------------------------------------------------------------------------


def test_control_feature_excluded_from_verdict():
    # intensity is wildly "separating" by construction (control is the high tail),
    # but every non-control feature is flat -> verdict must be NEGATIVE.
    rows = []
    for i in range(20):
        in_win = 8 <= i < 13
        rows.append({
            "i": i,
            "intensity": (100.0 if i in (18, 19) else (10.0 if in_win else 5.0)),
            "flat": 3.0,
            "source_count": 1,
        })
    report = feature_separation(
        _board(rows), _truth((8, 13)),
        features=("intensity", "flat"),
    )
    feats = _by_feature(report)
    # intensity itself is far from 0.5 (circular), but it must NOT drive the verdict
    assert abs(feats["intensity"].auc_vs_control - 0.5) > 0.3
    assert "control-defining" in feats["intensity"].note
    assert report.max_abs_separation() == pytest.approx(0.0)  # only flat remains
    assert "no pooled feature" in report.verdict.lower()


def test_single_source_share_reported():
    rows = []
    for i in range(20):
        in_win = 8 <= i < 13
        rows.append({
            "i": i,
            "intensity": (100.0 if i in (18, 19) else (10.0 if in_win else 5.0)),
            "source_count": 1,  # every in-window bucket single-source
        })
    report = feature_separation(_board(rows), _truth((8, 13)), features=("intensity", "source_count"))
    assert report.in_window_single_source_share == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Optional real-snapshot regression (skipped unless a snapshot is provided)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("NBA_RESEARCH_SNAPSHOT_PATH")
    or not Path(os.environ["NBA_RESEARCH_SNAPSHOT_PATH"]).is_dir(),
    reason="set NBA_RESEARCH_SNAPSHOT_PATH to an exported snapshot to run the real-data regression",
)
def test_real_snapshot_negative_result():
    snap = os.environ["NBA_RESEARCH_SNAPSHOT_PATH"]
    report = run_separation(snap)
    assert report.support == "ok"
    feats = _by_feature(report)
    # structural per-source features carry no positive separation on the real corpus
    for name in ("source_count", "source_dominance", "source_disagreement"):
        if name in feats and feats[name].auc_vs_control is not None:
            assert feats[name].auc_vs_control - 0.5 < 0.15, (
                f"{name} unexpectedly elevated in incidents: {feats[name].auc_vs_control}"
            )
    assert (report.max_positive_separation() or 0.0) < 0.2
