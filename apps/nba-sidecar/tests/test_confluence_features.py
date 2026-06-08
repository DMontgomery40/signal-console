"""Hermetic unit tests for the richer-feature window statistics (no DB, no I/O)."""

from __future__ import annotations

import pytest

from nba_sidecar.research.experiments.confluence_killtest import (
    Params,
    detect_prop_anomaly_magnitudes,
)
from nba_sidecar.research.experiments.confluence_features import (
    count_by_window,
    magnitude_by_window,
)


def test_magnitude_detector_scales_with_excess_and_matches_binary_trip_points():
    # flat history then a price jump: magnitude = |Δprob| / threshold, >= 1 at trip.
    epochs = [0.0, 1, 2, 3, 4, 5]
    probs = [0.50, 0.50, 0.50, 0.50, 0.50, 0.70]  # +0.20 jump; no-MAD floor is 0.04
    vols = [None] * 6
    evs = detect_prop_anomaly_magnitudes(epochs, probs, vols, Params())
    assert len(evs) == 1
    assert evs[0][0] == 5.0
    # 0.20 / max(price_floor=0.02, 3*1.4826*MAD). MAD of [0,0,0,0]=0 -> thr=price_floor 0.02
    assert evs[0][1] == pytest.approx(0.20 / 0.02, rel=1e-6)  # 10x its threshold


def test_magnitude_detector_silent_on_flat_series():
    epochs = [0.0, 1, 2, 3, 4, 5]
    assert detect_prop_anomaly_magnitudes(epochs, [0.5] * 6, [5.0] * 6, Params()) == []


def test_magnitude_by_window_sum_vs_max_over_distinct_props():
    # two props each anomalous in window 0; one prop has two ticks (take its MAX).
    mag_events = {
        "a": [(10.0, 3.0), (20.0, 5.0)],  # both in window 0 -> max 5.0 for prop a
        "b": [(30.0, 2.0)],  # window 0 -> 2.0
        "c": [(70.0, 4.0)],  # window 60
    }
    active = {0, 60}
    s = magnitude_by_window(mag_events, active, 60, "sum")
    assert s[0] == pytest.approx(5.0 + 2.0)  # prop a max (5) + prop b (2)
    assert s[60] == pytest.approx(4.0)
    m = magnitude_by_window(mag_events, active, 60, "max")
    assert m[0] == pytest.approx(5.0)  # largest single per-prop move
    assert m[60] == pytest.approx(4.0)


def test_magnitude_by_window_zero_for_active_window_without_anomaly():
    # active window with no anomaly must be present with value 0 (baseline grid parity).
    out = magnitude_by_window({"a": [(10.0, 3.0)]}, {0, 60, 120}, 60, "sum")
    assert out[0] == pytest.approx(3.0)
    assert out[60] == 0.0
    assert out[120] == 0.0


def test_count_by_window_extracts_anomaly_count():
    conf = {0: (3, 50), 60: (1, 40), 120: (0, 30)}
    assert count_by_window(conf) == {0: 3.0, 60: 1.0, 120: 0.0}
