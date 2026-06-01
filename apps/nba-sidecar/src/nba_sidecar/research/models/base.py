"""BoardModel ABC + registry for research detector candidates.

A :class:`BoardModel` consumes one game's causal bucket series and emits one
prediction row per input bucket. The contract is deliberately strict:

- **One row per bucket.** ``len(result.predictions) == len(request.series)``.
- **Causal.** When scoring bucket ``i`` a model may only look at buckets
  ``0..i`` of the series. (We cannot mechanically forbid a model from peeking,
  but the ABC documents it and the seeded models honor it; the evaluation phase
  will additionally re-run prefixes to detect leakage.)
- **Warmup-gated firing.** ``fired`` may only be True where the model considers
  itself warmed up. A model with no warm history must not fire.

Models are pure functions of (series, params): no I/O, no snapshot reads, no
SQLite. That is what lets the evaluation phase replay them deterministically.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar

from ..contracts import GameBucketSeries, PredictionRow


@dataclass(frozen=True, slots=True)
class ScoreRequest:
    """Input to :meth:`BoardModel.score`: one game's series + resolved params."""

    series: GameBucketSeries
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ScoreResult:
    """Output of :meth:`BoardModel.score`: one prediction row per input bucket."""

    model_id: str
    game_id: str
    predictions: list[PredictionRow]


class BoardModel(ABC):
    """Abstract base for a board-volatility / misattribution detector candidate.

    Subclasses set the four identity ClassVars and implement
    :meth:`default_params` and :meth:`score`.
    """

    #: stable machine identifier used in registry + prediction outputs
    id: ClassVar[str]
    #: human-readable name
    name: ClassVar[str]
    #: one-paragraph honest summary of what the model does and its known burden
    summary: ClassVar[str]
    #: model family ("robust-baseline", "state-space", "template", ...)
    family: ClassVar[str]
    #: references / provenance (papers, code paths, design notes)
    references: ClassVar[tuple[str, ...]] = ()

    @abstractmethod
    def default_params(self) -> dict[str, Any]:
        """Return the model's default parameter dict (JSON-serializable)."""

    @abstractmethod
    def score(self, request: ScoreRequest) -> ScoreResult:
        """Score one game's series, emitting one prediction row per bucket."""

    # -- shared helpers -----------------------------------------------------

    def resolve_params(self, overrides: dict[str, Any] | None) -> dict[str, Any]:
        """Merge caller overrides over :meth:`default_params` (shallow)."""
        params = dict(self.default_params())
        if overrides:
            params.update(overrides)
        return params

    def _validate_result(self, request: ScoreRequest, result: ScoreResult) -> ScoreResult:
        """Enforce the one-row-per-bucket contract before returning."""
        expected = len(request.series.buckets)
        got = len(result.predictions)
        if got != expected:
            raise ValueError(
                f"{self.id}: produced {got} predictions for {expected} buckets "
                f"(must be exactly one per bucket)"
            )
        return result


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, type[BoardModel]] = {}


def register(model_cls: type[BoardModel]) -> type[BoardModel]:
    """Class decorator: register a BoardModel subclass by its ``id``.

    Validates the identity ClassVars at registration so a malformed model fails
    at import rather than at score time. Duplicate ids are rejected.
    """
    for attr in ("id", "name", "summary", "family"):
        value = getattr(model_cls, attr, None)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(
                f"{model_cls.__name__}: ClassVar {attr!r} must be a non-empty string"
            )
    model_id = model_cls.id
    if model_id in _REGISTRY and _REGISTRY[model_id] is not model_cls:
        raise ValueError(f"duplicate model id {model_id!r}")
    _REGISTRY[model_id] = model_cls
    return model_cls


def get_model(model_id: str) -> BoardModel:
    """Instantiate a registered model by id."""
    if model_id not in _REGISTRY:
        raise KeyError(f"unknown model id {model_id!r}; known: {sorted(_REGISTRY)}")
    return _REGISTRY[model_id]()


def list_models() -> list[str]:
    """Return registered model ids, sorted."""
    return sorted(_REGISTRY)


__all__ = [
    "BoardModel",
    "ScoreRequest",
    "ScoreResult",
    "register",
    "get_model",
    "list_models",
]
