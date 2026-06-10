"""composite_attribution: Board state-space × attribution signal composition.

Implements the residual-architecture insight from Bobby Ingram's MLB
player-props pipeline (Swish workshop, June 2026):

    "The neural net predicts RESIDUALS on top of the Bradley-Terry baseline.
     B-T gives you a principled prior; the NN corrects its systematic errors.
     Neither alone is as good as both together."

Signal console analog:
    Layer 1 (Board):       regimeScore  = how surprised is the aggregate board?
                           Produced by the virtual_source_state_space candidate
                           through the shared evaluate_model path.
    Layer 2 (Attribution): pairedScore  = rightful_drift - credited_drift
                           Produced by attribution.signed_paired_score().
    Composition:           compositeScore = combine(regimeScore, pairedScore)

Why (from docs/research-2026-05-31-miscredit-model-direction.md): pooled board
features have AUC ≈ 0.5 vs the high-intensity control — incidents are NOT the
biggest board moves. The paired attribution signal is DIRECTIONAL (credited
drifts down, rightful drifts up), a different geometric object than board
magnitude. Neither alone suffices; the composition is the candidate
architecture for the recall=0 problem.

Composition strategies (selectable via ``strategy``):
    "product":      regime × paired — both signals must be active (Bobby's
                    baseline × residual-correction pattern; most conservative).
    "weighted_sum": α·regime + β·paired, clipped to [0, 1] — softer.
    "gate":         paired if regime >= gate_threshold else 0 — board gates,
                    attribution drives.
    "max":          max(regime, paired) — exploratory; highest recall/burden.

ARCHITECTURE CONTRACT (per the draft's review overlay): this is an EXTERNAL
predictions producer, NOT a registered BoardModel. It needs prop ticks,
candidate pairs, and event anchors that the BoardModel bucket contract does
not carry; it writes a ``predictions.parquet`` scored via
``pnpm quant score-predictions`` — identically to native models. Do not
register it in ``nba_sidecar.research.models`` until those inputs have a
formal contract.

CURRENT DATA BLOCKER (kept honest, not papered over): the repo has the
signed-paired scorer and a ``player_prop_ticks`` loader contract, but no
bucket-indexed rebound-event/candidate snapshot table, and
``scripts/export-quant-snapshot.ts`` does not yet write
``player_prop_ticks.parquet``. Until those exist, ``write_composite_predictions``
degrades to board-only composition (empty event context → pairedScore 0.0,
support "insufficient_support") and says so. Fixture-backed tests cover the
full composition path; live-snapshot proof is pending those artifacts.

References:
    Ingram (Swish workshop June 2026) — B-T + NN residual architecture.
    docs/research-2026-05-31-miscredit-model-direction.md §2.5 — AUC finding.
    apps/nba-sidecar/src/nba_sidecar/research/attribution.py — signed_paired_score.
    apps/nba-sidecar/src/nba_sidecar/research/candidates.py — candidate pairs.
    docs/moniac-pipeline-plan-and-code-draft.md (Phase 4 source material).
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from ..attribution import signed_paired_score

# ---------------------------------------------------------------------------
# Constants (defaults; the producer takes them as constructor params)
# ---------------------------------------------------------------------------

# Sigmoid steepness for normalizing raw pairedScore → [0, 1].
_PAIRED_SIGMOID_K: float = 2.0

# Minimum raw pairedScore magnitude considered non-trivial; below = noise → 0.
_PAIRED_NOISE_FLOOR: float = 0.05

# Default fire threshold on compositeScore (conservative, K_MAD_LIVE spirit).
_FIRE_THRESHOLD: float = 0.65

# Hysteresis exit at this fraction of the fire threshold.
_EXIT_RATIO: float = 0.70

# Default gate threshold for the "gate" strategy.
_GATE_THRESHOLD: float = 0.40

# Default weights for "weighted_sum" (need not sum to 1; output is clipped).
_ALPHA: float = 0.35
_BETA: float = 0.65

# Attribution warmup: candidate pairs before this many buckets are noisy.
_ATTRIBUTION_WARMUP_BUCKETS: int = 20

_VALID_STRATEGIES = frozenset({"product", "weighted_sum", "gate", "max"})


# ---------------------------------------------------------------------------
# Composition strategies (pure functions — tested in isolation)
# ---------------------------------------------------------------------------


def _normalize_paired_score(raw: Optional[float]) -> float:
    """Normalize raw pairedScore (= rightful_drift - credited_drift) to [0, 1].

    One-sided by design (Bobby's residual-correction philosophy): the paired
    signal either confirms the board move (positive contribution) or is absent
    (zero) — it never subtracts from the board score.

    - None or |raw| < noise floor → 0.0 (absence of signal contributes nothing,
      not 0.5).
    - raw <= 0 → 0.0 (a move opposite the miscredit signature is not evidence).
    - raw > 0 → 2·(sigmoid(k·raw) − 0.5) ∈ (0, 1].
    """
    if raw is None:
        return 0.0
    if abs(raw) < _PAIRED_NOISE_FLOOR:
        return 0.0
    if raw <= 0.0:
        return 0.0

    sigmoid_val = 1.0 / (1.0 + math.exp(-_PAIRED_SIGMOID_K * raw))
    normalized = 2.0 * (sigmoid_val - 0.5)
    return max(0.0, min(1.0, normalized))


def _compose_product(regime: float, paired: float) -> float:
    """regime × paired: both signals must be active (most conservative)."""
    return regime * paired


def _compose_weighted_sum(
    regime: float, paired: float, alpha: float = _ALPHA, beta: float = _BETA
) -> float:
    """α·regime + β·paired, clipped to [0, 1] (softer combination)."""
    return max(0.0, min(1.0, alpha * regime + beta * paired))


def _compose_gate(
    regime: float, paired: float, gate_threshold: float = _GATE_THRESHOLD
) -> float:
    """Board gates, attribution drives: paired if regime >= gate, else 0."""
    if regime >= gate_threshold:
        return paired
    return 0.0


def _compose_max(regime: float, paired: float) -> float:
    """max(regime, paired): fires when either is strong (exploratory only)."""
    return max(regime, paired)


# ---------------------------------------------------------------------------
# Per-game state
# ---------------------------------------------------------------------------


@dataclass
class _CompositeGameState:
    """Game-level hysteresis state for the composite producer."""

    bucket_count: int = 0
    in_alert: bool = False
    recent_composite_scores: list[float] = field(default_factory=list)


# ---------------------------------------------------------------------------
# The external producer
# ---------------------------------------------------------------------------


class CompositeAttributionProducer:
    """Board state-space × attribution composition, as an external producer.

    Layer 1: board predictions frame (from evaluate_model) → regimeScore.
    Layer 2: attribution candidates + prop ticks → pairedScore.
    Final:   compose() → compositeScore → fired (hysteresis-gated).

    Args:
        strategy:        "product" | "weighted_sum" | "gate" | "max"
                         (default "product" — the residual pattern).
        fire_threshold:  compositeScore enter threshold (default 0.65); the
                         hysteresis exit is fire_threshold × 0.70.
        gate_threshold:  regime gate for the "gate" strategy (default 0.40).
        alpha / beta:    "weighted_sum" weights (defaults 0.35 / 0.65).
        attribution_warmup_buckets:
                         buckets before the attribution layer is consulted
                         (default 20) — early-game candidate pairs are noisy,
                         mirroring how the residual layer is only evaluated
                         once the baseline layer is reliable.
    """

    def __init__(
        self,
        strategy: str = "product",
        fire_threshold: float = _FIRE_THRESHOLD,
        gate_threshold: float = _GATE_THRESHOLD,
        alpha: float = _ALPHA,
        beta: float = _BETA,
        attribution_warmup_buckets: int = _ATTRIBUTION_WARMUP_BUCKETS,
    ) -> None:
        if strategy not in _VALID_STRATEGIES:
            raise ValueError(
                f"strategy must be one of {sorted(_VALID_STRATEGIES)}, got '{strategy}'"
            )
        self.strategy = strategy
        self.fire_threshold = fire_threshold
        self.gate_threshold = gate_threshold
        self.alpha = alpha
        self.beta = beta
        self.attribution_warmup_buckets = attribution_warmup_buckets

    # ------------------------------------------------------------------
    # Composition dispatch
    # ------------------------------------------------------------------

    def _compose(self, regime: float, paired: float) -> float:
        if self.strategy == "product":
            return _compose_product(regime, paired)
        if self.strategy == "weighted_sum":
            return _compose_weighted_sum(regime, paired, self.alpha, self.beta)
        if self.strategy == "gate":
            return _compose_gate(regime, paired, self.gate_threshold)
        return _compose_max(regime, paired)

    # ------------------------------------------------------------------
    # Attribution layer (Layer 2)
    # ------------------------------------------------------------------

    def _paired_for_event(
        self,
        event: dict[str, Any],
        prop_ticks_by_player: dict[str, list[tuple[float, float]]],
    ) -> tuple[float, str]:
        """Score one event's candidate set; return (normalized, support).

        Max-over-candidates mirrors the residual pattern: every plausible
        matchup is evaluated and the strongest directional correction wins.
        Abstentions stay explicit: when no candidate has a usable score the
        support is "insufficient_support" and the contribution is 0.0 — never
        a fabricated number.

        Fail-open: attribution errors must never crash the producer; the board
        layer keeps operating (0.0 / "insufficient_support").
        """
        try:
            candidates = event.get("candidates", [])
            if not candidates:
                return 0.0, "insufficient_support"

            best_raw: Optional[float] = None
            best_support = "insufficient_support"
            for candidate in candidates:
                credited_id = str(candidate.credited_person_id)
                rightful_id = str(candidate.candidate_person_id)
                result = signed_paired_score(
                    prop_ticks_by_player.get(credited_id, []),
                    prop_ticks_by_player.get(rightful_id, []),
                    float(event["event_epoch"]),
                )
                if result.score is None:
                    continue
                if best_raw is None or result.score > best_raw:
                    best_raw = result.score
                    best_support = result.support

            return _normalize_paired_score(best_raw), best_support
        except Exception:
            # Fail open — see docstring.
            return 0.0, "insufficient_support"

    # ------------------------------------------------------------------
    # Row builder (external predictions contract, NOT BoardModel.score)
    # ------------------------------------------------------------------

    def _build_row(
        self,
        board_row: pd.Series,
        paired_score: float,
        paired_support: str,
        gs: _CompositeGameState,
    ) -> dict[str, Any]:
        """One external prediction row from a board row + attribution result.

        External predictions.parquet contract requires game_id, bucket_start,
        score, fired; extra diagnostic columns are allowed (and unlock the
        leaderboard/report views).
        """
        regime = float(board_row.get("regimeScore", board_row["score"]))
        z_combined = float(board_row.get("zCombined", board_row["score"]))
        warmed = bool(board_row.get("warmed", 1.0))

        composite_score = self._compose(regime, paired_score)

        # Hysteresis (mirrors the board models): fire once on enter, hold
        # silently while sustained, exit below fire_threshold × exit ratio.
        if not warmed:
            gs.in_alert = False
            fired = False
        elif not gs.in_alert and composite_score >= self.fire_threshold:
            gs.in_alert = True
            fired = True
        elif gs.in_alert and composite_score < self.fire_threshold * _EXIT_RATIO:
            gs.in_alert = False
            fired = False
        else:
            fired = False

        gs.recent_composite_scores.append(composite_score)
        if len(gs.recent_composite_scores) > 40:
            gs.recent_composite_scores = gs.recent_composite_scores[-40:]

        row: dict[str, Any] = {
            "game_id": str(board_row["game_id"]),
            "bucket_start": board_row["bucket_start"],
            "score": composite_score,
            "fired": fired,
            "regimeScore": regime,
            "zCombined": z_combined,
            "pairedScore": paired_score,
            "pairedSupport": paired_support,
            "fireThreshold": self.fire_threshold,
            "warmed": float(warmed),
            "compositeInAlert": float(gs.in_alert),
        }
        if "bucket_end" in board_row.index:
            row["bucket_end"] = board_row["bucket_end"]
        if "intensity" in board_row.index:
            row["intensity"] = float(board_row.get("intensity", 0.0) or 0.0)
        return row

    def build_predictions(
        self,
        board_predictions: pd.DataFrame,
        events_by_bucket: dict[tuple[str, str], list[dict[str, Any]]],
        ticks_by_game_player: dict[tuple[str, str], list[tuple[float, float]]],
    ) -> pd.DataFrame:
        """Build the external predictions frame: exactly one row per board bucket.

        Joins the board-layer output to event/candidate/tick context the
        BoardModel contract does not carry. When multiple rebound events share
        a board bucket, the strongest directional paired score wins — still
        one prediction row. Empty event context degrades to board-only
        composition (paired 0.0, support "insufficient_support").

        Hysteresis state lives in this call (keyed per game), so a producer
        instance can be reused across runs without contamination.
        """
        game_states: dict[str, _CompositeGameState] = {}
        rows: list[dict[str, Any]] = []
        ordered = board_predictions.sort_values(["game_id", "bucket_start"])

        for _, board_row in ordered.iterrows():
            game_id = str(board_row["game_id"])
            bucket_key = (game_id, str(board_row["bucket_start"]))
            if game_id not in game_states:
                game_states[game_id] = _CompositeGameState()
            gs = game_states[game_id]
            gs.bucket_count += 1

            attribution_open = (
                bool(board_row.get("warmed", 1.0))
                and gs.bucket_count >= self.attribution_warmup_buckets
            )

            paired_score = 0.0
            paired_support = "insufficient_support"
            if attribution_open:
                prop_ticks_by_player = {
                    player_id: ticks
                    for (gid, player_id), ticks in ticks_by_game_player.items()
                    if gid == game_id
                }
                for event in events_by_bucket.get(bucket_key, []):
                    score, support = self._paired_for_event(event, prop_ticks_by_player)
                    if score > paired_score or (
                        paired_score == 0.0 and support != "insufficient_support"
                    ):
                        paired_score = score
                        paired_support = support

            rows.append(self._build_row(board_row, paired_score, paired_support, gs))

        return pd.DataFrame(rows)


def write_composite_predictions(
    snapshot_path: Path,
    out_path: Path,
    *,
    strategy: str = "product",
    fire_threshold: float = _FIRE_THRESHOLD,
    board_model_id: str = "virtual_source_state_space",
) -> Path:
    """External producer entry point: board layer from the snapshot, then write
    ``predictions.parquet`` for ``pnpm quant score-predictions``.

    DATA BLOCKER (see module docstring): the snapshot does not yet carry a
    bucket-indexed rebound-event/candidate table, and the TS exporter does not
    yet write ``player_prop_ticks.parquet``. Until those exist this degrades
    honestly to board-only composition (empty event context) and prints a
    warning rather than fabricating attribution inputs.
    """
    from ..evaluation.evaluator import evaluate_model

    _, _, board_predictions = evaluate_model(board_model_id, snapshot_path)

    # Pending artifacts — replace with real loads once the snapshot carries
    # them (see "Fixture and data gates" in the plan doc).
    events_by_bucket: dict[tuple[str, str], list[dict[str, Any]]] = {}
    ticks_by_game_player: dict[tuple[str, str], list[tuple[float, float]]] = {}
    print(
        "WARNING: no bucket-indexed rebound-event/candidate snapshot table exists "
        "yet; composite predictions are BOARD-ONLY (pairedScore=0.0). This is a "
        "degraded smoke path, not a Phase 4 result."
    )

    producer = CompositeAttributionProducer(
        strategy=strategy, fire_threshold=fire_threshold
    )
    predictions = producer.build_predictions(
        board_predictions=board_predictions,
        events_by_bucket=events_by_bucket,
        ticks_by_game_player=ticks_by_game_player,
    )

    required = {"game_id", "bucket_start", "score", "fired"}
    missing = required - set(predictions.columns)
    if missing:
        raise ValueError(
            f"composite predictions missing required columns: {sorted(missing)}"
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_parquet(out_path, index=False)
    return out_path


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Write composite board×attribution external predictions.parquet "
            "(score it with `pnpm quant score-predictions`)."
        ),
    )
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--strategy",
        choices=sorted(_VALID_STRATEGIES),
        default="product",
    )
    parser.add_argument("--fire-threshold", type=float, default=_FIRE_THRESHOLD)
    args = parser.parse_args()

    written = write_composite_predictions(
        args.snapshot,
        args.out,
        strategy=args.strategy,
        fire_threshold=args.fire_threshold,
    )
    print(f"wrote {written}")


if __name__ == "__main__":
    _cli()


__all__ = [
    "CompositeAttributionProducer",
    "write_composite_predictions",
]
