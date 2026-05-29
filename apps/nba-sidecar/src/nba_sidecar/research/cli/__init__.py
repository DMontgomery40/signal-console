"""CLI for the quant-lab research package.

Single entrypoint: ``python -m nba_sidecar.research`` (see
``nba_sidecar/research/__main__.py``), dispatching to the subcommands defined in
:mod:`.main`:

- ``list-models``       -- list registered BoardModel ids + summaries.
- ``run-model``         -- run one model over a snapshot, write a run dir.
- ``score-predictions`` -- validate + score an external predictions.parquet
                           IDENTICALLY to a native model; write a run dir.
- ``compare``           -- run >=2 models over a snapshot; write a leaderboard.
- ``report``            -- (re)render REPORT.md/report.html for an existing run.
- ``doctor``            -- coverage/leakage/scoreability preflight for a snapshot.
"""

from __future__ import annotations

from .main import build_parser, main

__all__ = ["build_parser", "main"]
