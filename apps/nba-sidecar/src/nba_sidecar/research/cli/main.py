"""argparse CLI implementation for ``python -m nba_sidecar.research``."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ..evaluation import (
    build_leaderboard,
    evaluate_external,
    evaluate_model,
    load_truth,
    run_doctor,
)
from ..evaluation.artifacts import (
    new_run_id,
    render_report_html,
    render_report_md_from_artifacts,
    write_run,
)
from ..attribution_snapshot import evaluate_snapshot
from ..evaluation.separation import report_to_dict, run_separation
from ..models import get_model, list_models as registry_list_models
from .bootstrap import (
    DEFAULT_NOTEBOOK_PATH,
    DEFAULT_SNAPSHOT_PATH,
    write_notebook,
)


def _parse_params(raw: str | None) -> dict:
    if not raw:
        return {}
    return json.loads(raw)


def _print_json(obj: object) -> None:
    print(json.dumps(obj, indent=2))


# ---------------------------------------------------------------------------
# subcommands
# ---------------------------------------------------------------------------


def cmd_list_models(args: argparse.Namespace) -> int:
    out = []
    for mid in registry_list_models():
        m = get_model(mid)
        out.append({"id": m.id, "name": m.name, "family": m.family, "summary": m.summary})
    if args.json:
        _print_json(out)
    else:
        for m in out:
            print(f"{m['id']:24s} [{m['family']}] {m['name']}")
            print(f"    {m['summary']}")
    return 0


def cmd_run_model(args: argparse.Namespace) -> int:
    truth = load_truth(args.snapshot)
    params = _parse_params(args.params)
    bundle, casebook, preds = evaluate_model(
        args.model, args.snapshot, params=params, truth=truth
    )
    art = write_run(
        runs_root=args.runs_root,
        run_id=args.run_id or new_run_id("run"),
        snapshot_path=str(args.snapshot),
        bundles=[bundle],
        casebooks={bundle.model_id: casebook},
        predictions={bundle.model_id: preds},
        params={args.model: params},
        command=f"run-model {args.model} {args.snapshot}",
    )
    print(f"run: {art.run_dir}")
    _print_json(bundle.summary_dict())
    return 0


def cmd_score_predictions(args: argparse.Namespace) -> int:
    truth = load_truth(args.snapshot)
    bundle, casebook, preds = evaluate_external(
        args.predictions, args.snapshot, model_id=args.model_id, truth=truth
    )
    art = write_run(
        runs_root=args.runs_root,
        run_id=args.run_id or new_run_id("ext"),
        snapshot_path=str(args.snapshot),
        bundles=[bundle],
        casebooks={bundle.model_id: casebook},
        predictions={bundle.model_id: preds},
        params={args.model_id: {"source": str(args.predictions)}},
        command=f"score-predictions {args.predictions} {args.snapshot}",
    )
    print(f"run: {art.run_dir}")
    _print_json(bundle.summary_dict())
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    if len(args.models) < 2:
        print("compare needs >=2 models", file=sys.stderr)
        return 2
    truth = load_truth(args.snapshot)
    bundles = []
    casebooks = {}
    predictions = {}
    for mid in args.models:
        bundle, casebook, preds = evaluate_model(mid, args.snapshot, truth=truth)
        bundles.append(bundle)
        casebooks[mid] = casebook
        predictions[mid] = preds
    art = write_run(
        runs_root=args.runs_root,
        run_id=args.run_id or new_run_id("compare"),
        snapshot_path=str(args.snapshot),
        bundles=bundles,
        casebooks=casebooks,
        predictions=predictions,
        params={mid: {} for mid in args.models},
        command=f"compare {' '.join(args.models)} {args.snapshot}",
    )
    leaderboard = build_leaderboard(bundles)
    print(f"run: {art.run_dir}")
    _print_json(leaderboard)
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    leaderboard = json.loads((run_dir / "leaderboard.json").read_text())
    metrics = json.loads((run_dir / "metrics.json").read_text())
    casebooks = json.loads((run_dir / "casebook.json").read_text())
    # Rebuild the FULL report (leaderboard + casebook) from persisted artifacts;
    # non-destructive -- reproduces the same sections write_run emitted.
    report_md = render_report_md_from_artifacts(
        metrics=metrics, leaderboard=leaderboard, casebooks=casebooks
    )
    (run_dir / "REPORT.md").write_text(report_md)
    (run_dir / "report.html").write_text(render_report_html(report_md, leaderboard))
    print(f"re-rendered: {run_dir / 'REPORT.md'}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    result = run_doctor(args.snapshot)
    _print_json(result)
    return 0 if result["ok"] else 1


def cmd_separation(args: argparse.Namespace) -> int:
    report = run_separation(
        args.snapshot,
        control_percentile=args.control_percentile,
        movement_floor=args.movement_floor,
    )
    _print_json(report_to_dict(report))
    return 0 if report.support == "ok" else 1


def cmd_attribution_eval(args: argparse.Namespace) -> int:
    # Run the snapshot-backed signed-paired re-ranker over incident truth and emit
    # outputs/nba-quant-lab/attribution_reranker.json (the /research portal reads it).
    registry = json.loads(Path(args.registry).read_text())
    raw = registry.get("incidents", registry) if isinstance(registry, dict) else registry
    incidents = []
    for inc in raw if isinstance(raw, list) else []:
        gid = inc.get("gameId", "")
        if not gid or not inc.get("utcTime"):
            continue
        incidents.append(
            {
                "id": inc.get("id"),
                "game_id": gid if gid.startswith("nba-") else f"nba-{gid}",
                "credited_player": inc.get("creditedPlayer", ""),
                "rightful_player": inc.get("rightfulPlayer", ""),
                "event_iso": inc.get("utcTime", ""),
            }
        )
    report = evaluate_snapshot(args.snapshot, incidents, line_select=args.line_select)
    report["line_select"] = args.line_select
    report["n_incidents"] = len(incidents)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, default=str))
    print(f"wrote {out} ({len(incidents)} incidents, line_select={args.line_select})")
    _print_json({k: report[k] for k in ("overall", "player_swap", "team_dispute")})
    return 0


def cmd_far_calibration(args: argparse.Namespace) -> int:
    # Falsification test for the signed-paired re-ranker: fire-rate on assumed-
    # negative (non-incident) games. Reads prop ticks from the snapshot + PBP from
    # the gold DB (read-only) to generate candidate pairs, scores them through the
    # SAME path incidents use, and writes far_calibration.json (the /research
    # portal reads it alongside attribution_reranker.json). Front<->back fabric.
    import sqlite3

    import pyarrow.parquet as pq

    from ..attribution_snapshot import _epoch, last_name
    from ..far_calibration import (
        harvested_label_specs,
        incident_recall_matched,
        merge_incident_specs,
        oncourt_quality,
        score_control_pairs,
        summarize_far,
    )
    from ..loader import read_player_prop_ticks

    snap = args.snapshot
    ticks = read_player_prop_ticks(snap)
    inc = pq.read_table(str(Path(snap) / "incidents.parquet")).to_pandas()
    inc_games = set(inc["canonical_game_id"].dropna())
    epi = pq.read_table(str(Path(snap) / "market_outlier_episodes.parquet")).to_pandas()
    epi_games = set(epi["game_id"].dropna())
    control = sorted(set(ticks["game_id"].unique()) - inc_games)

    pbp_cols = (
        "SELECT action_number, action_type, sub_type, person_id, team_tricode, "
        "player_name, period, clock, time_actual FROM nba_play_by_play_actions "
        "WHERE game_id=? ORDER BY action_number"
    )
    conn = sqlite3.connect(f"file:{args.gold}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    def load_pbp(game_ids: list[str]) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for gid in game_ids:
            rows = conn.execute(pbp_cols, (gid,)).fetchall()
            if rows:
                out[gid] = [dict(r) for r in rows]
        return out

    pbp = load_pbp(control)

    # Matched recall: push player_swap incidents through the SAME candidate path so
    # TPR and FAR share an operating point. Incident games' prop ticks are in the
    # snapshot (truth-bearing is always exported); PBP comes from gold.
    registry_specs = []
    for _, r in inc[inc["scoreable"] == True].iterrows():  # noqa: E712 (pandas mask)
        credited_str = str(r["credited_player"])
        cl, rl = last_name(credited_str), last_name(str(r["rightful_player"]))
        ev = r.get("event_sec")
        stat = str(r.get("stat", "")).lower()
        if not rl or ev is None:
            continue
        # player_swap (cl present) OR TEAM-credited rebound (cl == "" but credited is
        # a TEAM rebound string) — the latter gets the one-legged TEAM branch.
        is_team_rebound = not cl and "team" in credited_str.lower() and "rebound" in stat
        if cl or is_team_rebound:
            registry_specs.append(
                {
                    "id": r.get("incident_id"),
                    "game_id": r["canonical_game_id"],
                    "credited_last": cl,
                    "rightful_last": rl,
                    "event_epoch": float(ev),
                }
            )
    # Close the label loop: merge harvested labels (credited->rightful corrections
    # recovered by the revision harvester) so they flow into recall as they accrue.
    harvested_path = Path(args.harvested)
    harvested_report = json.loads(harvested_path.read_text()) if harvested_path.exists() else {}
    harvested = harvested_label_specs(harvested_report)
    merge = merge_incident_specs(registry_specs, harvested)
    specs = merge["specs"]
    incident_pbp = load_pbp(sorted({s["game_id"] for s in specs}))
    conn.close()

    quality = oncourt_quality(pbp)
    scored = score_control_pairs(ticks, pbp, line_select=args.line_select)
    all_summary = summarize_far(scored)
    pure = summarize_far([r for r in scored if r["game_id"] not in epi_games])
    recall = incident_recall_matched(ticks, incident_pbp, specs, line_select=args.line_select)
    report = {
        "snapshot": snap,
        "line_select": args.line_select,
        "n_control_games": len(pbp),
        "n_pure_control_games": len(set(pbp) - epi_games),
        "data_quality": quality,
        "all_control": all_summary,
        "pure_control": pure,
        "incident_sources": {
            "n_registry": merge["n_registry"],
            "n_harvested_added": merge["n_harvested_added"],
            "n_harvested_duplicate": merge["n_harvested_duplicate"],
        },
        "matched_recall": recall,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, default=str))
    print(f"wrote {out} ({len(pbp)} control games, {recall['n_scored']}/{recall['n_incidents']} scoreable incidents)")
    _print_json(
        {
            "all_control": {k: all_summary[k] for k in ("n_scored_pairs", "abstention_rate", "per_rebound_far")},
            "pure_control": {k: pure[k] for k in ("n_scored_pairs", "per_rebound_far")},
            "matched_recall": {
                k: recall[k]
                for k in ("n_incidents", "n_matched", "n_rightful_oncourt", "n_scored", "tpr_per_pair", "rank_by_prior", "rank_by_score")
            },
            "incident_sources": report["incident_sources"],
            "data_quality": quality,
        }
    )
    return 0


def cmd_emit_models(args: argparse.Namespace) -> int:
    # Emit outputs/nba-quant-lab/models.json from the registry so the /research
    # "Model lab" surfaces the REAL registered models (the API's getResearchModels
    # reads this file and otherwise falls back to a static list). Front<->back
    # fabric: python registry -> models.json -> GET /v1/research/models -> UI.
    out = Path(args.out)
    models = []
    for mid in registry_list_models():
        m = get_model(mid)
        models.append({"id": m.id, "label": m.name, "description": m.summary, "family": m.family})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"models": models}, indent=2))
    print(f"wrote {out} ({len(models)} models)")
    return 0


def cmd_bootstrap(args: argparse.Namespace) -> int:
    notebook_path = Path(args.out) if args.out else DEFAULT_NOTEBOOK_PATH
    snapshot_path = Path(args.snapshot) if args.snapshot else DEFAULT_SNAPSHOT_PATH
    written = write_notebook(notebook_path=notebook_path, snapshot_path=snapshot_path)
    print(f"wrote: {written}")
    print(f"snapshot: {snapshot_path}")
    print(
        "execute headless with:\n"
        f"  python -m jupyter nbconvert --to notebook --execute --inplace {written}"
    )
    return 0


# ---------------------------------------------------------------------------
# parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m nba_sidecar.research",
        description="NBA quant-lab research CLI (models + evaluation against snapshot truth).",
    )
    sub = p.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list-models", help="list registered BoardModels")
    p_list.add_argument("--json", action="store_true")
    p_list.set_defaults(func=cmd_list_models)

    p_run = sub.add_parser("run-model", help="run one model over a snapshot")
    p_run.add_argument("model")
    p_run.add_argument("snapshot")
    p_run.add_argument("--params", help="JSON param overrides", default=None)
    p_run.add_argument("--run-id", default=None)
    p_run.add_argument("--runs-root", default=None)
    p_run.set_defaults(func=cmd_run_model)

    p_score = sub.add_parser(
        "score-predictions",
        help="validate + score an external predictions.parquet identically to a model",
    )
    p_score.add_argument("predictions")
    p_score.add_argument("snapshot")
    p_score.add_argument("--model-id", default="external")
    p_score.add_argument("--run-id", default=None)
    p_score.add_argument("--runs-root", default=None)
    p_score.set_defaults(func=cmd_score_predictions)

    p_cmp = sub.add_parser("compare", help="run >=2 models and emit a leaderboard")
    p_cmp.add_argument("models", nargs="+")
    p_cmp.add_argument("--snapshot", required=True)
    p_cmp.add_argument("--run-id", default=None)
    p_cmp.add_argument("--runs-root", default=None)
    p_cmp.set_defaults(func=cmd_compare)

    p_rep = sub.add_parser("report", help="(re)render REPORT.md/report.html for a run dir")
    p_rep.add_argument("run_dir")
    p_rep.set_defaults(func=cmd_report)

    p_doc = sub.add_parser("doctor", help="coverage/leakage/scoreability preflight")
    p_doc.add_argument("snapshot")
    p_doc.set_defaults(func=cmd_doctor)

    p_sep = sub.add_parser(
        "separation",
        help="incident-alignment: does any feature separate incidents from equally-large non-incident moves?",
    )
    p_sep.add_argument("snapshot")
    p_sep.add_argument(
        "--control-percentile", type=float, default=90.0,
        help="intensity percentile defining the equally-large non-incident control set (default 90)",
    )
    p_sep.add_argument(
        "--movement-floor", type=float, default=1.0,
        help="intensity below which an incident window counts as 'no board move' (default 1.0)",
    )
    p_sep.set_defaults(func=cmd_separation)

    p_attr = sub.add_parser(
        "attribution-eval",
        help="run the signed-paired attribution re-ranker over incident truth; emit attribution_reranker.json",
    )
    p_attr.add_argument("snapshot")
    p_attr.add_argument(
        "--registry", default="outputs/nba-detector-bakeoff/research/incident-registry-expanded.json"
    )
    p_attr.add_argument("--out", default="outputs/nba-quant-lab/attribution_reranker.json")
    p_attr.add_argument(
        "--line-select", default="aggregate_drift",
        choices=["most_active", "closest_to_half", "aggregate_drift"],
    )
    p_attr.set_defaults(func=cmd_attribution_eval)

    p_far = sub.add_parser(
        "far-calibration",
        help="false-alarm-rate of the re-ranker on non-incident control games; emit far_calibration.json",
    )
    p_far.add_argument("snapshot")
    p_far.add_argument(
        "--gold",
        # Config-driven: the GOLD_DB_PATH / SIGNAL_CONSOLE_DB_PATH env (the same the
        # TS scripts + packages/db use), else the canonical home-relative gold DB.
        default=(
            os.environ.get("GOLD_DB_PATH")
            or os.environ.get("SIGNAL_CONSOLE_DB_PATH")
            or str(Path.home() / "signal-console" / "data" / "signal-console.sqlite")
        ),
        help="gold DB path (read-only) for control-game PBP; overrides GOLD_DB_PATH env",
    )
    p_far.add_argument("--out", default="outputs/nba-quant-lab/far_calibration.json")
    p_far.add_argument(
        "--harvested",
        default="outputs/nba-quant-lab/harvested_incidents.json",
        help="harvested-label file merged into matched-recall incidents (closes the label loop)",
    )
    p_far.add_argument(
        "--line-select", default="aggregate_drift",
        choices=["most_active", "closest_to_half", "aggregate_drift"],
    )
    p_far.set_defaults(func=cmd_far_calibration)

    p_em = sub.add_parser(
        "emit-models",
        help="write outputs/nba-quant-lab/models.json from the registry (surfaces models in the /research Model lab)",
    )
    p_em.add_argument("--out", default="outputs/nba-quant-lab/models.json")
    p_em.set_defaults(func=cmd_emit_models)

    p_boot = sub.add_parser(
        "bootstrap",
        help="write notebooks/quant-lab-starter.ipynb (runnable starter notebook)",
    )
    p_boot.add_argument(
        "--out",
        default=None,
        help="notebook output path (default: <repo>/notebooks/quant-lab-starter.ipynb)",
    )
    p_boot.add_argument(
        "--snapshot",
        default=None,
        help="snapshot dir the notebook opens (default: outputs/.../snapshots/sample-fixed)",
    )
    p_boot.set_defaults(func=cmd_bootstrap)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


__all__ = ["build_parser", "main"]
