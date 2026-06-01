"""template_model: a minimal, copy-me example BoardModel.

Copy this file, rename the class and the four identity ClassVars, and replace
the body of :meth:`score`. The rules a real model must follow are inlined as
comments so you do not have to leave this file to get started.

This template intentionally does the dumbest possible causal thing: it fires
whenever the current bucket intensity is above the running mean of the buckets
seen so far, once past a warmup. It exists to demonstrate the *shape* of a
model, not to be useful — do not put it in a bake-off as if it were a candidate.
"""

from __future__ import annotations

from typing import Any

from ..contracts import PredictionRow
from .base import BoardModel, ScoreRequest, ScoreResult, register


# 1. Decorate the class with @register so it self-registers on import.
@register
class TemplateModel(BoardModel):
    # 2. Set all four identity ClassVars. register() rejects empty/missing ones.
    id = "template_model"
    name = "Template (copy me)"
    summary = (
        "Minimal example model. Fires when bucket intensity exceeds the running "
        "mean of prior buckets after a warmup. Not a real candidate; copy it to "
        "start a new model."
    )
    family = "template"
    references = ("Internal: research/models/template_model.py",)

    # 3. Declare JSON-serializable default params. Callers can override per-run.
    def default_params(self) -> dict[str, Any]:
        return {"warmup_buckets": 8}

    # 4. Implement score(): exactly one PredictionRow per input bucket, causal,
    #    and fired only where warmed up.
    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        warmup = int(params["warmup_buckets"])

        buckets = request.series.buckets
        predictions: list[PredictionRow] = []
        running_sum = 0.0

        for i, bucket in enumerate(buckets):
            # CAUSAL: mean is over buckets strictly before i. We add the current
            # bucket to the running sum only AFTER deciding, so bucket i never
            # sees its own value in its baseline.
            prior_mean = running_sum / i if i > 0 else 0.0
            warmed = i >= warmup
            score = bucket.intensity - prior_mean
            fired = bool(warmed and bucket.intensity > prior_mean)
            predictions.append(
                PredictionRow(
                    game_id=request.series.game_id,
                    bucket_start=bucket.bucket_start,
                    score=score,
                    fired=fired,
                    diagnostics={"prior_mean": prior_mean, "warmed": float(warmed)},
                )
            )
            running_sum += bucket.intensity

        # 5. Always return through _validate_result to enforce one-row-per-bucket.
        return self._validate_result(
            request,
            ScoreResult(
                model_id=self.id,
                game_id=request.series.game_id,
                predictions=predictions,
            ),
        )


__all__ = ["TemplateModel"]
