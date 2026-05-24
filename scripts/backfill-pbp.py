#!/usr/bin/env python3
"""Backfill nba_play_by_play_actions from the local NBA sidecar.

Usage: python3 scripts/backfill-pbp.py <nba_game_id_with_or_without_prefix> [more...]
Examples:
  python3 scripts/backfill-pbp.py 0042500222
  python3 scripts/backfill-pbp.py nba-0042500222 nba-0042500224
"""
from __future__ import annotations

import json
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DB = REPO / "data" / "signal-console.sqlite"
SIDECAR = "http://127.0.0.1:9393"


def fetch_pbp(nba_game_id: str) -> list[dict]:
    url = f"{SIDECAR}/api/v1/games/{nba_game_id}/play-by-play"
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.load(resp)
    actions = data["data"]["actions"]
    return actions


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    captured_at = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(str(DB))
    conn.execute("PRAGMA journal_mode=WAL;")
    cur = conn.cursor()

    total_inserted = 0
    for raw in sys.argv[1:]:
        prefixed = raw if raw.startswith("nba-") else f"nba-{raw}"
        nba_id = prefixed[len("nba-"):]
        print(f"\n=== {prefixed} (sidecar id: {nba_id}) ===")

        # Game row must exist (FK constraint)
        row = cur.execute("SELECT id FROM games WHERE id=?", (prefixed,)).fetchone()
        if not row:
            print(f"  SKIP — no games row for {prefixed}", file=sys.stderr)
            continue

        actions = fetch_pbp(nba_id)
        print(f"  fetched {len(actions)} actions from sidecar")

        rows = []
        for a in actions:
            rows.append((
                prefixed,
                a.get("actionNumber"),
                a.get("actionType"),
                a.get("period"),
                a.get("clock"),
                a.get("description"),
                a.get("scoreAway"),
                a.get("scoreHome"),
                a.get("teamTricode"),
                a.get("timeActual"),
                captured_at,
                json.dumps(a, separators=(",", ":")),
            ))

        before = cur.execute(
            "SELECT COUNT(*) FROM nba_play_by_play_actions WHERE game_id=?",
            (prefixed,),
        ).fetchone()[0]
        cur.executemany(
            """INSERT OR IGNORE INTO nba_play_by_play_actions
               (game_id, action_number, action_type, period, clock, description,
                score_away, score_home, team_tricode, time_actual,
                captured_at, raw_metadata_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.commit()
        after = cur.execute(
            "SELECT COUNT(*) FROM nba_play_by_play_actions WHERE game_id=?",
            (prefixed,),
        ).fetchone()[0]
        added = after - before
        total_inserted += added
        print(f"  inserted {added} new rows (game total now {after})")

        # show the disputed event if it falls in here (Hartenstein @ 03:12:36.8Z)
        ev = cur.execute(
            """SELECT action_number, period, clock, description, time_actual
               FROM nba_play_by_play_actions
               WHERE game_id=? AND time_actual BETWEEN ? AND ?
               ORDER BY time_actual LIMIT 3""",
            (prefixed, "2026-05-08T03:12:30Z", "2026-05-08T03:12:45Z"),
        ).fetchall()
        if ev:
            print("  near 03:12:30-45Z:")
            for r in ev:
                print(f"    {r}")

    print(f"\nTotal new rows inserted: {total_inserted}")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
