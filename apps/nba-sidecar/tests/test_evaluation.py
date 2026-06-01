"""Evaluation-layer tests: scorer correctness, no-recompute property, bridges.

These build a TINY fixture snapshot (tmp_path) with PRE-MATERIALIZED truth so we
can assert the load-bearing contract: the evaluator scores by JOINING fired
buckets to ``score_windows`` / ``market_outlier_episodes`` and does NOT recompute
scoreability or episodes from ``board_observations``.

The strongest discriminating evidence for "no recompute":

1. ``test_scorer_ignores_board_observations_entirely`` -- scramble the fixture's
   ``board_observations.intensity`` to garbage and assert every metric is
   byte-identical. A scorer that rederived truth from the tape could not be
   invariant to that.
2. ``test_negative_space_window_is_caught`` -- place a score_window where the raw
   tape shows nothing and fire there; assert caught. A recompute would never
   manufacture that window, so a pass proves the scorer JOINED to materialized
   truth instead of deriving it.

Plus: a hand-built metric-correctness case with exact integer counts, and the
external predictions.parquet bridge scored end-to-end identically to a native
frame.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import pytest

from nba_sidecar.research.contracts import PREDICTION_COLUMNS, validate_dataframe
from nba_sidecar.research.evaluation.evaluator import evaluate_external
from nba_sidecar.research.evaluation.predictions import load_external_predictions
from nba_sidecar.research.evaluation.scorer import score_predictions
from nba_sidecar.research.evaluation.truth import load_truth

# ---------------------------------------------------------------------------
# Tiny fixture snapshot with pre-materialized truth
# ---------------------------------------------------------------------------

# Two games, 1-minute buckets. We pick unix-second anchors and ISO strings that
# agree, so the hand-built expectations are exact.
#   G1: window [t0+120, t0+180]; one tape episode [t0+300, t0+360].
#   G2: no scoreable incident; one tape episode [u0+60, u0+120].
_T0 = 1_700_000_000  # game 1 epoch
_U0 = 1_700_100_000  # game 2 epoch


def _iso(sec: int) -> str:
    return datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _board_rows(game_id: str, base: int, n: int) -> list[dict]:
    rows = []
    for i in range(n):
        s = base + i * 60
        rows.append(
            {
                "game_id": game_id,
                "bucket_start": _iso(s),
                "bucket_end": _iso(s + 60),
                "game_elapsed_seconds": float(i * 60),
                "intensity": 1.0,  # deliberately flat; truth must NOT come from here
                "active_market_count": 2,
                "source_count": 2,
                "source_dominance": 0.5,
                "source_disagreement": 0.1,
            }
        )
    return rows


@pytest.fixture()
def fixture_snapshot(tmp_path):
    snap = tmp_path / "tiny-snapshot"
    snap.mkdir()

    board = pd.DataFrame(_board_rows("G1", _T0, 10) + _board_rows("G2", _U0, 8))
    board.to_parquet(snap / "board_observations.parquet", index=False)

    incidents = pd.DataFrame(
        [
            {
                "incident_id": "inc_scoreable",
                "canonical_game_id": "G1",
                "has_local_window": True,
                "scoreable": True,
                "confidence": "high",
                "anchor_type": "second",
                "utc_time": _iso(_T0 + 150),
                "event_sec": _T0 + 150,
                "stat": "rebound",
                "credited_player": "A",
                "rightful_player": "B",
                "official_correction": False,
            },
            {
                "incident_id": "inc_not_scoreable",
                "canonical_game_id": None,
                "has_local_window": False,
                "scoreable": False,
                "confidence": None,
                "anchor_type": None,
                "utc_time": None,
                "event_sec": None,
                "stat": None,
                "credited_player": None,
                "rightful_player": None,
                "official_correction": None,
            },
        ]
    )
    incidents.to_parquet(snap / "incidents.parquet", index=False)

    # score_windows: one for the scoreable incident. NOTE the window sits where
    # the tape is flat (intensity==1.0 everywhere) -- a recompute could never
    # invent it; only a JOIN to this materialized row can score it.
    score_windows = pd.DataFrame(
        [
            {
                "incident_id": "inc_scoreable",
                "game_id": "G1",
                "window_start": _iso(_T0 + 120),
                "window_end": _iso(_T0 + 180),
                "window_start_sec": _T0 + 120,
                "window_end_sec": _T0 + 180,
            }
        ]
    )
    score_windows.to_parquet(snap / "score_windows.parquet", index=False)

    episodes = pd.DataFrame(
        [
            {
                "episode_id": "G1:moe:0",
                "game_id": "G1",
                "start_sec": _T0 + 300,
                "end_sec": _T0 + 360,
                "bucket_seconds": 60,
                "bucket_count": 1,
                "peak_severity": 5.0,
                "peak_price_move_z": 4.0,
                "diagnosis": "price move outlier",
            },
            {
                "episode_id": "G2:moe:0",
                "game_id": "G2",
                "start_sec": _U0 + 60,
                "end_sec": _U0 + 120,
                "bucket_seconds": 60,
                "bucket_count": 1,
                "peak_severity": 6.0,
                "peak_price_move_z": 5.0,
                "diagnosis": "extreme price move",
            },
        ]
    )
    episodes.to_parquet(snap / "market_outlier_episodes.parquet", index=False)

    coverage = pd.DataFrame(
        [
            {
                "game_id": "G1",
                "source": "polymarket",
                "market_family": "moneyline",
                "window": "full-game",
                "class": "canonical",
                "market_count": 2,
                "tick_count": 100,
                "eligible": True,
            },
            {
                "game_id": "G2",
                "source": "kalshi",
                "market_family": "moneyline",
                "window": "full-game",
                "class": "artifact_only",  # data-absence game
                "market_count": 0,
                "tick_count": 0,
                "eligible": False,
            },
        ]
    )
    coverage.to_parquet(snap / "source_coverage.parquet", index=False)

    return snap


def _predictions(fired_specs: list[tuple[str, int, bool]]) -> pd.DataFrame:
    """fired_specs: (game_id, bucket_start_sec, fired)."""
    rows = []
    for gid, sec, fired in fired_specs:
        rows.append(
            {
                "game_id": gid,
                "bucket_start": _iso(sec),
                "bucket_end": _iso(sec + 60),
                "score": 9.0 if fired else 0.0,
                "fired": fired,
            }
        )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Hand-built metric correctness
# ---------------------------------------------------------------------------


def test_handbuilt_metric_correctness(fixture_snapshot):
    truth = load_truth(fixture_snapshot)
    # Fire inside G1's window (catches incident) AND inside G1's episode (catches
    # one tape outlier). Do NOT fire in G2 (its episode stays uncaught).
    preds = _predictions(
        [
            ("G1", _T0 + 120, True),  # in window [120,180] -> incident caught
            ("G1", _T0 + 300, True),  # in episode [300,360] -> tape caught
            ("G1", _T0 + 0, True),    # pure false positive (no window/episode)
            ("G2", _U0 + 0, False),
        ]
    )
    b = score_predictions(preds, truth, model_id="hand")

    assert b.incidents_total == 1  # only the scoreable incident
    assert b.incidents_caught == 1
    assert b.incident_recall == pytest.approx(1.0)
    assert b.episodes_total == 2  # G1 + G2 episodes
    assert b.episodes_caught == 1  # only G1's episode saw a fire
    assert b.tape_outlier_recall == pytest.approx(0.5)
    assert b.total_fires == 3
    # fires/game = mean over evaluated games (G1, G2 both truth-bearing) = 3/2
    assert b.fires_per_game == pytest.approx(1.5)
    # per-game outlier burden = total fires / episodes = 3/2
    assert b.per_game_outlier_burden == pytest.approx(1.5)


def test_window_overlap_is_inclusive_of_boundary(fixture_snapshot):
    truth = load_truth(fixture_snapshot)
    # A bucket ending exactly at window_start does NOT overlap (half-open start);
    # a bucket starting inside the window does.
    just_before = _predictions([("G1", _T0 + 60, True)])  # [60,120): touches 120 at end -> no
    b1 = score_predictions(just_before, truth, model_id="b1")
    assert b1.incidents_caught == 0
    inside = _predictions([("G1", _T0 + 150, True)])  # [150,210) overlaps [120,180]
    b2 = score_predictions(inside, truth, model_id="b2")
    assert b2.incidents_caught == 1


# ---------------------------------------------------------------------------
# No-recompute property (the load-bearing assertion)
# ---------------------------------------------------------------------------


def test_scorer_ignores_board_observations_entirely(fixture_snapshot):
    """Scramble board_observations.intensity to garbage; metrics must not move.

    The scorer joins to pre-materialized truth and never reads the raw tape, so
    corrupting the tape cannot change a single metric. A scorer that recomputed
    scoreability/episodes from intensity WOULD change here.
    """
    truth = load_truth(fixture_snapshot)
    preds = _predictions(
        [("G1", _T0 + 120, True), ("G1", _T0 + 300, True), ("G2", _U0 + 0, True)]
    )
    before = score_predictions(preds, truth, model_id="m").summary_dict()

    # Corrupt the recompute path: replace intensity with absurd noise and rewrite.
    board_path = fixture_snapshot / "board_observations.parquet"
    board = pd.read_parquet(board_path)
    board["intensity"] = 1e9  # garbage; would explode any robust-z recompute
    board.to_parquet(board_path, index=False)

    truth2 = load_truth(fixture_snapshot)  # truth tables are unchanged
    after = score_predictions(preds, truth2, model_id="m").summary_dict()
    assert before == after


def test_truth_object_has_no_board_observations_handle(fixture_snapshot):
    """Structural guard: SnapshotTruth carries no board_observations attribute."""
    truth = load_truth(fixture_snapshot)
    assert not hasattr(truth, "board_observations")
    # only the four label tables are present
    assert {"incidents", "score_windows", "market_outlier_episodes", "source_coverage"}.issubset(
        set(vars(truth).keys())
    )


def test_negative_space_window_is_caught(fixture_snapshot):
    """A window over flat tape is still caught if a fire lands in it.

    The fixture's tape is intensity==1.0 everywhere, so no anomaly detector could
    derive a window at [T0+120, T0+180]. Catching it proves the scorer JOINED to
    the materialized score_windows row rather than rederiving truth.
    """
    truth = load_truth(fixture_snapshot)
    preds = _predictions([("G1", _T0 + 120, True)])
    b = score_predictions(preds, truth, model_id="m")
    assert b.incidents_caught == 1


# ---------------------------------------------------------------------------
# External predictions.parquet bridge -- scored identically to a native frame
# ---------------------------------------------------------------------------


def test_external_predictions_parquet_scores_end_to_end(fixture_snapshot, tmp_path):
    truth = load_truth(fixture_snapshot)
    preds = _predictions(
        [("G1", _T0 + 120, True), ("G1", _T0 + 300, True), ("G1", _T0 + 0, True)]
    )
    # native scoring (in-memory frame)
    native = score_predictions(preds, truth, model_id="native").summary_dict()

    # write an EXTERNAL parquet (only the 4 contract columns + bucket_end) and
    # score it through the external path; metrics must match the native frame.
    ext_path = tmp_path / "predictions.parquet"
    preds.to_parquet(ext_path, index=False)
    loaded = load_external_predictions(ext_path)
    validate_dataframe(loaded, PREDICTION_COLUMNS)  # bridge validates same spec

    bundle, casebook, _ = evaluate_external(ext_path, fixture_snapshot, model_id="native")
    external = bundle.summary_dict()
    # identical except model_id label
    native.pop("model_id"), external.pop("model_id")
    assert native == external

    # casebook annotates a data-absence vs model verdict via source_coverage
    assert casebook.model_id == "native"


def test_external_predictions_rejects_missing_column(fixture_snapshot, tmp_path):
    bad = pd.DataFrame({"game_id": ["G1"], "score": [1.0], "fired": [True]})
    bad_path = tmp_path / "bad.parquet"
    bad.to_parquet(bad_path, index=False)
    with pytest.raises(ValueError, match="missing required columns"):
        load_external_predictions(bad_path)


def test_external_without_threshold_yields_null_residual_coverage(fixture_snapshot, tmp_path):
    """A producer that omits threshold/intensity gets residual_coverage=None."""
    truth = load_truth(fixture_snapshot)
    preds = _predictions([("G1", _T0 + 120, True)])  # 4-col only, no threshold
    b = score_predictions(preds, truth, model_id="m")
    assert b.residual_coverage is None
    assert b.has_threshold_diagnostics is False


# ---------------------------------------------------------------------------
# Artifact writer + CLI glue (run-model, score-predictions, compare, report)
# ---------------------------------------------------------------------------


def test_run_model_writes_all_seven_artifacts(fixture_snapshot, tmp_path):
    """run-model on a real registered model emits every required artifact,
    including a combined predictions.parquet."""
    from nba_sidecar.research.cli.main import main as cli_main

    # use the real sample-fixed snapshot path via fixture? No -- use the tiny
    # fixture with a registered model. robust_mad is causal and warmup-gated; on
    # a flat tape it simply won't fire, which is fine for the artifact contract.
    runs_root = tmp_path / "runs"
    rc = cli_main(
        [
            "run-model",
            "robust_mad",
            str(fixture_snapshot),
            "--run-id",
            "t-run",
            "--runs-root",
            str(runs_root),
        ]
    )
    assert rc == 0
    run_dir = runs_root / "t-run"
    for name in (
        "predictions.parquet",
        "predictions-robust_mad.parquet",
        "metrics.json",
        "leaderboard.json",
        "casebook.json",
        "REPORT.md",
        "report.html",
        "run-manifest.json",
    ):
        assert (run_dir / name).exists(), f"missing artifact {name}"
    # combined predictions.parquet carries a model_id column
    combined = pd.read_parquet(run_dir / "predictions.parquet")
    assert "model_id" in combined.columns
    assert set(combined["model_id"].unique()) == {"robust_mad"}


def test_compare_writes_combined_predictions_with_model_id(fixture_snapshot, tmp_path):
    from nba_sidecar.research.cli.main import main as cli_main

    runs_root = tmp_path / "runs"
    rc = cli_main(
        [
            "compare",
            "robust_mad",
            "template_model",
            "--snapshot",
            str(fixture_snapshot),
            "--run-id",
            "t-cmp",
            "--runs-root",
            str(runs_root),
        ]
    )
    assert rc == 0
    run_dir = runs_root / "t-cmp"
    assert (run_dir / "predictions.parquet").exists()
    combined = pd.read_parquet(run_dir / "predictions.parquet")
    assert set(combined["model_id"].unique()) == {"robust_mad", "template_model"}


def test_report_subcommand_is_nondestructive(fixture_snapshot, tmp_path):
    """`report` must rebuild the FULL report (incl. casebook), not shrink it."""
    from nba_sidecar.research.cli.main import main as cli_main

    runs_root = tmp_path / "runs"
    cli_main(
        [
            "compare",
            "robust_mad",
            "template_model",
            "--snapshot",
            str(fixture_snapshot),
            "--run-id",
            "t-rep",
            "--runs-root",
            str(runs_root),
        ]
    )
    run_dir = runs_root / "t-rep"
    before = (run_dir / "REPORT.md").read_text()
    assert "## Casebook" in before
    rc = cli_main(["report", str(run_dir)])
    assert rc == 0
    after = (run_dir / "REPORT.md").read_text()
    # casebook section survives the re-render (non-destructive)
    assert "## Casebook" in after
    assert "## Leaderboard" in after


def test_doctor_flags_scoreable_without_window(fixture_snapshot):
    """doctor returns ok=False when a scoreable incident lacks a score_window."""
    from nba_sidecar.research.evaluation.doctor import run_doctor

    # break the fixture: drop the only score_window, keep the scoreable incident
    sw = pd.read_parquet(fixture_snapshot / "score_windows.parquet").iloc[0:0]
    sw.to_parquet(fixture_snapshot / "score_windows.parquet", index=False)
    result = run_doctor(fixture_snapshot)
    assert result["ok"] is False
    assert result["scoreability"]["scoreable_without_window"] == ["inc_scoreable"]
