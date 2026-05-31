"""Incident-alignment / feature-separation diagnostic.

The board-volatility platform implicitly assumes a stat-misattribution incident
produces a *distinctive, detectable* board move, so that a magnitude-surprise
detector can find it. This diagnostic measures whether that assumption holds for
a given snapshot, **per feature**, and it is built to *fail closed* when it
cannot honestly answer.

The question it answers, for one feature column ``f``:

    Does ``f`` separate buckets *inside* a scoreable-incident catch window from
    buckets *outside* any window that are JUST AS LARGE in intensity?

The "just as large" control is the load-bearing part. Comparing incident buckets
to *all* background buckets is easy and misleading: incidents happen during plays,
plays move the board, so almost any feature looks higher in-window than in the
dead air between plays. The honest question is whether a feature distinguishes an
incident from an ordinary *large* board move (a legit big play that is NOT a
miscredit). The control set is therefore the high-intensity tail of the
out-of-window buckets, gated by ``control_percentile``.

Separation is reported as a rank-based AUC (Mann-Whitney U / |in| / |control|):

- AUC ~= 0.5  -> the feature carries NO separating signal at this granularity.
- AUC -> 1.0  -> the feature is reliably higher in incident windows.
- AUC -> 0.0  -> the feature is reliably *lower* in incident windows.

This is the falsification instrument for the claim "the separating signal is not
in the pooled board-level features." If a future per-player / per-family feature
is plumbed into the snapshot, run this against it: it must clear ~0.5 to justify
the plumbing. It is intentionally *not* a detector and produces no fire decision.

Truth is loaded via :func:`evaluation.truth.load_truth` -- the same
pre-materialized, validated label tables the scorer joins to -- so the
diagnostic's notion of "scoreable incident window" is identical to the eval's,
not a private reimplementation.

Fail-closed contract (no fabricated numbers):

- A feature column absent from the frame, or all-null, reports
  ``support="insufficient_support"`` and ``auc=None`` -- never a bogus AUC.
- If the snapshot has no scoreable window, or no in-window bucket, or no
  high-intensity control bucket, the whole report is ``insufficient_support``.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from ..contracts import validate_dataframe  # noqa: F401  (re-exported convenience)
from ..loader import read_board_observations
from .truth import SnapshotTruth, load_truth

# The pooled board-level features a model currently sees (loader._CAUSAL_COLUMNS
# minus identifiers/timestamps). The diagnostic also accepts arbitrary extra
# feature names present in the frame (e.g. a future per-family column, or a
# synthetic control), so it can grade tomorrow's features the same way.
DEFAULT_FEATURES: tuple[str, ...] = (
    "intensity",
    "source_count",
    "source_dominance",
    "source_disagreement",
    "active_market_count",
    "game_elapsed_seconds",
)

# The feature used to define the "equally-large" control set, and which is
# therefore EXCLUDED from the separation verdict (its low AUC-vs-control is
# circular by construction). Reported anyway, because intensity AUC << 0.5 is the
# real finding "incidents are not the largest board moves".
DEFAULT_CONTROL_FEATURE: str = "intensity"

# Default percentile (over out-of-window buckets, on the control feature) that
# defines the "equally-large non-incident" control set. Declared knob -- changing
# it changes the control set and therefore the reported AUC.
DEFAULT_CONTROL_PERCENTILE: float = 90.0

# Default intensity below which a bucket counts as "no meaningful board move".
# Used only to COUNT incident windows that the board barely reacted to; it never
# affects an AUC. Declared knob.
DEFAULT_MOVEMENT_FLOOR: float = 1.0

_OK = "ok"
_INSUFFICIENT = "insufficient_support"


def _epoch_sec(s: pd.Series) -> pd.Series:
    """Wall-clock column (datetime or ISO string) -> unix seconds (int64)."""
    dt = pd.to_datetime(s, utc=True)
    return (dt.astype("int64") // 1_000_000_000).astype("int64")


def rank_auc(pos: np.ndarray, neg: np.ndarray) -> float | None:
    """AUC = P(score(pos) > score(neg)), tie-aware, via average ranks.

    Returns None (not NaN) when either group is empty after dropping NaNs, so the
    caller can treat "cannot compute" as insufficient support rather than a number.
    """
    pos = np.asarray(pos, dtype=float)
    neg = np.asarray(neg, dtype=float)
    pos = pos[~np.isnan(pos)]
    neg = neg[~np.isnan(neg)]
    if pos.size == 0 or neg.size == 0:
        return None
    allv = np.concatenate([pos, neg])
    ranks = pd.Series(allv).rank().to_numpy()  # average ranks for ties
    r_pos = ranks[: pos.size].sum()
    u = r_pos - pos.size * (pos.size + 1) / 2.0
    return float(u / (pos.size * neg.size))


@dataclass(frozen=True)
class FeatureSeparation:
    """Per-feature separation result. ``auc_vs_control`` is the decisive one."""

    feature: str
    support: str
    auc_vs_control: float | None
    auc_vs_all_out: float | None
    n_in: int
    n_control: int
    n_out_all: int
    note: str = ""


@dataclass(frozen=True)
class SeparationReport:
    """Whole-snapshot incident-alignment report (operator/researcher review)."""

    support: str
    n_scoreable_incidents: int
    n_scoreable_windows: int
    n_buckets_total: int
    n_in_window_buckets: int
    control_feature: str
    control_percentile: float
    control_intensity_threshold: float | None
    movement_floor: float
    in_window_single_source_share: float | None
    windows_with_negligible_movement: int
    windows_evaluated: int
    features: list[FeatureSeparation] = field(default_factory=list)
    verdict: str = ""

    def _verdict_features(self) -> list[FeatureSeparation]:
        """Scoreable features excluding the control-defining feature.

        The control feature's AUC-vs-control is circular (the control is selected
        on it), so it must not drive the verdict.
        """
        return [
            f for f in self.features
            if f.auc_vs_control is not None and f.feature != self.control_feature
        ]

    def max_abs_separation(self) -> float | None:
        """max over non-control features of |auc_vs_control - 0.5| (0 => nothing separates)."""
        vals = [abs(f.auc_vs_control - 0.5) for f in self._verdict_features()]
        return max(vals) if vals else None

    def max_positive_separation(self) -> float | None:
        """max over non-control features of (auc_vs_control - 0.5).

        Positive => feature is ELEVATED in incidents (the direction a positive
        detector could exploit by firing when the feature is high).
        """
        vals = [f.auc_vs_control - 0.5 for f in self._verdict_features()]
        return max(vals) if vals else None


def _windows_by_game(truth: SnapshotTruth) -> dict[str, list[tuple[int, int]]]:
    out: dict[str, list[tuple[int, int]]] = {}
    sw = truth.scoreable_windows()
    for _, r in sw.iterrows():
        out.setdefault(str(r["game_id"]), []).append(
            (int(r["window_start_sec"]), int(r["window_end_sec"]))
        )
    return out


def feature_separation(
    board_obs: pd.DataFrame,
    truth: SnapshotTruth,
    *,
    control_percentile: float = DEFAULT_CONTROL_PERCENTILE,
    control_feature: str = DEFAULT_CONTROL_FEATURE,
    features: tuple[str, ...] = DEFAULT_FEATURES,
    movement_floor: float = DEFAULT_MOVEMENT_FLOOR,
) -> SeparationReport:
    """Grade every feature on incident-vs-large-non-incident separation.

    ``board_obs`` must carry at least ``game_id``, ``bucket_start``,
    ``bucket_end`` and the ``control_feature`` column; any feature in ``features``
    that is missing or all-null is reported as ``insufficient_support`` rather
    than scored. The control set is the top ``control_percentile`` of
    out-of-window buckets by ``control_feature`` (default ``intensity``); the
    control feature is reported but EXCLUDED from the verdict (its AUC-vs-control
    is circular by construction).
    """
    if control_feature not in board_obs.columns:
        raise ValueError(
            f"control_feature {control_feature!r} not in board observations "
            f"(columns: {list(board_obs.columns)})"
        )
    df = board_obs.copy()
    df["_start_sec"] = _epoch_sec(df["bucket_start"])
    df["_end_sec"] = _epoch_sec(df["bucket_end"])

    win_by_game = _windows_by_game(truth)
    n_scoreable_windows = sum(len(v) for v in win_by_game.values())
    n_scoreable_incidents = len(truth.scoreable_incident_ids)

    if not win_by_game:
        return SeparationReport(
            support=_INSUFFICIENT,
            n_scoreable_incidents=n_scoreable_incidents,
            n_scoreable_windows=0,
            n_buckets_total=len(df),
            n_in_window_buckets=0,
            control_feature=control_feature,
            control_percentile=control_percentile,
            control_intensity_threshold=None,
            movement_floor=movement_floor,
            in_window_single_source_share=None,
            windows_with_negligible_movement=0,
            windows_evaluated=0,
            features=[],
            verdict="insufficient_support: snapshot has no scoreable incident windows to measure against.",
        )

    def _in_window(row) -> bool:
        spans = win_by_game.get(str(row["game_id"]))
        if not spans:
            return False
        a0, a1 = row["_start_sec"], row["_end_sec"]
        # half-open overlap, matches the scorer: a_end > w_start AND a_start < w_end
        return any(a1 > w0 and a0 < w1 for (w0, w1) in spans)

    df["_in_window"] = df.apply(_in_window, axis=1)
    inw = df[df["_in_window"]]
    outw = df[~df["_in_window"]]
    n_in = len(inw)

    # equally-large control: out-of-window buckets in the top tail of the control
    # feature (default intensity).
    out_ctrl = outw[control_feature].to_numpy(dtype=float)
    control_threshold: float | None = None
    if out_ctrl.size and not np.all(np.isnan(out_ctrl)):
        control_threshold = float(np.nanpercentile(out_ctrl[~np.isnan(out_ctrl)], control_percentile))
        control = outw[outw[control_feature] >= control_threshold]
    else:
        control = outw.iloc[0:0]

    # report-level fail-closed: nothing to separate
    if n_in == 0 or len(control) == 0:
        return SeparationReport(
            support=_INSUFFICIENT,
            n_scoreable_incidents=n_scoreable_incidents,
            n_scoreable_windows=n_scoreable_windows,
            n_buckets_total=len(df),
            n_in_window_buckets=n_in,
            control_feature=control_feature,
            control_percentile=control_percentile,
            control_intensity_threshold=control_threshold,
            movement_floor=movement_floor,
            in_window_single_source_share=None,
            windows_with_negligible_movement=_negligible_windows(df, win_by_game, movement_floor),
            windows_evaluated=0,
            features=[],
            verdict=(
                "insufficient_support: no in-window buckets"
                if n_in == 0
                else "insufficient_support: no high-intensity control buckets at this percentile."
            ),
        )

    results: list[FeatureSeparation] = []
    for feat in features:
        if feat not in df.columns:
            results.append(
                FeatureSeparation(
                    feature=feat, support=_INSUFFICIENT, auc_vs_control=None,
                    auc_vs_all_out=None, n_in=n_in, n_control=len(control),
                    n_out_all=len(outw), note="feature column not present in snapshot",
                )
            )
            continue
        col_in = inw[feat].to_numpy(dtype=float)
        if np.all(np.isnan(col_in)) or np.all(np.isnan(df[feat].to_numpy(dtype=float))):
            results.append(
                FeatureSeparation(
                    feature=feat, support=_INSUFFICIENT, auc_vs_control=None,
                    auc_vs_all_out=None, n_in=n_in, n_control=len(control),
                    n_out_all=len(outw), note="feature is all-null",
                )
            )
            continue
        auc_ctrl = rank_auc(col_in, control[feat].to_numpy(dtype=float))
        auc_all = rank_auc(col_in, outw[feat].to_numpy(dtype=float))
        note = (
            "control-defining feature: AUC-vs-control is circular and excluded "
            "from the verdict; a low value confirms incidents are not the largest moves"
            if feat == control_feature
            else ""
        )
        results.append(
            FeatureSeparation(
                feature=feat,
                support=_OK if auc_ctrl is not None else _INSUFFICIENT,
                auc_vs_control=auc_ctrl,
                auc_vs_all_out=auc_all,
                n_in=n_in,
                n_control=len(control),
                n_out_all=len(outw),
                note=note,
            )
        )

    # breadth profile: would a hard min-sources>=2 gate kill recall?
    if "source_count" in inw.columns:
        sc = inw["source_count"].to_numpy(dtype=float)
        single_share = float(np.mean((np.isnan(sc)) | (sc <= 1.0)))
    else:
        single_share = None

    report = SeparationReport(
        support=_OK,
        n_scoreable_incidents=n_scoreable_incidents,
        n_scoreable_windows=n_scoreable_windows,
        n_buckets_total=len(df),
        n_in_window_buckets=n_in,
        control_feature=control_feature,
        control_percentile=control_percentile,
        control_intensity_threshold=control_threshold,
        movement_floor=movement_floor,
        in_window_single_source_share=single_share,
        windows_with_negligible_movement=_negligible_windows(df, win_by_game, movement_floor),
        windows_evaluated=n_scoreable_windows,
        features=results,
    )
    return _with_verdict(report)


def _negligible_windows(
    df: pd.DataFrame, win_by_game: dict[str, list[tuple[int, int]]], movement_floor: float
) -> int:
    """Count scoreable windows whose peak in-window intensity <= movement_floor.

    These are incidents the snapshot-eligible board barely reacted to -- no
    board-volatility model of any kind can catch them; they are the honest
    'insufficient board support' cases.
    """
    count = 0
    for g, spans in win_by_game.items():
        gobs = df[df["game_id"].astype(str) == g]
        for (w0, w1) in spans:
            wb = gobs[(gobs["_end_sec"] > w0) & (gobs["_start_sec"] < w1)]
            if len(wb) == 0:
                count += 1
                continue
            peak = np.nanmax(wb["intensity"].to_numpy(dtype=float))
            if not np.isfinite(peak) or peak <= movement_floor:
                count += 1
    return count


def _with_verdict(report: SeparationReport) -> SeparationReport:
    """Attach a direction-aware verdict, computed over NON-control features.

    A pooled-feature detector is only viable if some feature is ELEVATED in
    incidents (positive separation). A feature that is merely *lower* in incidents
    (negative separation -- incidents smaller/narrower than ordinary big moves)
    does not support firing on that feature and is called out as such.
    """
    mx_abs = report.max_abs_separation()
    mx_pos = report.max_positive_separation()
    if mx_abs is None or mx_pos is None:
        verdict = "no non-control feature could be scored."
    elif mx_abs < 0.1:
        verdict = (
            f"NO pooled feature separates incidents from equally-large non-incident moves "
            f"(max |AUC-0.5| = {mx_abs:.3f} over non-control features); the separating signal "
            f"is not in these features."
        )
    elif mx_pos < 0.1:
        verdict = (
            f"no pooled feature is ELEVATED in incidents (max positive separation "
            f"{mx_pos:.3f}); the only deviations (max |AUC-0.5| = {mx_abs:.3f}) indicate "
            f"incidents are SMALLER / NARROWER than ordinary large moves -- which makes a "
            f"pooled-feature detector harder, not viable."
        )
    elif mx_pos < 0.2:
        verdict = (
            f"weak positive separation (max AUC-0.5 = {mx_pos:.3f} over non-control features); "
            f"a pooled feature is marginally elevated in incidents -- inspect direction before trusting."
        )
    else:
        verdict = (
            f"a pooled feature is elevated in incidents (max AUC-0.5 = {mx_pos:.3f}); "
            f"a pooled-feature detector may be viable -- inspect the per-feature AUCs."
        )
    return SeparationReport(**{**asdict(report), "verdict": verdict,
                               "features": report.features})


def run_separation(
    snapshot_path: str | Path,
    *,
    control_percentile: float = DEFAULT_CONTROL_PERCENTILE,
    control_feature: str = DEFAULT_CONTROL_FEATURE,
    features: tuple[str, ...] = DEFAULT_FEATURES,
    movement_floor: float = DEFAULT_MOVEMENT_FLOOR,
) -> SeparationReport:
    """Load a snapshot's board observations + truth and grade feature separation."""
    truth = load_truth(snapshot_path)
    board = read_board_observations(snapshot_path)
    return feature_separation(
        board, truth,
        control_percentile=control_percentile,
        control_feature=control_feature,
        features=features,
        movement_floor=movement_floor,
    )


