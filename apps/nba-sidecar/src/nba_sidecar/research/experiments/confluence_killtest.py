"""Whole-board CONFLUENCE separation kill-test (pre-registered falsification gate).

Question this answers (cheaply, read-only, BEFORE any model is built):
  Do labeled stat-misattribution incidents show MORE per-prop co-occurrence
  (distinct props moving/volume-spiking together in the same short window) than
  equally-busy non-incident moments IN THE SAME GAME?

If yes (per-incident standout decisively above chance), a confluence model is
worth building. If no, the per-prop-structure hypothesis is falsified here and
we do NOT build it (honest kill). Passing this gate is NECESSARY, not sufficient,
for the real bar (>=70% recall at <=3:1 FP).

================  PRE-REGISTERED PARAMETERS (frozen 2026-06-01)  ================
These thresholds were fixed BEFORE inspecting any incident outcome, to prevent
tuning the result into existence (the contamination that fooled an earlier eval).
Window = 60s: the repo's canonical board-volatility runtime bucket
(docs/board-volatility-state-space.md, bucketSeconds=60) and robust to the
heterogeneous corpus (1-min historical backfill + sub-second live capture).
Data semantics per source: see memory quote-tick-data-semantics.
===============================================================================

Read-only. Never writes the gold DB. Config-driven paths (no hardcoding):
  SIGNAL_CONSOLE_DB_PATH | GOLD_DB_PATH  (else ~/signal-console/data/signal-console.sqlite)
  INCIDENT_REGISTRY_PATH | --registry    (else ~/signal-console/outputs/nba-detector-bakeoff/research/incident-registry-expanded.json)
  RESEARCH_OUTPUT_ROOT   | --out         (else ~/signal-console/outputs/nba-quant-lab)

Run (after the corpus is complete):
  cd apps/nba-sidecar && uv run python -m nba_sidecar.research.experiments.confluence_killtest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import statistics
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

MAD_SCALE = 1.4826


@dataclass(frozen=True)
class Params:
    """Frozen 2026-06-01 before any incident outcome was inspected."""

    window_sec: int = 60
    price_k: float = 3.0  # MAD multiplier for the per-prop price residual
    price_floor: float = 0.02  # never flag a |Δprob| below this (sub-2-point noise)
    price_nohist_floor: float = 0.04  # flag threshold when <price_min_hist prior moves
    price_min_hist: int = 3
    vol_ratio: float = 2.0  # "doubled": per-interval volume vs the prop's trailing median
    vol_floor: float = 10.0  # min per-interval volume to consider a volume anomaly
    vol_min_hist: int = 3
    incident_half_window_sec: int = 60  # incident span = event ± this
    control_percentile: float = 90.0
    min_confluence: int = 2  # a 1-prop "coincidence" is not a coincidence
    null_p: float = 0.10  # P(single block beats its game's 90th pct) under H0
    min_eval_incidents: int = 10  # KILL if fewer incidents have usable data


# ----------------------------------------------------------------------------
# Pure functions (unit-tested in tests/test_confluence_killtest.py)
# ----------------------------------------------------------------------------
def parse_epoch(s: str) -> float:
    """ISO8601 (with 'Z' and variable fractional seconds) -> epoch seconds."""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        # Trim odd fractional precision and retry.
        if "." in s:
            head, _, tail = s.partition(".")
            frac = "".join(ch for ch in tail if ch.isdigit())[:6]
            off = tail[len(frac.rstrip("0")) :] if False else ""  # noqa
            tz = "+00:00" if "+" not in tail else "+" + tail.split("+", 1)[1]
            return datetime.fromisoformat(f"{head}.{frac or '0'}{tz}").timestamp()
        raise


def per_interval_volumes(vols: list[Optional[float]]) -> list[Optional[float]]:
    """Normalize a prop's volume series to PER-INTERVAL volume.

    Kalshi candle volume is already per-interval (bursty); Polymarket volume is a
    cumulative market total. Detect cumulative (monotonic non-decreasing) and use
    positive deltas; otherwise treat values as per-interval levels.
    """
    present = [v for v in vols if v is not None]
    cumulative = (
        len(present) >= 2
        and all(present[i] >= present[i - 1] for i in range(1, len(present)))
        and present[-1] > present[0]
    )
    if not cumulative:
        return list(vols)
    out: list[Optional[float]] = []
    prev: Optional[float] = None
    for v in vols:
        if v is None:
            out.append(None)
            continue
        out.append(None if prev is None else max(0.0, v - prev))
        prev = v
    return out


def _mad(xs: list[float]) -> float:
    if not xs:
        return 0.0
    med = statistics.median(xs)
    return statistics.median([abs(x - med) for x in xs])


def detect_prop_anomalies(
    epochs: list[float],
    probs: list[float],
    vols_interval: list[Optional[float]],
    p: Params,
) -> list[float]:
    """Return the epochs at which a prop had a price OR volume anomaly.

    Causal: each tick i is judged only against the prop's own ticks 0..i-1.
    Price anomaly: |Δprob| beyond the prop's own trailing-MAD expectation (or a
    fixed floor when too little history) — surprising-given-baseline, not merely
    large. Volume anomaly: per-interval volume >= vol_ratio × trailing median.
    """
    n = len(epochs)
    events: list[float] = []
    price_deltas: list[float] = []  # history of |Δprob| (index-aligned to pairs)
    pos_vols: list[float] = []  # history of positive per-interval volumes
    prev_prob: Optional[float] = None
    for i in range(n):
        price_anom = False
        if prev_prob is not None:
            d = abs(probs[i] - prev_prob)
            if len(price_deltas) >= p.price_min_hist:
                thr = max(p.price_floor, p.price_k * MAD_SCALE * _mad(price_deltas))
            else:
                thr = p.price_nohist_floor
            price_anom = d >= thr
            price_deltas.append(d)
        prev_prob = probs[i]

        vol_anom = False
        v = vols_interval[i]
        if v is not None and v >= p.vol_floor and len(pos_vols) >= p.vol_min_hist:
            med = statistics.median(pos_vols)
            vol_anom = med > 0 and v >= p.vol_ratio * med
        if v is not None and v > 0:
            pos_vols.append(v)

        if price_anom or vol_anom:
            events.append(epochs[i])
    return events


def floor_win(epoch: float, window_sec: int) -> int:
    return int(math.floor(epoch / window_sec) * window_sec)


def confluence_by_window(
    anoms_by_prop: dict[str, list[float]],
    ticks_by_prop: dict[str, list[float]],
    window_sec: int,
) -> dict[int, tuple[int, int]]:
    """window_start -> (confluence_count = distinct anomalous props, active = distinct props with any tick)."""
    anom: dict[int, set] = defaultdict(set)
    active: dict[int, set] = defaultdict(set)
    for prop, es in anoms_by_prop.items():
        for e in es:
            anom[floor_win(e, window_sec)].add(prop)
    for prop, es in ticks_by_prop.items():
        for e in es:
            active[floor_win(e, window_sec)].add(prop)
    out: dict[int, tuple[int, int]] = {}
    for win in set(anom) | set(active):
        out[win] = (len(anom.get(win, set())), len(active.get(win, set())))
    return out


def span_windows(center_epoch: float, half_sec: int, window_sec: int) -> list[int]:
    lo = floor_win(center_epoch - half_sec, window_sec)
    hi = floor_win(center_epoch + half_sec, window_sec)
    return list(range(lo, hi + window_sec, window_sec))


def peak_confluence(conf: dict[int, tuple[int, int]], wins: list[int]) -> int:
    return max((conf.get(w, (0, 0))[0] for w in wins), default=0)


def control_block_maxima(
    conf: dict[int, tuple[int, int]],
    grid: list[int],
    incident_wins: set[int],
    k: int,
) -> list[int]:
    """Max confluence over each sliding block of k consecutive grid windows that
    does NOT overlap any incident window — the apples-to-apples null for an
    incident's 'max over its k windows' statistic."""
    counts = [conf.get(w, (0, 0))[0] for w in grid]
    maxima: list[int] = []
    for i in range(0, len(grid) - k + 1):
        block = grid[i : i + k]
        if any(w in incident_wins for w in block):
            continue
        maxima.append(max(counts[i : i + k]))
    return maxima


