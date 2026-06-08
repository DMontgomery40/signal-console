"""Hermetic unit tests for the confluence kill-test pure math.

A bug here could fake the falsification verdict, so the core functions are
pinned with hand-computed expectations (no DB, no I/O).
"""

from __future__ import annotations

import math

import pytest

from nba_sidecar.research.experiments.confluence_killtest import (
    Params,
    binom_sf,
    confluence_by_window,
    control_block_maxima,
    detect_prop_anomalies,
    floor_win,
    mann_whitney_auc,
    parse_epoch,
    per_interval_volumes,
    percentile,
    peak_confluence,
    span_windows,
)


def test_parse_epoch_handles_z_and_variable_fraction():
    base = parse_epoch("2026-05-12T04:51:40Z")
    assert parse_epoch("2026-05-12T04:51:40.000Z") == pytest.approx(base, abs=1e-6)
    # fractional seconds of varying precision must parse and order correctly
    assert parse_epoch("2026-05-12T04:51:40.9Z") > base
    assert parse_epoch("2026-05-12T04:51:41Z") - base == pytest.approx(1.0, abs=1e-6)


def test_per_interval_volumes_cumulative_vs_level():
    # cumulative (monotonic non-decreasing) -> positive deltas, first is None
    assert per_interval_volumes([10.0, 20.0, 35.0]) == [None, 10.0, 15.0]
    # per-interval (non-monotonic) -> unchanged levels
    assert per_interval_volumes([5.0, 1.0, 8.0]) == [5.0, 1.0, 8.0]
    # Nones preserved
    assert per_interval_volumes([None, None]) == [None, None]


def test_detect_anomalies_flat_series_has_none():
    epochs = [0.0, 1, 2, 3, 4, 5]
    probs = [0.5] * 6
    vols = [5.0] * 6  # below vol_floor (10) -> no volume anomaly
    assert detect_prop_anomalies(epochs, probs, vols, Params()) == []


def test_detect_anomalies_flags_price_jump_after_stable_history():
    epochs = [0.0, 1, 2, 3, 4, 5]
    probs = [0.50, 0.50, 0.50, 0.50, 0.50, 0.70]  # +0.20 jump at i=5
    vols = [None] * 6
    assert detect_prop_anomalies(epochs, probs, vols, Params()) == [5.0]


def test_detect_anomalies_flags_volume_spike_after_history():
    epochs = [0.0, 1, 2, 3, 4, 5]
    probs = [0.5] * 6  # no price anomaly
    vols = [10.0, 10.0, 10.0, 10.0, 100.0, 10.0]  # 10x spike at i=4 vs trailing median 10
    assert detect_prop_anomalies(epochs, probs, vols, Params()) == [4.0]


def test_floor_win_and_span_windows():
    assert floor_win(10.0, 60) == 0
    assert floor_win(75.0, 60) == 60
    # event at t=100, half=60, window=60 -> windows covering [40,160] = {0,60,120}
    assert span_windows(100.0, 60, 60) == [0, 60, 120]


def test_confluence_counts_distinct_coincident_props():
    anoms = {"a": [10.0], "b": [20.0], "c": [30.0], "d": [70.0]}
    ticks = {"a": [10.0], "b": [20.0], "c": [30.0], "d": [70.0]}
    conf = confluence_by_window(anoms, ticks, 60)
    assert conf[0][0] == 3  # a,b,c co-occur in window 0
    assert conf[0][1] == 3  # all three active there
    assert conf[60][0] == 1  # d alone in window 60
    assert peak_confluence(conf, [0, 60]) == 3


def test_control_block_maxima_excludes_incident_blocks():
    grid = [0, 60, 120, 180, 240]
    conf = {0: (1, 1), 60: (3, 3), 180: (2, 2), 240: (1, 1)}  # 120 -> 0
    # k=2 sliding blocks; any block touching incident window 120 is dropped
    assert control_block_maxima(conf, grid, {120}, 2) == [3, 2]


def test_percentile_interpolates():
    assert percentile([1, 2, 3, 4], 90) == pytest.approx(3.7)
    assert percentile([5], 90) == 5.0
    assert math.isnan(percentile([], 90))


def test_binom_sf_known_values():
    assert binom_sf(0, 5, 0.1) == pytest.approx(1.0)
    assert binom_sf(2, 2, 0.5) == pytest.approx(0.25)
    assert binom_sf(3, 3, 0.5) == pytest.approx(0.125)
    assert binom_sf(1, 1, 0.3) == pytest.approx(0.3)
    assert binom_sf(4, 4, 0.1) == pytest.approx(0.0001)
    # 11/14 standouts under a 10% null is decisively significant
    assert binom_sf(11, 14, 0.1) < 1e-6


def test_mann_whitney_auc_anchors():
    assert mann_whitney_auc([3, 4, 5], [0, 1, 2]) == pytest.approx(1.0)
    assert mann_whitney_auc([1], [1]) == pytest.approx(0.5)
    assert mann_whitney_auc([2, 2], [1, 3]) == pytest.approx(0.5)
    assert math.isnan(mann_whitney_auc([], [1]))
