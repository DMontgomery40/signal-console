"""Cross-language bounds contract (audit fix F-001).

The TS Zod schema and these pydantic models are the two gatekeepers of the same
state-space tuning envelope, reached by different callers. They were previously
kept in lockstep by hand-discipline and a comment only — nothing failed if one
drifted. This test pins the REAL pydantic field bounds to
``packages/detectors/src/board-mad/state-space-bounds.json``; the TS side does
the same in ``state-space-bounds.contract.test.ts``. Change a bound in only one
place and one of the two contract tests goes red.
"""

from __future__ import annotations

import json
from pathlib import Path

import annotated_types as at
import pytest

from nba_sidecar.models import (
    VolatilityStateSpaceAnchorConfig,
    VolatilityStateSpaceBreadthConfig,
    VolatilityStateSpaceDynamicsConfig,
    VolatilityStateSpaceObservationModelConfig,
    VolatilityStateSpaceScaleConfig,
    VolatilityStateSpaceSourceTrustConfig,
    VolatilityStateSpaceTriggerConfig,
)

GROUP_MODELS = {
    "trigger": VolatilityStateSpaceTriggerConfig,
    "breadth": VolatilityStateSpaceBreadthConfig,
    "observationModel": VolatilityStateSpaceObservationModelConfig,
    "anchors": VolatilityStateSpaceAnchorConfig,
    "dynamics": VolatilityStateSpaceDynamicsConfig,
    "sourceTrust": VolatilityStateSpaceSourceTrustConfig,
    "scale": VolatilityStateSpaceScaleConfig,
}


def _bounds_path() -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "detectors"
        / "src"
        / "board-mad"
        / "state-space-bounds.json"
    )


def _load_contract() -> dict[str, dict]:
    raw = json.loads(_bounds_path().read_text())
    return {key: value for key, value in raw.items() if key != "_comment"}


def _extract_from_pydantic() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for group, model in GROUP_MODELS.items():
        for name, field in model.model_fields.items():
            ge = le = None
            for meta in field.metadata:
                if isinstance(meta, at.Ge):
                    ge = meta.ge
                elif isinstance(meta, at.Le):
                    le = meta.le
            assert ge is not None, f"{group}.{name} is missing a ge bound"
            assert le is not None, f"{group}.{name} is missing a le bound"
            entry: dict = {"min": ge, "max": le}
            if field.annotation is int:
                entry["int"] = True
            out[f"{group}.{name}"] = entry
    return out


def test_pydantic_bounds_match_shared_contract() -> None:
    in_monorepo = (Path(__file__).resolve().parents[3] / "packages").is_dir()
    if not _bounds_path().exists():
        # An isolated package checkout legitimately lacks the TS-side JSON, so
        # skipping is honest there. But inside the monorepo a missing/misresolved
        # path would silently STOP enforcing the cross-language contract (green by
        # skip) — that is the failure mode this test exists to prevent, so fail loud.
        assert not in_monorepo, (
            f"shared bounds JSON missing inside the monorepo: {_bounds_path()} — "
            "path resolution broke and the Zod<->pydantic bounds contract is no "
            "longer enforced."
        )
        pytest.skip("shared bounds JSON not present (isolated package checkout)")
    assert _extract_from_pydantic() == _load_contract()
