"""Unit tests for the research package (registry, models, loader, contracts).

These run against a real exported snapshot pointed to by the
``NBA_RESEARCH_SNAPSHOT_PATH`` env var (the repo's hermetic-snapshot convention,
see test_separation.py) so the models are exercised on real board observations,
not synthetic toys. The snapshot is a gitignored generated artifact, so when the
env var is unset/absent the module SKIPS rather than erroring on a dead path
(it formerly hardcoded a /signal-console-quant-lab/.../sample-fixed sibling
worktree path — review P1). To keep them fast we slice to a couple of small games.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

from nba_sidecar.research.contracts import (
    PREDICTION_COLUMNS,
    GameBucketSeries,
    ModelInputBucket,
    PredictionRow,
    validate_dataframe,
)
from nba_sidecar.research.loader import build_game_series, load_game_series
from nba_sidecar.research.models import get_model, list_models
from nba_sidecar.research.models.base import ScoreRequest

SNAPSHOT = Path(os.environ.get("NBA_RESEARCH_SNAPSHOT_PATH", ""))

# The model/loader fixtures below need a real exported snapshot. It is a gitignored
# artifact, so skip the whole module (rather than error) when the env var is not set
# to an existing snapshot dir — matching test_separation.py's hermetic convention.
pytestmark = pytest.mark.skipif(
    not os.environ.get("NBA_RESEARCH_SNAPSHOT_PATH") or not SNAPSHOT.is_dir(),
    reason="set NBA_RESEARCH_SNAPSHOT_PATH to an exported snapshot to run the research model suite",
)

# Small games (by bucket count) keep the suite fast while still real.
SMALL_GAMES = ("nba-0022500547", "nba-0042500224")
CAUSAL_MODELS = ("robust_mad", "state_space_current", "virtual_source_state_space")


@pytest.fixture(scope="module")
def all_series() -> dict[str, GameBucketSeries]:
    return load_game_series(SNAPSHOT)


@pytest.fixture(scope="module")
def small_series(all_series) -> dict[str, GameBucketSeries]:
    return {gid: all_series[gid] for gid in SMALL_GAMES}


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_seeded_models_self_register():
    ids = list_models()
    for expected in (
        "robust_mad",
        "state_space_current",
        "template_model",
        "virtual_source_state_space",
    ):
        assert expected in ids, f"{expected} did not self-register; got {ids}"


def test_registered_models_validate_identity():
    for model_id in list_models():
        model = get_model(model_id)
        assert isinstance(model.id, str) and model.id == model_id
        assert model.name.strip()
        assert model.summary.strip()
        assert model.family.strip()
        # default_params must be a JSON-ish dict
        assert isinstance(model.default_params(), dict)


def test_unknown_model_raises():
    with pytest.raises(KeyError):
        get_model("does_not_exist")


# ---------------------------------------------------------------------------
# Loader + contracts
# ---------------------------------------------------------------------------


def test_loader_builds_ordered_causal_series(small_series):
    for gid, series in small_series.items():
        assert series.game_id == gid
        assert len(series) > 0
        # indices contiguous from 0, bucket_start ascending (enforced by schema,
        # asserted again here for an explicit failure message)
        starts = [b.bucket_start for b in series.buckets]
        assert [b.index for b in series.buckets] == list(range(len(series)))
        assert starts == sorted(starts)


def test_duckdb_backend_matches_pandas():
    pandas_series = load_game_series(SNAPSHOT, backend="pandas")
    duck_series = load_game_series(SNAPSHOT, backend="duckdb")
    assert set(pandas_series) == set(duck_series)
    gid = SMALL_GAMES[0]
    assert len(pandas_series[gid]) == len(duck_series[gid])


def test_prediction_column_spec_validates_roundtrip(small_series):
    import pandas as pd

    model = get_model("robust_mad")
    series = small_series[SMALL_GAMES[0]]
    result = model.score(ScoreRequest(series=series))
    df = pd.DataFrame(
        {
            "game_id": [p.game_id for p in result.predictions],
            "bucket_start": [p.bucket_start.isoformat() for p in result.predictions],
            "score": [p.score for p in result.predictions],
            "fired": [p.fired for p in result.predictions],
        }
    )
    # External-producer parity: validate the parquet-shaped frame against the
    # same column spec an R/notebook output would be checked against.
    validate_dataframe(df, PREDICTION_COLUMNS)


def test_prediction_column_spec_rejects_missing_column():
    import pandas as pd

    bad = pd.DataFrame({"game_id": ["g"], "score": [1.0], "fired": [True]})
    with pytest.raises(ValueError, match="missing required columns"):
        validate_dataframe(bad, PREDICTION_COLUMNS)


def test_game_series_rejects_out_of_order_index():
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    later = datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="out of order"):
        GameBucketSeries(
            game_id="g",
            buckets=[
                ModelInputBucket(index=1, bucket_start=now, bucket_end=later, intensity=0.0),
            ],
        )


# ---------------------------------------------------------------------------
# Causal one-row-per-bucket behavior for the two real models
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model_id", CAUSAL_MODELS)
def test_model_one_prediction_per_bucket(model_id, small_series):
    model = get_model(model_id)
    for gid, series in small_series.items():
        result = model.score(ScoreRequest(series=series))
        assert result.model_id == model_id
        assert result.game_id == gid
        assert len(result.predictions) == len(series.buckets)
        # bucket_start alignment, exactly one per input bucket, in order
        for pred, bucket in zip(result.predictions, series.buckets, strict=True):
            assert pred.bucket_start == bucket.bucket_start
            assert isinstance(pred.score, float)
            assert isinstance(pred.fired, bool)


@pytest.mark.parametrize("model_id", CAUSAL_MODELS)
def test_model_no_fire_before_warmup(model_id, small_series):
    """A model may only fire where it considers itself warmed up.

    We assert against each model's own ``warmed`` diagnostic rather than an
    index-based assumption, because the two models warm on different clocks:
    robust_mad warms on bucket index, state_space_current warms on game-clock
    elapsed seconds. Testing the actual ``warmed`` flag exercises the real
    warmup contract for both.
    """
    model = get_model(model_id)
    for series in small_series.values():
        result = model.score(ScoreRequest(series=series))
        for i, pred in enumerate(result.predictions):
            warmed = pred.diagnostics.get("warmed", 1.0) == 1.0
            if not warmed:
                assert pred.fired is False, (
                    f"{model_id} fired at bucket {i} while not warmed"
                )


@pytest.mark.parametrize("model_id", CAUSAL_MODELS)
def test_model_is_causal_prefix_stable(model_id, small_series):
    """A causal model's prediction for bucket i must not change if buckets after
    i are removed. We re-run on the prefix 0..i and compare the last fire/score.
    """
    model = get_model(model_id)
    series = small_series[SMALL_GAMES[1]]
    full = model.score(ScoreRequest(series=series))
    # Check a handful of cut points (cheap but real causality evidence).
    for cut in (10, 20, len(series) - 1):
        if cut <= 0 or cut >= len(series):
            continue
        prefix = GameBucketSeries(
            game_id=series.game_id, buckets=series.buckets[: cut + 1]
        )
        prefix_result = model.score(ScoreRequest(series=prefix))
        assert prefix_result.predictions[cut].fired == full.predictions[cut].fired
        assert prefix_result.predictions[cut].score == pytest.approx(
            full.predictions[cut].score
        )


def test_template_validates_and_scores(small_series):
    model = get_model("template_model")
    series = small_series[SMALL_GAMES[0]]
    result = model.score(ScoreRequest(series=series))
    assert len(result.predictions) == len(series.buckets)
    assert all(isinstance(p, PredictionRow) for p in result.predictions)
    # warmup gate respected
    for i, pred in enumerate(result.predictions):
        if i < int(model.default_params()["warmup_buckets"]):
            assert pred.fired is False
