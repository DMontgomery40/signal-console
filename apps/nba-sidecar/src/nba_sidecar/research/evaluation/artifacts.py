"""Run-artifact writer: predictions, metrics, leaderboard, casebook, report.

Every run lands under
``outputs/nba-quant-lab/runs/<run-id>/`` with:

- ``predictions.parquet`` -- the exact predictions scored (one file per model;
  for a multi-model compare, ``predictions-<model_id>.parquet``).
- ``metrics.json`` -- per-model summary metrics + per-game rollup.
- ``leaderboard.json`` -- the ranked comparison table.
- ``casebook.json`` -- caught / missed / worst-FP cases per model.
- ``REPORT.md`` / ``report.html`` -- human-readable run report.
- ``run-manifest.json`` -- what was run (snapshot, models, params, games,
  versions, timestamp) so a run is reproducible.
"""

from __future__ import annotations

import json
import platform
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .casebook import Casebook
from .scorer import ScoreResultBundle

DEFAULT_RUNS_ROOT = Path(
    "/Users/davidmontgomery/signal-console-quant-lab/outputs/nba-quant-lab/runs"
)

# Leaderboard column order (the headline contract the task asks for).
LEADERBOARD_COLUMNS = (
    "model",
    "incident_recall",  # caught / scoreable
    "incidents_caught",
    "incidents_total",
    "fires_per_game",
    "tape_outlier_recall",
    "burden",  # total fires
    "residual_coverage",
)


def new_run_id(prefix: str = "run") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _round(value, ndigits: int = 4):
    if value is None:
        return None
    return round(float(value), ndigits)


def leaderboard_row(bundle: ScoreResultBundle) -> dict:
    return {
        "model": bundle.model_id,
        "incident_recall": _round(bundle.incident_recall),
        "incidents_caught": bundle.incidents_caught,
        "incidents_total": bundle.incidents_total,
        "fires_per_game": _round(bundle.fires_per_game, 2),
        "tape_outlier_recall": _round(bundle.tape_outlier_recall),
        "burden": bundle.total_fires,
        "residual_coverage": _round(bundle.residual_coverage),
        "per_game_outlier_burden": _round(bundle.per_game_outlier_burden, 2),
    }


def build_leaderboard(bundles: list[ScoreResultBundle]) -> list[dict]:
    rows = [leaderboard_row(b) for b in bundles]
    # rank by incident recall desc, then lower burden, then tape recall desc
    rows.sort(
        key=lambda r: (
            -(r["incident_recall"] or 0.0),
            r["burden"],
            -(r["tape_outlier_recall"] or 0.0),
        )
    )
    return rows


def _leaderboard_markdown(rows: list[dict]) -> str:
    header = (
        "| model | incident recall (caught/scoreable) | fires/game | "
        "tape-outlier recall | burden (total fires) | residual coverage | per-game outlier burden |"
    )
    sep = "|---|---|---|---|---|---|---|"
    lines = [header, sep]
    for r in rows:
        rc = "n/a" if r["residual_coverage"] is None else f"{r['residual_coverage']}"
        pgb = "n/a" if r["per_game_outlier_burden"] is None else f"{r['per_game_outlier_burden']}"
        lines.append(
            f"| {r['model']} | {r['incident_recall']} "
            f"({r['incidents_caught']}/{r['incidents_total']}) | "
            f"{r['fires_per_game']} | {r['tape_outlier_recall']} | "
            f"{r['burden']} | {rc} | {pgb} |"
        )
    return "\n".join(lines)


def _casebook_markdown(casebooks: dict[str, Casebook]) -> str:
    out: list[str] = []
    for model_id, cb in casebooks.items():
        out.append(f"\n### Casebook: `{model_id}`\n")
        out.append(
            f"- caught: {len(cb.caught)} | missed: {len(cb.missed)} | "
            f"worst false positives: {len(cb.worst_false_positives)}\n"
        )
        if cb.missed:
            out.append("\n**Missed incidents (model vs data-absence):**\n")
            for e in cb.missed:
                v = e.source_coverage.get("verdict", "?")
                out.append(f"- `{e.label}` ({e.game_id}) -- verdict: **{v}** "
                           f"({e.source_coverage.get('reason', '')})")
        if cb.caught:
            out.append("\n**Caught incidents:**\n")
            for e in cb.caught:
                out.append(
                    f"- `{e.label}` ({e.game_id}) -- {e.detail['n_fires_in_window']} fire(s) in window"
                )
        if cb.worst_false_positives:
            out.append("\n**Worst false positives (pure burden):**\n")
            for e in cb.worst_false_positives:
                out.append(
                    f"- {e.label} -- score {e.detail['score']:.2f} "
                    f"(coverage verdict: {e.source_coverage.get('verdict')})"
                )
    return "\n".join(out)


