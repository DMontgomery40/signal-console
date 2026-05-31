"""Test the `emit-models` CLI: it writes outputs/nba-quant-lab/models.json from
the registry in the shape the /research API (getResearchModels) parses, so the
Model lab surfaces the real models instead of the static fallback.

Front<->back contract: python registry -> models.json -> GET /v1/research/models
-> Model lab UI. This test pins the python half + the JSON shape the TS half reads
(`{models:[{id,label,description}]}`, see apps/api/src/services/research.ts).
"""

from __future__ import annotations

import json

from nba_sidecar.research.cli.main import build_parser
from nba_sidecar.research.models import list_models


def test_emit_models_writes_registry_in_api_shape(tmp_path):
    out = tmp_path / "models.json"
    args = build_parser().parse_args(["emit-models", "--out", str(out)])
    rc = args.func(args)
    assert rc == 0
    payload = json.loads(out.read_text())
    assert isinstance(payload, dict) and isinstance(payload["models"], list)
    ids = {m["id"] for m in payload["models"]}
    # every registered model is surfaced
    assert set(list_models()) == ids
    assert {"robust_mad", "state_space_current"} <= ids
    # every entry carries the fields getResearchModels reads
    for m in payload["models"]:
        assert isinstance(m["id"], str) and m["id"]
        assert isinstance(m["label"], str) and m["label"]
        assert isinstance(m["description"], str) and m["description"]


def test_emit_models_creates_parent_dirs(tmp_path):
    out = tmp_path / "nested" / "dir" / "models.json"
    args = build_parser().parse_args(["emit-models", "--out", str(out)])
    assert args.func(args) == 0
    assert out.exists()
