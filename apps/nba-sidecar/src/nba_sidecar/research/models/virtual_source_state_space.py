"""virtual_source_state_space: precision-weighted ensemble of virtual-source state-space board detectors.

Inspired by Bobby Ingram's MLB player-props pipeline (Swish workshop, 3 June 2026):

    "Independent Extended Kalman Filters, one per skill dimension. The most important
     component. Each filter has its own process noise tuned to that skill's natural
     variability. Getting the filter parameters right matters more than architecture
     search on everything downstream."

The analogy:
    Bobby: one EKF per player skill (HR rate, walk rate, K rate). Each skill has its
           own process noise (how fast skill can change) and observation noise (how
           noisy an at-bat outcome is as a skill measurement).

    Here:  one EKF per betting source. Each source has its own natural baseline
           volatility (process noise) and liquidity profile (observation noise — how
           much one tick from this source should move the estimate). A thin prediction
           market spikes more freely than a sportsbook; a coordinated multi-source move
           is stronger evidence than a single-source glitch.

The combine:
    Bobby uses the EKF outputs as features for a neural net. Here, we combine the
    per-source standardized innovations via PRECISION WEIGHTING (inverse-variance):
    sources with a tight, stable recent-innovation history get high weight; noisy
    or thin sources get low weight. This is a principled Research-lane peer for
    the hand-tuned sourceTrust.sourceDominancePenalty / sourceAgreementBonus block
    in the production state-space filter.

Architecture (per bucket i):
    For each virtual source s:
        1. Observation: y_{s,t} = log1p(intensity_s / breadth_s)
        2. Predict/update Kalman state [level_s, trend_s] (same equations as
           volatility._run_state_filter, isolated per source)
        3. innovation_s = y_{s,t} - predicted_level_s
        4. scale_s = MAD(recent innovations_s)  (robust, causal)
        5. z_s = innovation_s / scale_s          (standardized per-source surprise)
        6. precision_s = 1 / max(eps, scale_s^2) (inverse variance)

    Combined:
        z_combined = sum(precision_s * z_s) / sum(precision_s)  (precision-weighted)
        fire = z_combined >= enter_z AND warmed (with hysteresis: no re-fire while
        in alert; alert exits when z_combined < exit_z)

Data constraint (IMPORTANT):
    The board_observations snapshot does NOT split intensity by source — it is
    already pooled to one row per (game_id, bucket_start). The source_count,
    source_dominance, and source_disagreement columns give us AGGREGATE source
    metadata, not source-bucket contributions. This means we must APPROXIMATE
    per-source filters using the available aggregate signals:

        source_count        → how many sources contributed this bucket
        source_dominance    → fraction of intensity from the dominant source (0–1)
        source_disagreement → cross-source spread (0 = perfect agreement)

    Approximation strategy (documented explicitly so future devs can improve it
    when source-bucket contribution columns become available in the snapshot):

        intensity_dominant ≈ intensity * source_dominance
        intensity_minority ≈ intensity * (1 - source_dominance) / max(1, source_count - 1)
        disagreement_bonus ≈ source_disagreement * disagreement_scale

    We run TWO virtual filters instead of one per named source:
        filter[0]: "dominant source"  — high dominance → high intensity estimate
        filter[1]: "minority sources" — pooled remainder

    When source_count == 1: only filter[0] runs. filter[1] gets zero weight.
    When source_count >= 2: both filters run. Precision weights emerge from
    each filter's MAD scale.

    This is an approximation — the source decomposition is approximate and the
    diagnostics say so. When the snapshot adds a real
    ``source_bucket_contributions`` artifact, replace the two virtual filters
    with N named-source filters.

Diagnostics note:
    The continuous ``score`` is the precision-weighted combined z (unbounded).
    ``diagnostics["regimeScore"]`` is a bounded 0–1 sigmoid view of that z for
    reliability/calibration reporting. No ``threshold`` diagnostic is emitted:
    the shared scorer's residual-coverage join compares ``intensity <=
    threshold`` in intensity units, and this model's trigger lives in z units —
    emitting it would fabricate the diagnostic. Residual coverage is therefore
    honestly reported as null for this model.

References:
    Welch & Bishop, "An Introduction to the Kalman Filter", UNC TR 95-041
    Harvey, "Forecasting, Structural Time Series Models and the Kalman Filter" (1990)
    Ingram (Swish workshop June 3 2026) — per-filter process noise tuning
    apps/nba-sidecar/src/nba_sidecar/volatility.py::_run_state_filter (the
    production filter whose predict/update equations this replicates per-source)
    docs/moniac-pipeline-plan-and-code-draft.md (Phase 1 source material)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import median
from typing import Any

from ..contracts import PredictionRow
from .base import BoardModel, ScoreRequest, ScoreResult, register

_MAD_CONSISTENCY = 1.4826  # consistent estimator of sigma for normal data

# Minimum scale floor to avoid division by zero.
_SCALE_FLOOR: float = 1e-6

# Minimum precision floor.
_PRECISION_FLOOR: float = 1e-8

# Sigmoid steepness mapping z_combined → bounded 0–1 regimeScore diagnostic.
# k=1.5 chosen so sigma(enter_z) ≈ 0.95 relative to the trigger.
_REGIME_SIGMOID_K: float = 1.5

# |exponent| cap for the regime sigmoid (see _bounded_regime_score).
_SIGMOID_EXP_CLAMP: float = 60.0


# ---------------------------------------------------------------------------
# Per-filter state dataclass
# ---------------------------------------------------------------------------


@dataclass
class _FilterState:
    """Kalman state for one virtual source filter.

    State vector: [level, trend]
    Covariance:   2×2 symmetric matrix stored as p00, p01, p10, p11.

    Identical math to volatility._run_state_filter but isolated per virtual
    source. This is the direct implementation of Bobby's "one filter per
    independent dimension" principle.
    """

    level: float = 0.0
    trend: float = 0.0
    p00: float = 1.0  # level variance
    p01: float = 0.0  # level-trend covariance
    p10: float = 0.0  # trend-level covariance
    p11: float = 0.01  # trend variance

    # Rolling window of recent innovations for robust MAD scale computation.
    recent_innovations: list[float] = field(default_factory=list)

    initialized: bool = False  # False until the first observation arrives
    in_alert: bool = False  # hysteresis gate


# ---------------------------------------------------------------------------
# Core Kalman predict/update (pure functions — easier to test)
# ---------------------------------------------------------------------------


def _kalman_predict(
    state: _FilterState,
    level_process_noise: float,
    trend_process_noise: float,
    trend_decay: float,
) -> tuple[float, float, float, float, float, float]:
    """Kalman predict step.

    Returns:
        (predicted_level, predicted_trend,
         pred_p00, pred_p01, pred_p10, pred_p11)

    Math (identical to volatility.py _run_state_filter predict block):
        F = [[1, 1],
             [0, trend_decay]]
        P_pred = F @ P @ F.T + Q
    where Q = diag([level_process_noise, trend_process_noise]).
    """
    predicted_level = state.level + state.trend
    predicted_trend = state.trend * trend_decay

    # P_pred = F @ P @ F^T + Q, expanded for the 2x2 level/trend form:
    pred_p00 = state.p00 + state.p10 + state.p01 + state.p11 + level_process_noise
    pred_p01 = trend_decay * (state.p01 + state.p11)
    pred_p10 = trend_decay * (state.p10 + state.p11)
    pred_p11 = trend_decay * trend_decay * state.p11 + trend_process_noise

    return (predicted_level, predicted_trend, pred_p00, pred_p01, pred_p10, pred_p11)


def _kalman_update(
    state: _FilterState,
    observation: float,
    obs_noise: float,
    level_process_noise: float,
    trend_process_noise: float,
    trend_decay: float,
    mad_window: int,
) -> tuple[float, float]:
    """Kalman predict+update step. Mutates state in place.

    Returns:
        (innovation, innovation_variance)
        where innovation = observation - predicted_level (the raw residual)
        and innovation_variance = pred_p00 + obs_noise^2

    The standardized innovation z = innovation / mad_scale is computed by the
    caller using the rolling MAD window (not here), so this function stays pure.
    """
    (
        predicted_level,
        predicted_trend,
        pred_p00,
        pred_p01,
        pred_p10,
        pred_p11,
    ) = _kalman_predict(state, level_process_noise, trend_process_noise, trend_decay)

    innovation = observation - predicted_level
    innovation_variance = pred_p00 + obs_noise * obs_noise

    # Kalman gain (scalar observation model H = [1, 0]):
    #   K_level = pred_p00 / innovation_variance
    #   K_trend = pred_p10 / innovation_variance
    gain_level = pred_p00 / innovation_variance
    gain_trend = pred_p10 / innovation_variance

    state.level = predicted_level + gain_level * innovation
    state.trend = predicted_trend + gain_trend * innovation

    # Covariance update: P = (I - K @ H) @ P_pred
    state.p00 = (1.0 - gain_level) * pred_p00
    state.p01 = (1.0 - gain_level) * pred_p01
    state.p10 = pred_p10 - gain_trend * pred_p00
    state.p11 = pred_p11 - gain_trend * pred_p01

    # Rolling innovations window (causal — only past + current observations).
    state.recent_innovations.append(innovation)
    if len(state.recent_innovations) > mad_window:
        state.recent_innovations.pop(0)

    state.initialized = True

    return innovation, innovation_variance


def _robust_mad_scale(innovations: list[float]) -> float:
    """Compute robust MAD scale from recent innovations.

    scale = 1.4826 * median(|innovation - median(innovation)|)

    Floored at _SCALE_FLOOR to prevent division by zero; returns a neutral 1.0
    when fewer than 4 innovations exist (not enough data for a meaningful
    scale estimate during warmup).
    """
    if len(innovations) < 4:
        return 1.0  # neutral fallback during warmup

    med = median(innovations)
    mad = median([abs(v - med) for v in innovations])
    return max(_SCALE_FLOOR, _MAD_CONSISTENCY * mad)


def _precision_weighted_combine(
    z_scores: list[float],
    scales: list[float],
    weights: list[float],
) -> float:
    """Combine per-source standardized innovations via precision weighting.

    precision_s = weight_s / max(eps, scale_s^2)
    combined_z  = sum(precision_s * z_s) / sum(precision_s)

    Args:
        z_scores: standardized innovation per filter (z_s = innovation_s / scale_s)
        scales:   MAD scale per filter (used for precision = 1/scale^2)
        weights:  explicit weight multiplier per filter — 1.0 for equal
                  weighting, 0.0 to exclude a filter

    Returns:
        precision-weighted combined z-score. Returns 0.0 if total precision is
        below _PRECISION_FLOOR (e.g., during early warmup of all filters).
    """
    total_precision = 0.0
    weighted_sum = 0.0

    for z, scale, w in zip(z_scores, scales, weights, strict=True):
        if w <= 0.0:
            continue
        precision = w / max(_PRECISION_FLOOR, scale * scale)
        weighted_sum += precision * z
        total_precision += precision

    if total_precision < _PRECISION_FLOOR:
        return 0.0

    return weighted_sum / total_precision


def _bounded_regime_score(z_combined: float, enter_z: float) -> float:
    """Bounded 0–1 sigmoid view of the combined z, for calibration diagnostics.

    The exponent is clamped: math.exp overflows above ~709, so an extreme
    negative surprise (tiny MAD scale followed by a much quieter bucket) would
    otherwise raise OverflowError and abort scoring the whole model. At the
    clamp (|exponent| = 60) the sigmoid is within ~1e-26 of its asymptote, so
    the clamped value is numerically indistinguishable from the true one.
    """
    exponent = -_REGIME_SIGMOID_K * (z_combined - enter_z)
    exponent = max(-_SIGMOID_EXP_CLAMP, min(_SIGMOID_EXP_CLAMP, exponent))
    return 1.0 / (1.0 + math.exp(exponent))


# ---------------------------------------------------------------------------
# The model class
# ---------------------------------------------------------------------------


@register
class VirtualSourceStateSpaceModel(BoardModel):
    id = "virtual_source_state_space"
    name = "Virtual source state space"
    summary = (
        "Research-only source-aware state-space candidate: independent Kalman "
        "level/trend filters per virtual source (dominant vs pooled minority), "
        "combined by inverse-variance precision weighting, with a robust "
        "trailing-MAD innovation scale and a hysteresis trigger. Uses aggregate "
        "source_count/source_dominance/source_disagreement as a virtual-source "
        "APPROXIMATION because the snapshot does not carry per-source bucket "
        "contributions. A principled peer to the hand-tuned sourceTrust block, "
        "not a live-path replacement."
    )
    family = "state-space"
    references = (
        "Welch & Bishop, 'An Introduction to the Kalman Filter', UNC TR 95-041.",
        "Ingram MLB player-props pipeline (Swish workshop, June 2026) — one EKF "
        "per independent signal dimension, precision-weighted combine.",
        "apps/nba-sidecar/src/nba_sidecar/volatility.py::_run_state_filter "
        "(production predict/update equations replicated per virtual source).",
        "docs/moniac-pipeline-plan-and-code-draft.md (Phase 1).",
    )

    def default_params(self) -> dict[str, Any]:
        return {
            # Process noise: how fast can the latent baseline level/trend drift?
            # Higher → filter adapts faster but is noisier.
            "level_process_noise": 1e-4,
            "trend_process_noise": 1e-6,
            "trend_decay": 0.95,
            # Observation noise per virtual filter. The dominant source is
            # treated as higher-quality (lower R); pooled minority sources as
            # noisier (higher R).
            "obs_noise_dominant": 0.8,
            "obs_noise_minority": 1.4,
            # Scaling factor converting source_disagreement → observation bonus
            # (mirrors the disagreement term in the production observation model).
            "disagreement_scale": 0.3,
            # Warmup: no firing before this many buckets (index-based, matching
            # robust_mad / template_model warmup semantics).
            "warmup_buckets": 20,
            # Number of recent innovations for the robust MAD scale.
            "mad_window": 40,
            # Trigger (z units): enter at enter_z, hysteresis exit below exit_z.
            # enter_z matches K_MAD_LIVE = 3.0.
            "enter_z": 3.0,
            "exit_z": 1.5,
        }

    def score(self, request: ScoreRequest) -> ScoreResult:
        params = self.resolve_params(request.params)
        level_pn = float(params["level_process_noise"])
        trend_pn = float(params["trend_process_noise"])
        trend_decay = float(params["trend_decay"])
        obs_noise_dominant = float(params["obs_noise_dominant"])
        obs_noise_minority = float(params["obs_noise_minority"])
        disagreement_scale = float(params["disagreement_scale"])
        warmup_buckets = int(params["warmup_buckets"])
        mad_window = int(params["mad_window"])
        enter_z = float(params["enter_z"])
        exit_z = float(params["exit_z"])

        # Filter state is LOCAL to this call: a BoardModel is a pure function of
        # (series, params), so per-game isolation and replay determinism come
        # from construction, not from a reset() protocol.
        dominant = _FilterState()
        minority = _FilterState()
        in_alert = False

        predictions: list[PredictionRow] = []

        for i, bucket in enumerate(request.series.buckets):
            intensity = float(bucket.intensity or 0.0)
            active_market_count = int(bucket.active_market_count or 1)
            source_count = int(bucket.source_count or 1)
            source_dominance = float(
                bucket.source_dominance if bucket.source_dominance is not None else 1.0
            )
            source_disagreement = float(bucket.source_disagreement or 0.0)

            # ---- Approximate per-virtual-source intensities ----------------
            # See module docstring "Data constraint" for why this is an
            # approximation over aggregate columns.
            breadth = max(1.0, float(active_market_count))
            intensity_dominant = intensity * source_dominance
            intensity_minority = (
                intensity * (1.0 - source_dominance) / max(1, source_count - 1)
                if source_count > 1
                else 0.0
            )

            # Disagreement bonus applied only to the dominant filter (its move
            # "won" the cross-source comparison — it carries the directional
            # signal).
            disagreement_bonus = source_disagreement * disagreement_scale

            # log1p transform mirrors the production observation model.
            obs_dominant = math.log1p(intensity_dominant / breadth) + disagreement_bonus
            obs_minority = (
                math.log1p(intensity_minority / breadth) if source_count > 1 else 0.0
            )

            # ---- Run Kalman update per virtual filter ----------------------
            innov_d, _ = _kalman_update(
                dominant,
                obs_dominant,
                obs_noise_dominant,
                level_pn,
                trend_pn,
                trend_decay,
                mad_window,
            )

            minority_active = source_count >= 2
            if minority_active:
                innov_m, _ = _kalman_update(
                    minority,
                    obs_minority,
                    obs_noise_minority,
                    level_pn,
                    trend_pn,
                    trend_decay,
                    mad_window,
                )
            else:
                # No minority source this bucket — advance the predict step so
                # uncertainty grows during absence, but do NOT update from data.
                (pl, pt, pp00, pp01, pp10, pp11) = _kalman_predict(
                    minority, level_pn, trend_pn, trend_decay
                )
                minority.level = pl
                minority.trend = pt
                minority.p00 = pp00
                minority.p01 = pp01
                minority.p10 = pp10
                minority.p11 = pp11
                innov_m = 0.0

            # ---- Robust MAD scales + standardized z ------------------------
            scale_d = _robust_mad_scale(dominant.recent_innovations)
            scale_m = (
                _robust_mad_scale(minority.recent_innovations)
                if minority_active and len(minority.recent_innovations) >= 4
                else 1.0
            )
            z_d = innov_d / scale_d
            z_m = innov_m / scale_m if minority_active else 0.0

            # ---- Precision-weighted combination ----------------------------
            w_d = 1.0
            w_m = 1.0 if minority_active else 0.0
            z_combined = _precision_weighted_combine(
                z_scores=[z_d, z_m],
                scales=[scale_d, scale_m],
                weights=[w_d, w_m],
            )

            # ---- Warmup + hysteresis fire gate ------------------------------
            warmed = i >= warmup_buckets
            if not warmed:
                in_alert = False
                fired = False
            elif not in_alert and z_combined >= enter_z:
                in_alert = True
                fired = True
            elif in_alert and z_combined < exit_z:
                in_alert = False
                fired = False
            else:
                fired = False  # sustained alert or quiet — do not (re-)fire

            # Bounded 0–1 reliability view of the combined z, for calibration
            # diagnostics ("when the model says 0.8, does it fire ~80%?").
            regime = _bounded_regime_score(z_combined, enter_z)

            predictions.append(
                PredictionRow(
                    game_id=request.series.game_id,
                    bucket_start=bucket.bucket_start,
                    score=z_combined,
                    fired=fired,
                    diagnostics={
                        "regimeScore": regime,
                        "zCombined": z_combined,
                        "zDominant": z_d,
                        "zMinority": z_m,
                        "scaleDominant": scale_d,
                        "scaleMinority": scale_m,
                        "warmed": float(warmed),
                        "sourceCountUsed": float(source_count),
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


__all__ = ["VirtualSourceStateSpaceModel"]