def render_report_md(
    *,
    run_id: str,
    snapshot_path: str,
    bundles: list[ScoreResultBundle],
    leaderboard: list[dict],
    casebooks: dict[str, Casebook],
) -> str:
    games = bundles[0].games_evaluated if bundles else []
    lines = [
        f"# Quant-lab run `{run_id}`",
        "",
        f"- snapshot: `{snapshot_path}`",
        f"- models: {', '.join(b.model_id for b in bundles)}",
        f"- games evaluated (with materialized truth): {len(games)}",
        "",
        "## Leaderboard",
        "",
        _leaderboard_markdown(leaderboard),
        "",
        "## Casebook",
        _casebook_markdown(casebooks),
        "",
        "## Notes",
        "",
        "- Scored by JOINING fired buckets to the snapshot's pre-materialized "
        "`score_windows` and `market_outlier_episodes`; scoreability/episodes are "
        "NOT recomputed from board observations.",
        "- Evaluation universe = games carrying at least one scoreable window or "
        "tape episode (NOT the train/test split, which would force incident "
        "recall to 0/0).",
        "- residual coverage = fraction of warmed buckets within the model's own "
        "threshold band; `n/a` for producers that omit threshold diagnostics.",
    ]
    return "\n".join(lines)


def _casebook_markdown_from_dict(casebooks: dict[str, dict]) -> str:
    """Render the casebook section from serialized casebook.json (no re-score)."""
    out: list[str] = []
    for model_id, cb in casebooks.items():
        caught = cb.get("caught", [])
        missed = cb.get("missed", [])
        fps = cb.get("worst_false_positives", [])
        out.append(f"\n### Casebook: `{model_id}`\n")
        out.append(
            f"- caught: {len(caught)} | missed: {len(missed)} | "
            f"worst false positives: {len(fps)}\n"
        )
        if missed:
            out.append("\n**Missed incidents (model vs data-absence):**\n")
            for e in missed:
                cov = e.get("source_coverage", {})
                out.append(
                    f"- `{e['label']}` ({e['game_id']}) -- verdict: "
                    f"**{cov.get('verdict', '?')}** ({cov.get('reason', '')})"
                )
        if caught:
            out.append("\n**Caught incidents:**\n")
            for e in caught:
                out.append(
                    f"- `{e['label']}` ({e['game_id']}) -- "
                    f"{e['detail'].get('n_fires_in_window')} fire(s) in window"
                )
        if fps:
            out.append("\n**Worst false positives (pure burden):**\n")
            for e in fps:
                cov = e.get("source_coverage", {})
                out.append(
                    f"- {e['label']} -- score {e['detail'].get('score'):.2f} "
                    f"(coverage verdict: {cov.get('verdict')})"
                )
    return "\n".join(out)


def render_report_md_from_artifacts(
    *, metrics: dict, leaderboard: list[dict], casebooks: dict[str, dict]
) -> str:
    """Rebuild the FULL report (leaderboard + casebook) from on-disk artifacts.

    Used by the ``report`` subcommand so re-rendering is non-destructive: it
    reproduces the same sections ``render_report_md`` produces, sourced from the
    persisted ``metrics.json`` / ``leaderboard.json`` / ``casebook.json`` rather
    than from a fresh scoring run.
    """
    games = []
    models = metrics.get("models", {})
    if models:
        first = next(iter(models.values()))
        games = [g["game_id"] for g in first.get("per_game", [])]
    lines = [
        f"# Quant-lab run `{metrics.get('run_id')}`",
        "",
        f"- snapshot: `{metrics.get('snapshot')}`",
        f"- models: {', '.join(models.keys())}",
        f"- games evaluated (with materialized truth): {len(games)}",
        "",
        "## Leaderboard",
        "",
        _leaderboard_markdown(leaderboard),
        "",
        "## Casebook",
        _casebook_markdown_from_dict(casebooks),
    ]
    return "\n".join(lines)


