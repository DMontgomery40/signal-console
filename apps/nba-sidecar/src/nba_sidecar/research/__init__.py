"""Offline research / quant-lab package for the NBA sidecar.

This package is intentionally decoupled from the live FastAPI service. It exists
so that board-volatility / misattribution detector candidates can be iterated
against the *exported snapshot* (parquet + duckdb) rather than against the live
SQLite database. Nothing in here should ever read SQLite directly; the snapshot
is the contract boundary.

Subpackages
-----------
- ``contracts``: pydantic schemas + documented parquet column specs for snapshot
  rows, model input series, prediction rows, and evaluation outputs. These are
  runtime-agnostic: a predictions.parquet produced by an external R script or
  notebook validates against the same contract as one produced here.
- ``models``: the ``BoardModel`` ABC, a model registry, and seeded real models.

The optional ``[research]`` dependency group (pandas, pyarrow, duckdb, numpy,
matplotlib) must be installed for this package to import. The base sidecar
service does not require it.
"""

from __future__ import annotations