def percentile(xs: list[float], pct: float) -> float:
    if not xs:
        return float("nan")
    ys = sorted(xs)
    if len(ys) == 1:
        return float(ys[0])
    rank = (pct / 100.0) * (len(ys) - 1)
    lo = math.floor(rank)
    hi = math.ceil(rank)
    if lo == hi:
        return float(ys[lo])
    return float(ys[lo] + (ys[hi] - ys[lo]) * (rank - lo))


def binom_sf(k: int, n: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p)."""
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))


def mann_whitney_auc(pos: list[float], neg: list[float]) -> float:
    """Rank-AUC = P(random pos > random neg), ties counted as 0.5."""
    if not pos or not neg:
        return float("nan")
    wins = 0.0
    for a in pos:
        for b in neg:
            if a > b:
                wins += 1.0
            elif a == b:
                wins += 0.5
    return wins / (len(pos) * len(neg))


# ----------------------------------------------------------------------------
# Config resolution (no hardcoding — env first, home-based fallback like open.ts)
# ----------------------------------------------------------------------------
def resolve_db_path() -> str:
    return (
        os.environ.get("SIGNAL_CONSOLE_DB_PATH")
        or os.environ.get("GOLD_DB_PATH")
        or str(Path.home() / "signal-console" / "data" / "signal-console.sqlite")
    )


def resolve_registry_path(arg: Optional[str]) -> str:
    return (
        arg
        or os.environ.get("INCIDENT_REGISTRY_PATH")
        or str(
            Path.home()
            / "signal-console"
            / "outputs"
            / "nba-detector-bakeoff"
            / "research"
            / "incident-registry-expanded.json"
        )
    )


def resolve_out_root(arg: Optional[str]) -> str:
    return (
        arg
        or os.environ.get("RESEARCH_OUTPUT_ROOT")
        or str(Path.home() / "signal-console" / "outputs" / "nba-quant-lab")
    )


def normalize_game_id(gid: str) -> str:
    return gid if gid.startswith("nba-") else f"nba-{gid}"


# ----------------------------------------------------------------------------
# Orchestration (read-only DB)
# ----------------------------------------------------------------------------
_TICK_SQL = """
SELECT qt.source_market_id, qt.captured_at, qt.implied_probability, qt.volume
FROM quote_ticks qt
JOIN source_markets sm ON qt.source_market_id = sm.id
JOIN market_instruments mi ON sm.instrument_id = mi.id
WHERE sm.game_id = ? AND mi.family = 'player-prop' AND qt.is_heartbeat = 0
  AND qt.implied_probability IS NOT NULL