def render_report_html(report_md: str, leaderboard: list[dict]) -> str:
    # minimal, dependency-free HTML wrapper around the markdown text + table.
    rows_html = "".join(
        "<tr>"
        f"<td>{r['model']}</td>"
        f"<td>{r['incident_recall']} ({r['incidents_caught']}/{r['incidents_total']})</td>"
        f"<td>{r['fires_per_game']}</td>"
        f"<td>{r['tape_outlier_recall']}</td>"
        f"<td>{r['burden']}</td>"
        f"<td>{'n/a' if r['residual_coverage'] is None else r['residual_coverage']}</td>"
        "</tr>"
        for r in leaderboard
    )
    table = (
        "<table border='1' cellpadding='6' cellspacing='0'>"
        "<tr><th>model</th><th>incident recall (caught/scoreable)</th>"
        "<th>fires/game</th><th>tape-outlier recall</th>"
        "<th>burden</th><th>residual coverage</th></tr>"
        f"{rows_html}</table>"
    )
    pre = report_md.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>quant-lab run</title>"
        "<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:60rem}"
        "table{border-collapse:collapse}pre{background:whitesmoke;padding:1rem;overflow:auto}"
        "</style></head><body>"
        "<h1>Leaderboard</h1>"
        f"{table}"
        "<h1>Full report</h1>"
        f"<pre>{pre}</pre>"
        "</body></html>"
    )


@dataclass(frozen=True)
class RunArtifacts:
    run_dir: Path
    run_id: str


def write_run(
    *,
    runs_root: str | Path | None,
    run_id: str | None,
    snapshot_path: str,
    bundles: list[ScoreResultBundle],
    casebooks: dict[str, Casebook],
    predictions: dict[str, pd.DataFrame],
    params: dict[str, dict] | None = None,
    command: str = "",
) -> RunArtifacts:
    """Write the full artifact set for a run; return the run directory."""
    root = Path(runs_root) if runs_root else DEFAULT_RUNS_ROOT
    rid = run_id or new_run_id()
    run_dir = root / rid
    run_dir.mkdir(parents=True, exist_ok=True)

    # predictions: one parquet per model, PLUS a combined predictions.parquet
    # (required artifact) that carries a model_id column. For single-model runs
    # the combined file is just that model's frame with the column added.
    combined_frames: list[pd.DataFrame] = []
    for model_id, df in predictions.items():
        df.to_parquet(run_dir / f"predictions-{model_id}.parquet", index=False)
        tagged = df.copy()
        tagged.insert(0, "model_id", model_id)
        combined_frames.append(tagged)
    if combined_frames:
        pd.concat(combined_frames, ignore_index=True).to_parquet(
            run_dir / "predictions.parquet", index=False
        )

    leaderboard = build_leaderboard(bundles)

    metrics = {
        "run_id": rid,
        "snapshot": snapshot_path,
        "models": {
            b.model_id: {
                "summary": b.summary_dict(),
                "per_game": [
                    {
                        "game_id": g.game_id,
                        "fired_buckets": g.fired_buckets,
                        "warmed_buckets": g.warmed_buckets,
                        "total_buckets": g.total_buckets,
                        "incidents_total": g.incidents_total,
                        "incidents_caught": g.incidents_caught,
                        "episodes_total": g.episodes_total,
                        "episodes_caught": g.episodes_caught,
                    }
                    for g in b.per_game
                ],
            }
            for b in bundles
        },
    }
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (run_dir / "leaderboard.json").write_text(json.dumps(leaderboard, indent=2))
    (run_dir / "casebook.json").write_text(
        json.dumps({mid: cb.to_dict() for mid, cb in casebooks.items()}, indent=2)
    )

    report_md = render_report_md(
        run_id=rid,
        snapshot_path=snapshot_path,
        bundles=bundles,
        leaderboard=leaderboard,
        casebooks=casebooks,
    )
    (run_dir / "REPORT.md").write_text(report_md)
    (run_dir / "report.html").write_text(render_report_html(report_md, leaderboard))

    manifest = {
        "run_id": rid,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "command": command,
        "snapshot": snapshot_path,
        "models": [b.model_id for b in bundles],
        "params": params or {},
        "games_evaluated": bundles[0].games_evaluated if bundles else [],
        "python": sys.version,
        "platform": platform.platform(),
    }
    (run_dir / "run-manifest.json").write_text(json.dumps(manifest, indent=2))

    return RunArtifacts(run_dir=run_dir, run_id=rid)


__all__ = [
    "DEFAULT_RUNS_ROOT",
    "LEADERBOARD_COLUMNS",
    "new_run_id",
    "build_leaderboard",
    "render_report_md",
    "render_report_md_from_artifacts",
    "render_report_html",
    "write_run",
    "RunArtifacts",
]
