"""robust_mad: trailing-median + k*MAD threshold on board intensity.

This is the *incumbent* high-recall baseline. It is the simplest honest thing
that works: maintain a trailing window of board intensity, compute a robust
center (median) and a robust scale (MAD), and fire when the current bucket's
intensity clears ``center + kMad * scale``.

Honest caveats (this is NOT "the good model"):

- It thresholds raw intensity with no breadth normalization, no source-trust
  weighting, and no regime adaptation. A calm game with a structurally low MAD
  will fire on mild bumps; a wild game with a high MAD will under-fire.
- High recall comes paired with a high alert burden (many fired buckets). It is
  the baseline a smarter model has to *beat on burden at equal recall*, not a
  target to imitate.

It is here because it is the thing the production state-space model was built to
improve on, and because a transparent, easily-audited baseline keeps the
bake-off honest.
"""

from __future__ import annotations

from statistics import median
from typing import Any

from ..contracts import PredictionRow
from .base import BoardModel, ScoreRequest, ScoreResult, register

_MAD_SCALE = 1.4826  # makes MAD a consistent estimator of sigma for normal data


def _mad(values: list[float], center: float) -> float:
    if not values:
        return 0.0
    return median([abs(v - center) for v in values]) * _MAD_SCALE


@register
class RobustMadModel(BoardModel):
    id = "robust_mad"
    name = "Robust trailing MAD"
    summary = (
        "Incumbent high-recall, high-burden baseline. Fires when bucket intensity "
        "clears trailing-median + kMad*MAD over the last trailingBuckets buckets, "
        "after a warmup gate. Transparent and easy to audit, but no breadth or "
        "source-trust normalization, so it tends to over-fire on calm games and "
        "under-fire on structurally wild ones. A peer to beat on burden, not a target."
    )
    family = "robust-baseline"
    references = (
        "Hampel et al., robust statistics (median + MAD scale 1.4826).",
        "packages/detectors/src/board-mad (TS live MAD detector lineage).",
    )

    def default_params(self) -> dict[str, Any]:
        return {
            "k_mad": 3.0,  # K_MAD_LIVE from packages/detectors/src/board-mad/config.ts
            "trailing_buckets": 20,  # BOARD_MAD_TRAILING_BUCKETS_DEFAULT
            "warmup_buckets": 8,  # BOARD_MAD_WARMUP_BUCKETS_DEFAULT
            "mad_floor": 1e-9,  # BOARD_MAD_MAD_FLOOR
        }

    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        k_mad = float(params["k_mad"])
        trailing = int(params["trailing_buckets"])
        warmup = int(params["warmup_buckets"])
        mad_floor = float(params["mad_floor"])

        buckets = request.series.buckets
        intensities = [b.intensity for b in buckets]
        predictions: list[PredictionRow] = []

        for i, bucket in enumerate(buckets):
            # CAUSAL: trailing window is strictly buckets before i (0..i-1).
            window = intensities[max(0, i - trailing) : i]
            warmed = i >= warmup and len(window) >= warmup
            if window:
                center = median(window)
                scale = max(mad_floor, _mad(window, center))
            else:
                center = 0.0
                scale = mad_floor
            threshold = center + k_mad * scale
            # Score is a standardized exceedance: how many MADs above center.
            score = (bucket.intensity - center) / scale if scale > 0 else 0.0
            fired = bool(warmed and bucket.intensity >= threshold)
            predictions.append(
                PredictionRow(
                    game_id=request.series.game_id,
                    bucket_start=bucket.bucket_start,
                    score=score,
                    fired=fired,
                    diagnostics={
                        "center": center,
                        "mad": scale,
                        "threshold": threshold,
                        "warmed": float(warmed),
                    },
                )
            )

        return self._validate_result(
            request,
            ScoreResult(
                model_id=self.id,
                game_id=request.series.game_id,
                predictions=predictions,
            ),
        )


__all__ = ["RobustMadModel"]