ORDER BY qt.source_market_id, qt.captured_at
"""


def load_game_props(con: sqlite3.Connection, game_id: str):
    """-> (ticks_by_prop {prop: [epoch]}, anoms_by_prop {prop: [epoch]}) for one game."""
    rows = con.execute(_TICK_SQL, (game_id,)).fetchall()
    by_prop: dict[str, list[tuple[float, float, Optional[float]]]] = defaultdict(list)
    for mkt, cap, prob, vol in rows:
        try:
            e = parse_epoch(cap)
        except Exception:
            continue
        by_prop[mkt].append((e, float(prob), None if vol is None else float(vol)))
    ticks_by_prop: dict[str, list[float]] = {}
    anoms_by_prop: dict[str, list[float]] = {}
    p = Params()
    for mkt, series in by_prop.items():
        series.sort(key=lambda r: r[0])
        epochs = [r[0] for r in series]
        probs = [r[1] for r in series]
        vols = per_interval_volumes([r[2] for r in series])
        ticks_by_prop[mkt] = epochs
        ev = detect_prop_anomalies(epochs, probs, vols, p)
        if ev:
            anoms_by_prop[mkt] = ev
    return ticks_by_prop, anoms_by_prop


def load_incidents(registry_path: str) -> list[dict]:
    reg = json.loads(Path(registry_path).read_text())
    inc = reg.get("incidents", reg) if isinstance(reg, dict) else reg
    out = []
    for x in inc:
        gid = x.get("gameId") or x.get("game_id")
        t = x.get("utcTime") or x.get("eventTime")
        if not gid or not t:
            continue
        try:
            ev = parse_epoch(t)
        except Exception:
            continue
        out.append({"id": x.get("id"), "game_id": normalize_game_id(gid), "event_epoch": ev})
    return out


def run(db_path: str, registry_path: str) -> dict:
    p = Params()
    incidents = load_incidents(registry_path)
    by_game: dict[str, list[dict]] = defaultdict(list)
    for inc in incidents:
        by_game[inc["game_id"]].append(inc)

    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    results = []
    pos_stats: list[float] = []
    neg_pool: list[float] = []
    for game_id, game_incs in by_game.items():
        ticks_by_prop, anoms_by_prop = load_game_props(con, game_id)
        if not ticks_by_prop:
            for inc in game_incs:
                results.append({**inc, "usable": False, "reason": "no player-prop ticks"})
            continue
        conf = confluence_by_window(anoms_by_prop, ticks_by_prop, p.window_sec)
        all_wins = sorted(set(w for es in ticks_by_prop.values() for w in (floor_win(e, p.window_sec) for e in es)))
        if not all_wins:
            continue
        grid = list(range(all_wins[0], all_wins[-1] + p.window_sec, p.window_sec))
        incident_wins = set()
        for inc in game_incs:
            incident_wins.update(span_windows(inc["event_epoch"], p.incident_half_window_sec, p.window_sec))
        k = len(span_windows(0.0, p.incident_half_window_sec, p.window_sec))
        control_maxk = control_block_maxima(conf, grid, incident_wins, k)
        ctrl_p90 = percentile([float(x) for x in control_maxk], p.control_percentile)
        neg_pool.extend(float(x) for x in control_maxk)
        for inc in game_incs:
            wins = span_windows(inc["event_epoch"], p.incident_half_window_sec, p.window_sec)
            peak = peak_confluence(conf, wins)
            active = max((conf.get(w, (0, 0))[1] for w in wins), default=0)
            usable = active >= p.min_confluence and len(control_maxk) >= 5
            standout = bool(usable and not math.isnan(ctrl_p90) and peak >= ctrl_p90 and peak >= p.min_confluence)
            if usable:
                pos_stats.append(float(peak))
            results.append({
                **inc,
                "usable": usable,
                "incident_peak_confluence": peak,
                "active_props_in_window": active,
                "control_p90": None if math.isnan(ctrl_p90) else round(ctrl_p90, 3),
                "n_control_blocks": len(control_maxk),
                "standout": standout,
            })
    con.close()

    evaluated = [r for r in results if r.get("usable")]
    n_eval = len(evaluated)
    successes = sum(1 for r in evaluated if r["standout"])
    pval = binom_sf(successes, n_eval, p.null_p) if n_eval else float("nan")
    auc = mann_whitney_auc(pos_stats, neg_pool)

    # KILL CRITERIA (pre-registered)
    kills = []
    if n_eval < p.min_eval_incidents:
        kills.append(f"only {n_eval} incidents have usable data (< {p.min_eval_incidents})")
    if n_eval and not (pval < 0.05):
        kills.append(f"per-incident standout not decisive (successes {successes}/{n_eval}, binom p={pval:.3g} >= 0.05)")
    verdict = "VIABLE" if (n_eval >= p.min_eval_incidents and pval < 0.05) else "KILL"

    return {
        "params": asdict(p),
        "n_incidents": len(incidents),
        "n_evaluated": n_eval,
        "successes": successes,
        "expected_by_chance": round(p.null_p * n_eval, 2) if n_eval else None,
        "binomial_p_value": None if math.isnan(pval) else pval,
        "secondary_rank_auc": None if math.isnan(auc) else round(auc, 3),
        "verdict": verdict,
        "kill_reasons": kills,
        "per_incident": results,
    }


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Whole-board confluence separation kill-test")
    ap.add_argument("--registry", default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    db_path = resolve_db_path()
    registry = resolve_registry_path(args.registry)
    report = run(db_path, registry)

    out_dir = Path(resolve_out_root(args.out)) / "confluence-killtest"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "result.json"
    out_file.write_text(json.dumps(report, indent=2))

    print(f"=== Confluence kill-test ===")
    print(f"incidents={report['n_incidents']} evaluated={report['n_evaluated']} "
          f"successes={report['successes']} (chance≈{report['expected_by_chance']})")
    print(f"binomial p={report['binomial_p_value']}  secondary rank-AUC={report['secondary_rank_auc']}")
    print(f"VERDICT: {report['verdict']}")
    for r in report["kill_reasons"]:
        print(f"  - {r}")
    print(f"wrote {out_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
