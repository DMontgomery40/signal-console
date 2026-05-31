"""Signed-paired attribution re-ranker — the core scoring math.

This is the precision-lift stage that re-ranks the confusability prior's candidate
stream (see docs/research-2026-05-31c-literature-scratchpad.md, Approach A). It is a
PURE function of prop-tick series + an event time; it does NOT read the DB or a
snapshot (the data source is wired separately), which keeps it hermetically testable
and reusable for both offline eval and a live path.

The directed hypothesis a *miscredit* produces (and idiosyncratic noise does not):
around the play, the **rightful** player's over-prop drifts UP (they receive the
credit, often at correction) while the **credited** player's over-prop drifts DOWN
(the market disbelieves / the credit is removed). The paired score is
``rightful_drift - credited_drift``; large positive = consistent with a miscredit. A
correctly-credited rebound shows the opposite (credited up, rightful flat -> score < 0).

Crucially this is NOT the generic cross-source/volume magnitude signal already
falsified at board level — it is *directed* and *paired* and *anchored to the two
named players*. Each leg is z-free here (raw net drift); calibration of a fire
threshold (SPRT) against the control corpus is a separate policy layer.

FAIL-CLOSED: the wrongly-credited player is often an illiquid role player, so the
credited leg frequently has no ticks. A leg with < ``min_ticks`` in the window, or no
pre/post coverage, ABSTAINS. If both legs abstain the score is None
(``insufficient_support``) — never a fabricated number. If only one leg is observable
the score uses that leg's directed contribution and the support flag says so.
"""

from __future__ import annotations

from dataclasses import dataclass

# (epoch_seconds, implied_probability) sorted ascending is NOT required; we filter by window.
Tick = tuple[float, float]


@dataclass(frozen=True)
class AttributionParams:
    """Declared, overridable knobs for the signed-paired score (all seconds)."""

    pre_lo: float = 120.0   # baseline window starts event - pre_lo
    pre_hi: float = 30.0    # baseline window ends   event - pre_hi
    post_lo: float = 180.0  # response window starts event + post_lo
    post_hi: float = 300.0  # response window ends   event + post_hi
    min_ticks: int = 2      # min ticks in [event-pre_lo, event+post_hi] for a leg to score


@dataclass(frozen=True)
class LegResult:
    drift: float | None   # median(post) - median(pre); None when abstaining
    n_ticks: int          # ticks in the full [pre_lo, post_hi] window
    abstain: bool


@dataclass(frozen=True)
class PairedScore:
    credited: LegResult
    rightful: LegResult
    score: float | None   # directed-paired score; None iff both legs abstain
    support: str          # "ok" | "rightful_only" | "credited_only" | "insufficient_support"
    reason: str


def _median(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def leg_drift(ticks: list[Tick], event_epoch: float, params: AttributionParams) -> LegResult:
    """Net signed drift of one leg: median(response window) - median(baseline window).

    Abstains (drift=None) when either window is empty or the leg has < min_ticks in
    the full window — the honest 'no signal' state, distinct from 'no anomaly'.
    """
    pre = [p for (e, p) in ticks if event_epoch - params.pre_lo <= e <= event_epoch - params.pre_hi]
    post = [p for (e, p) in ticks if event_epoch + params.post_lo <= e <= event_epoch + params.post_hi]
    in_win = [p for (e, p) in ticks if event_epoch - params.pre_lo <= e <= event_epoch + params.post_hi]
    if len(in_win) < params.min_ticks or not pre or not post:
        return LegResult(drift=None, n_ticks=len(in_win), abstain=True)
    return LegResult(drift=_median(post) - _median(pre), n_ticks=len(in_win), abstain=False)


def signed_paired_score(
    credited_ticks: list[Tick],
    rightful_ticks: list[Tick],
    event_epoch: float,
    params: AttributionParams | None = None,
) -> PairedScore:
    """Directed-paired re-ranker score for one candidate (credited, rightful) pair.

    score = rightful_drift - credited_drift  (both observed)
          = rightful_drift                   (credited leg illiquid -> rightful-only)
          = -credited_drift                  (rightful leg illiquid -> credited-only)
          = None                             (both illiquid -> insufficient_support)
    Higher = more consistent with a miscredit (rightful gains, credited loses).
    """
    p = params or AttributionParams()
    c = leg_drift(credited_ticks, event_epoch, p)
    r = leg_drift(rightful_ticks, event_epoch, p)
    return paired_from_legs(c, r)


def paired_from_legs(credited: LegResult, rightful: LegResult) -> PairedScore:
    """Combine two pre-computed legs into the directed-paired score + support flag.

    Separated from signed_paired_score so callers that compute legs differently
    (e.g. per-(source,line) drift then aggregate) reuse the SAME abstention logic.
    """
    c, r = credited, rightful
    if c.abstain and r.abstain:
        return PairedScore(c, r, None, "insufficient_support", "no ticks on either leg")
    if c.abstain:
        return PairedScore(c, r, r.drift, "rightful_only", "credited leg illiquid; rightful-leg only")
    if r.abstain:
        return PairedScore(c, r, -(c.drift or 0.0), "credited_only", "rightful leg illiquid; credited-leg only")
    return PairedScore(c, r, (r.drift or 0.0) - (c.drift or 0.0), "ok", "both legs observed")


__all__ = [
    "Tick",
    "AttributionParams",
    "LegResult",
    "PairedScore",
    "leg_drift",
    "signed_paired_score",
    "paired_from_legs",
]