def report_to_dict(report: SeparationReport) -> dict:
    """JSON-safe dict (asdict already returns plain types; floats may be None)."""
    return asdict(report)


__all__ = [
    "DEFAULT_FEATURES",
    "DEFAULT_CONTROL_FEATURE",
    "DEFAULT_CONTROL_PERCENTILE",
    "DEFAULT_MOVEMENT_FLOOR",
    "FeatureSeparation",
    "SeparationReport",
    "feature_separation",
    "run_separation",
    "rank_auc",
    "report_to_dict",
]


def _main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(
        prog="python -m nba_sidecar.research.evaluation.separation",
        description="Incident-alignment / feature-separation diagnostic for a snapshot.",
    )
    ap.add_argument("snapshot", help="snapshot directory")
    ap.add_argument(
        "--control-percentile", type=float, default=DEFAULT_CONTROL_PERCENTILE,
        help="intensity percentile (over out-of-window buckets) defining the "
             "equally-large non-incident control set (default 90).",
    )
    ap.add_argument(
        "--movement-floor", type=float, default=DEFAULT_MOVEMENT_FLOOR,
        help="intensity below which an incident window counts as 'no board move' (default 1.0).",
    )
    args = ap.parse_args(argv)
    report = run_separation(
        args.snapshot,
        control_percentile=args.control_percentile,
        movement_floor=args.movement_floor,
    )
    print(json.dumps(report_to_dict(report), indent=2))
    return 0 if report.support == _OK else 1


if __name__ == "__main__":
    raise SystemExit(_main())
