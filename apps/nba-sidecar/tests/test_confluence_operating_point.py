"""Hermetic unit tests for the operating-point pure math (no DB, no I/O).

These pin the deployable normalization (causal trailing z), the FP-unit
clustering, and the threshold-aggregation so the operating-point verdict can't
be faked by a bug.
"""

from __future__ import annotations

import math

import pytest

from nba_sidecar.research.experiments.confluence_operating_point import (
    OpParams,
    cluster_alerts,
    cluster_overlaps_any,
    evaluate_threshold,
    trailing_robust_z,
)


def test_trailing_z_is_causal_and_needs_history():
    op = OpParams(min_history=3, min_scale=1.0)
    # windows 0..5 with a spike at win=5; only windows with >=3 trailing are scored
    counts = {0: 1, 60: 1, 120: 1, 180: 1, 240: 1, 300: 9}
    z = trailing_robust_z(counts, op)
    # windows 0,60,120 have <3 trailing -> unscorable
    assert 0 not in z and 60 not in z and 120 not in z
    # window 180 has trailing [1,1,1]: median 1, mad 0 -> denom=min_scale=1 -> z=0
    assert z[180] == pytest.approx(0.0)
    # the spike at 300 has trailing [1,1,1,1,1] -> (9-1)/1 = 8
    assert z[300] == pytest.approx(8.0)


def test_trailing_z_uses_mad_scale_when_dispersed():
    op = OpParams(min_history=3, min_scale=1.0)
    counts = {0: 2, 60: 4, 120: 6, 180: 20}
    z = trailing_robust_z(counts, op)
    # trailing for 180 = [2,4,6]: median 4, mad=median(|2-4|,|0|,|2|)=2 -> denom=1.4826*2
    assert z[180] == pytest.approx((20 - 4) / (1.4826 * 2.0), abs=1e-6)


def test_cluster_alerts_merges_within_gap():
    # gap merge of 1 window (<=120s apart merges) at window_sec=60
    assert cluster_alerts([0, 60, 120], 60, 1) == [(0, 120)]
    # a 3-window gap splits into two alerts
    assert cluster_alerts([0, 60, 300, 360], 60, 1) == [(0, 60), (300, 360)]
    assert cluster_alerts([], 60, 1) == []
    assert cluster_alerts([480], 60, 1) == [(480, 480)]


def test_cluster_overlaps_any():
    assert cluster_overlaps_any((0, 120), {60}, 60) is True
    assert cluster_overlaps_any((0, 120), {300}, 60) is False
    # incident window equal to an endpoint counts as overlap
    assert cluster_overlaps_any((0, 120), {120}, 60) is True


def test_evaluate_threshold_counts_recall_and_fp_ratio():
    op = OpParams(merge_gap=1, n_incidents_denom=2)
    # game A: incident at win 120 (span {60,120,180}); a flagged cluster there (TP)
    #         plus a separate flagged cluster far away (FP)
    games = [
        {
            "game_id": "g",
            "z_by_win": {120: 9.0, 600: 9.0},  # one near incident, one false alarm
            "incident_spans": {"incA": {60, 120, 180}, "incB": {9000}},  # incB never flagged
        }
    ]
    res = evaluate_threshold(games, thr=5.0, window_sec=60, op=op)
    assert res["caught"] == 1  # incA caught, incB missed
    assert res["tp_alerts"] == 1  # the cluster at 120
    assert res["fp_alerts"] == 1  # the cluster at 600
    assert res["fp_ratio"] == pytest.approx(1.0)  # 1 fp / 1 catch
    assert res["recall_over_denom"] == pytest.approx(0.5)


def test_evaluate_threshold_infinite_ratio_when_nothing_caught():
    op = OpParams(n_incidents_denom=1)
    games = [{"game_id": "g", "z_by_win": {600: 9.0}, "incident_spans": {"i": {0}}}]
    res = evaluate_threshold(games, thr=5.0, window_sec=60, op=op)
    assert res["caught"] == 0
    assert res["fp_alerts"] == 1
    assert res["fp_ratio"] is None  # inf -> serialized as None
