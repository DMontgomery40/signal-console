"""Behavior tests for the signed-paired attribution re-ranker math (pure, hermetic).

Pins the directed hypothesis + fail-closed abstention:
- miscredit shape (rightful up, credited down) -> high positive score, support ok
- correctly-credited shape (credited up, rightful flat) -> negative score
- credited leg illiquid (the common role-player case) -> rightful_only, not a miss
- both legs illiquid -> insufficient_support (score None), never a fabricated number
- declared window knob changes the output
"""

from __future__ import annotations

import pytest

from nba_sidecar.research.attribution import (
    AttributionParams,
    leg_drift,
    signed_paired_score,
)

T0 = 1_000_000.0  # arbitrary event epoch


def _flat(level: float, around: float = T0) -> list[tuple[float, float]]:
    # ticks spanning the baseline + response windows at a constant level
    return [(around - 100, level), (around - 40, level), (around + 200, level), (around + 280, level)]


def _step(pre_level: float, post_level: float, around: float = T0) -> list[tuple[float, float]]:
    return [
        (around - 100, pre_level),
        (around - 40, pre_level),
        (around + 200, post_level),
        (around + 280, post_level),
    ]


def test_miscredit_shape_scores_positive_with_full_support():
    credited = _step(0.60, 0.45)   # credited over falls (credit disbelieved/removed)
    rightful = _step(0.30, 0.55)   # rightful over rises (gets the credit)
    res = signed_paired_score(credited, rightful, T0)
    assert res.support == "ok"
    assert res.credited.drift == pytest.approx(-0.15)
    assert res.rightful.drift == pytest.approx(0.25)
    assert res.score == pytest.approx(0.40)  # rightful up + credited down, large positive


def test_correctly_credited_shape_scores_negative():
    credited = _step(0.30, 0.55)   # the credited player actually got it -> their over rises
    rightful = _flat(0.40)         # the "other" player flat
    res = signed_paired_score(credited, rightful, T0)
    assert res.support == "ok"
    assert res.score is not None and res.score < 0  # credited gained -> not a miscredit


def test_credited_illiquid_falls_back_to_rightful_only():
    res = signed_paired_score([], _step(0.30, 0.52), T0)
    assert res.support == "rightful_only"
    assert res.credited.abstain is True
    assert res.score == res.rightful.drift  # uses the observable leg's directed contribution


def test_rightful_illiquid_falls_back_to_credited_only():
    res = signed_paired_score(_step(0.60, 0.40), [], T0)
    assert res.support == "credited_only"
    assert res.rightful.abstain is True
    assert res.score == -res.credited.drift  # credited falling -> positive directed evidence


def test_both_illiquid_is_insufficient_support_not_a_number():
    res = signed_paired_score([], [], T0)
    assert res.support == "insufficient_support"
    assert res.score is None
    assert res.credited.abstain and res.rightful.abstain


def test_leg_abstains_below_min_ticks():
    # only one tick in the window -> below default min_ticks=2 -> abstain
    one = [(T0 + 10, 0.5)]
    assert leg_drift(one, T0, AttributionParams()).abstain is True


def test_window_knob_changes_output():
    # a late move lands inside a wider post window but outside the default one
    ticks = [(T0 - 100, 0.30), (T0 - 40, 0.30), (T0 + 500, 0.60), (T0 + 560, 0.60)]
    default = leg_drift(ticks, T0, AttributionParams())  # post window [180,300] -> no post ticks -> abstain
    wide = leg_drift(ticks, T0, AttributionParams(post_lo=400, post_hi=600))
    assert default.abstain is True
    assert wide.abstain is False and wide.drift == pytest.approx(0.30)
