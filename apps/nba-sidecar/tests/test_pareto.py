"""Tests for evaluation/pareto.py — Pareto-front dominance analysis.

Coverage intent from docs/moniac-pipeline-plan-and-code-draft.md Phase 2 Step 2.
(The draft's rank fixture claimed A(0.8, 20 fires) dominates C(0.4, 8 fires);
it does not — A pays more fires — so the rank tests here use same-fires
constructions where dominance actually holds.)

Run with:
    cd apps/nba-sidecar
    uv run --extra research --extra dev python -m pytest tests/test_pareto.py -v
"""

from __future__ import annotations

import json

from nba_sidecar.research.evaluation.pareto import (
    ParetoPoint,
    build_pareto_front,
    dominates,
    pareto_rank,
    print_pareto_report,
    save_pareto_results,
)


def _pt(name: str, recall: float, fires: float, ece: float | None = None) -> ParetoPoint:
    return ParetoPoint(name=name, recall=recall, fires_per_game=fires, ece=ece)


# ---------------------------------------------------------------------------
# dominates()
# ---------------------------------------------------------------------------


class TestDominates:
    def test_strictly_better_recall_same_fires(self):
        a = _pt("A", recall=0.5, fires=5.0)
        b = _pt("B", recall=0.3, fires=5.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_same_recall_strictly_fewer_fires(self):
        a = _pt("A", recall=0.4, fires=3.0)
        b = _pt("B", recall=0.4, fires=8.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_better_on_both_dimensions(self):
        a = _pt("A", recall=0.6, fires=2.0)
        b = _pt("B", recall=0.2, fires=10.0)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_identical_models_do_not_dominate_each_other(self):
        a = _pt("A", recall=0.4, fires=5.0)
        b = _pt("B", recall=0.4, fires=5.0)
        assert not dominates(a, b)
        assert not dominates(b, a)

    def test_tradeoff_neither_dominates(self):
        a = _pt("A", recall=0.8, fires=20.0)
        b = _pt("B", recall=0.1, fires=1.0)
        assert not dominates(a, b)
        assert not dominates(b, a)

    def test_ece_dimension_included_when_available(self):
        # A has better recall, same fires, but worse ECE → does not dominate.
        a = _pt("A", recall=0.5, fires=5.0, ece=0.20)
        b = _pt("B", recall=0.3, fires=5.0, ece=0.05)
        assert not dominates(a, b)  # A worse on ECE
        assert not dominates(b, a)  # B worse on recall

    def test_ece_dimension_skipped_when_none(self):
        a = _pt("A", recall=0.5, fires=5.0, ece=None)
        b = _pt("B", recall=0.3, fires=5.0, ece=None)
        assert dominates(a, b)

    def test_ece_skipped_when_one_is_none(self):
        a = _pt("A", recall=0.5, fires=5.0, ece=0.10)
        b = _pt("B", recall=0.3, fires=5.0, ece=None)
        # ECE skipped; A has higher recall, same fires → dominates.
        assert dominates(a, b)

    def test_all_three_dimensions_better(self):
        a = _pt("A", recall=0.8, fires=2.0, ece=0.02)
        b = _pt("B", recall=0.2, fires=15.0, ece=0.25)
        assert dominates(a, b)
        assert not dominates(b, a)

    def test_floating_point_tolerance(self):
        a = _pt("A", recall=0.4 + 1e-12, fires=5.0 - 1e-12)
        b = _pt("B", recall=0.4, fires=5.0)
        # Differences below the 1e-9 tolerance are treated as equal.
        assert not dominates(a, b)
        assert not dominates(b, a)


# ---------------------------------------------------------------------------
# build_pareto_front()
# ---------------------------------------------------------------------------


class TestBuildParetoFront:
    def test_single_model_is_always_on_front(self):
        front, dominated = build_pareto_front([_pt("only", recall=0.3, fires=5.0)])
        assert len(front) == 1
        assert front[0].name == "only"
        assert dominated == {}

    def test_two_nondominated_models_both_on_front(self):
        points = [
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("low_burden", recall=0.1, fires=1.0),
        ]
        front, dominated = build_pareto_front(points)
        assert {p.name for p in front} == {"high_recall", "low_burden"}
        assert dominated == {}

    def test_dominated_model_excluded_from_front(self):
        points = [
            _pt("good", recall=0.6, fires=5.0),
            _pt("bad", recall=0.3, fires=8.0),  # dominated by good
            _pt("tradeoff", recall=0.1, fires=1.0),  # not dominated
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "bad" not in front_names
        assert {"good", "tradeoff"} <= front_names
        assert "good" in dominated["bad"]

    def test_known_baseline_scenario(self):
        """The recorded signal-console baselines are BOTH on the front.

        robust_mad (recall 0.267, 15.55 fires/game) vs state_space_current
        (recall 0.000, 0.75 fires/game): neither dominates — they are genuinely
        different operating points (high-recall/high-burden vs
        low-burden/zero-recall). The front only collapses when a new model
        beats one of them on ALL dimensions simultaneously.
        """
        points = [
            _pt("robust_mad", recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
        ]
        front, dominated = build_pareto_front(points)
        assert {p.name for p in front} == {"robust_mad", "state_space_current"}
        assert dominated == {}

    def test_new_model_dominates_state_space_current(self):
        """The bar a candidate tries to clear: recall > 0 at fires <= 0.75
        collapses the quiet corner of the front."""
        points = [
            _pt("robust_mad", recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
            _pt("new_model", recall=0.133, fires=0.60),
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "state_space_current" not in front_names
        assert {"new_model", "robust_mad"} <= front_names
        assert "new_model" in dominated["state_space_current"]

    def test_all_dominated_by_one_perfect_model(self):
        points = [
            _pt("perfect", recall=1.0, fires=0.0),
            _pt("alpha", recall=0.5, fires=5.0),
            _pt("beta", recall=0.3, fires=8.0),
            _pt("gamma", recall=0.1, fires=12.0),
        ]
        front, dominated = build_pareto_front(points)
        assert [p.name for p in front] == ["perfect"]
        assert len(dominated) == 3

    def test_empty_input_returns_empty_front(self):
        front, dominated = build_pareto_front([])
        assert front == []
        assert dominated == {}

    def test_dominated_by_contains_correct_dominators(self):
        points = [
            _pt("A", recall=0.8, fires=3.0),
            _pt("B", recall=0.6, fires=3.0),  # dominated by A
            _pt("C", recall=0.4, fires=3.0),  # dominated by A and B
        ]
        _, dominated = build_pareto_front(points)
        assert "A" not in dominated
        assert "A" in dominated["B"]
        assert "A" in dominated["C"]
        assert "B" in dominated["C"]

    def test_with_ece_dimension(self):
        points = [
            _pt("A", recall=0.6, fires=5.0, ece=0.05),
            _pt("B", recall=0.6, fires=5.0, ece=0.10),  # dominated: worse ECE only
            _pt("C", recall=0.3, fires=2.0, ece=0.05),  # tradeoff
        ]
        front, dominated = build_pareto_front(points)
        front_names = {p.name for p in front}
        assert "B" not in front_names
        assert {"A", "C"} <= front_names
        assert "B" in dominated


# ---------------------------------------------------------------------------
# pareto_rank()
# ---------------------------------------------------------------------------


class TestParetoRank:
    def test_rank_1_is_front_and_dominated_get_rank_2(self):
        # Same fires so recall alone decides dominance: A > B > C.
        points = [
            _pt("A", recall=0.9, fires=5.0),
            _pt("B", recall=0.6, fires=5.0),
            _pt("C", recall=0.3, fires=5.0),
        ]
        rank_map = {p.name: r for r, p in pareto_rank(points)}
        assert rank_map == {"A": 1, "B": 2, "C": 3}

    def test_tradeoffs_share_rank_one(self):
        points = [
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("low_burden", recall=0.1, fires=1.0),
        ]
        ranked = pareto_rank(points)
        assert all(rank == 1 for rank, _ in ranked)

    def test_ranks_are_contiguous_from_one(self):
        points = [
            _pt("A", recall=0.9, fires=5.0),
            _pt("B", recall=0.6, fires=5.0),
            _pt("C", recall=0.3, fires=5.0),
        ]
        ranks = sorted({r for r, _ in pareto_rank(points)})
        assert ranks[0] == 1
        for i in range(1, len(ranks)):
            assert ranks[i] == ranks[i - 1] + 1

    def test_single_model_rank_one(self):
        ranked = pareto_rank([_pt("only", recall=0.5, fires=5.0)])
        assert ranked[0][0] == 1

    def test_sorted_by_recall_within_rank(self):
        points = [
            _pt("low_recall", recall=0.2, fires=20.0),
            _pt("high_recall", recall=0.8, fires=1.0),
            _pt("mid_recall", recall=0.5, fires=8.0),
        ]
        # high_recall dominates the others? high vs mid: 0.8>0.5 and 1.0<8.0 →
        # dominates; high vs low likewise. So ranks differ — use tradeoffs:
        points = [
            _pt("low_recall", recall=0.2, fires=1.0),
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("mid_recall", recall=0.5, fires=8.0),
        ]
        rank1 = [(r, p) for r, p in pareto_rank(points) if r == 1]
        recalls = [p.recall for _, p in rank1]
        assert recalls == sorted(recalls, reverse=True)


# ---------------------------------------------------------------------------
# save_pareto_results()
# ---------------------------------------------------------------------------


class TestSaveParetoResults:
    def test_saves_valid_json(self, tmp_path):
        points = [_pt("A", recall=0.5, fires=5.0), _pt("B", recall=0.2, fires=2.0)]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        assert "pareto_front" in data
        assert "dominated" in data
        assert "all_models" in data

    def test_saved_front_names_match(self, tmp_path):
        points = [
            _pt("high_recall", recall=0.8, fires=20.0),
            _pt("low_burden", recall=0.1, fires=1.0),
            _pt("bad", recall=0.0, fires=20.0),
        ]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        assert set(data["pareto_front"]) == {p.name for p in front}

    def test_all_models_have_pareto_rank(self, tmp_path):
        points = [_pt("A", recall=0.6, fires=5.0), _pt("B", recall=0.3, fires=5.0)]
        front, dominated = build_pareto_front(points)
        out = tmp_path / "pareto.json"
        save_pareto_results(points, front, dominated, out)
        data = json.loads(out.read_text())
        for m in data["all_models"]:
            assert isinstance(m["pareto_rank"], int)
            assert m["pareto_rank"] >= 1

    def test_creates_parent_directories(self, tmp_path):
        out = tmp_path / "nested" / "deep" / "pareto.json"
        points = [_pt("A", recall=0.5, fires=5.0)]
        front, dominated = build_pareto_front(points)
        save_pareto_results(points, front, dominated, out)
        assert out.exists()


# ---------------------------------------------------------------------------
# print_pareto_report() smoke tests
# ---------------------------------------------------------------------------


class TestPrintParetoReport:
    def test_prints_without_error(self, capsys):
        points = [
            _pt("robust_mad", recall=0.267, fires=15.55),
            _pt("state_space_current", recall=0.000, fires=0.75),
            _pt("virtual_source_state_space", recall=0.133, fires=3.20),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "PARETO" in captured.out
        assert "robust_mad" in captured.out

    def test_prints_with_ece_values(self, capsys):
        points = [
            _pt("A", recall=0.5, fires=5.0, ece=0.082),
            _pt("B", recall=0.2, fires=2.0, ece=0.041),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "0.0820" in captured.out

    def test_prints_with_none_ece(self, capsys):
        points = [
            _pt("A", recall=0.5, fires=5.0, ece=None),
            _pt("B", recall=0.2, fires=2.0, ece=None),
        ]
        front, dominated = build_pareto_front(points)
        print_pareto_report(front, dominated, all_points=points)
        captured = capsys.readouterr()
        assert "n/a" in captured.out
