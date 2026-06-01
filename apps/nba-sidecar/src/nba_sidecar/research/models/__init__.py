"""BoardModel ABC, registry, and seeded models.

Importing this package imports each seeded model module for its
``@register`` side effect, so the registry is populated as soon as
``nba_sidecar.research.models`` is imported.
"""

from __future__ import annotations

from .base import (
    BoardModel,
    ScoreRequest,
    ScoreResult,
    get_model,
    list_models,
    register,
)

# Import for @register side effects (order is irrelevant; ids are unique).
from . import robust_mad as robust_mad  # noqa: E402,F401
from . import state_space_current as state_space_current  # noqa: E402,F401
from . import template_model as template_model  # noqa: E402,F401

__all__ = [
    "BoardModel",
    "ScoreRequest",
    "ScoreResult",
    "register",
    "get_model",
    "list_models",
]
