"""doctor: coverage / leakage / scoreability preflight for a snapshot.

Run before trusting any evaluation. It reads the materialized truth tables
(including ``source_coverage``) and reports:

- **scoreability**: how many incidents are scoreable, how many have a catch
  window, and whether every scoreable incident actually has a window to score
  against (a scoreable incident with no window is a silent 0-recall trap).
- **coverage**: distribution of ``source_coverage.class`` and how many games
  have at least one canonical/eligible window (games with no canonical coverage
  can only ever be data-absence misses).
- **leakage / split sanity**: whether incident games sit in the train split (the
  snapshot forces them there) and therefore why the evaluation universe must be
  truth-bearing games, not the test holdout.
- **tape episodes**: episode count and games covered.

Returns a structured dict (also pretty-printed by the CLI). ``ok`` is False if a
blocking inconsistency is found (e.g. a scoreable incident with no window).
"""

from __future__ import annotations

from pathlib import Path

from .truth import SnapshotTruth, load_truth


def run_doctor(snapshot_path: str | Path, truth: SnapshotTruth | None = None) -> dict:
    truth = truth or load_truth(snapshot_path)
    inc = truth.incidents
    sw = truth.score_windows
    moe = truth.market_outlier_episodes
    sc = truth.source_coverage

    scoreable_ids = truth.scoreable_incident_ids
    window_ids = set(sw["incident_id"].astype(str))
    scoreable_without_window = sorted(scoreable_ids - window_ids)
    window_without_incident = sorted(window_ids - set(inc["incident_id"].astype(str)))

    cov_classes = sc["class"].astype(str).value_counts().to_dict()
    games_canonical = set(
        sc.loc[sc["class"].astype(str).isin(["canonical", "snapshot_eligible"]), "game_id"].astype(str)
    )
    truth_games = truth.games_with_truth()
    truth_games_no_canonical = sorted(truth_games - games_canonical)

    findings: list[str] = []
    ok = True
    if scoreable_without_window:
        ok = False
        findings.append(
            f"BLOCKING: {len(scoreable_without_window)} scoreable incidents have no "
            f"score_window (would silently score 0): {scoreable_without_window}"
        )
    if window_without_incident:
        findings.append(
            f"WARN: {len(window_without_incident)} score_windows reference unknown "
            f"incidents: {window_without_incident}"
        )
    if truth_games_no_canonical:
        findings.append(
            f"INFO: {len(truth_games_no_canonical)} truth-bearing games lack "
            f"canonical/eligible coverage; misses there read as data-absence."
        )

    return {
        "ok": ok,
        "snapshot": str(snapshot_path),
        "scoreability": {
            "incidents_total": int(len(inc)),
            "incidents_scoreable": int(len(scoreable_ids)),
            "score_windows": int(len(sw)),
            "scoreable_with_window": int(len(scoreable_ids & window_ids)),
            "scoreable_without_window": scoreable_without_window,
        },
        "coverage": {
            "class_distribution": {str(k): int(v) for k, v in cov_classes.items()},
            "games_with_canonical_coverage": int(len(games_canonical)),
            "truth_games": int(len(truth_games)),
            "truth_games_without_canonical_coverage": truth_games_no_canonical,
        },
        "tape_episodes": {
            "episodes_total": int(len(moe)),
            "games_with_episodes": int(moe["game_id"].astype(str).nunique()),
        },
        "leakage_note": (
            "Incident games are forced into the train split by snapshot design; "
            "evaluate over truth-bearing games, not the test holdout, or incident "
            "recall is 0/0 by construction."
        ),
        "findings": findings,
    }


__all__ = ["run_doctor"]
