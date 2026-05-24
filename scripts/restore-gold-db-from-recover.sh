#!/usr/bin/env bash
# Merge quote_ticks recovered from the corrupt 58GB gold DB back into the live DB.
#
# Context (2026-05-23): REINDEX failed on quote_ticks; .recover wrote ~38M rows to
# /tmp/recovered.sql as quote_ticks_corrupt_20260523. Replay to /tmp/recovered.sqlite
# failed when the disk filled. This script streams those INSERTs into the live gold DB
# with INSERT OR IGNORE (unique on source_market_id + captured_at).
#
# Prerequisites:
#   - /tmp/recovered.sql exists (~33GB)
#   - At least MIN_FREE_GB free on the data volume (default 30)
#   - Stop the nba-predict worker before running (holds the DB writable)
#
set -euo pipefail

RECOVER_SQL="${RECOVER_SQL:-/tmp/recovered.sql}"
GOLD_DB="${GOLD_DB:-$HOME/signal-console/data/signal-console.sqlite}"
MIN_FREE_GB="${MIN_FREE_GB:-30}"
LOG="${LOG:-/tmp/merge-recovered-$(date +%Y%m%dT%H%M%S).log}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$RECOVER_SQL" ]] || die "missing $RECOVER_SQL — run: sqlite3 $HOME/signal-console/data/signal-console-corrupt-20260523.sqlite \".recover\" | tee $RECOVER_SQL"

avail_kb="$(df -k "$(dirname "$GOLD_DB")" | awk 'NR==2 {print $4}')"
avail_gb=$((avail_kb / 1024 / 1024))
if (( avail_gb < MIN_FREE_GB )); then
  die "need ~${MIN_FREE_GB}GB free on $(dirname "$GOLD_DB") (have ${avail_gb}GB). Free space first, e.g. move or delete signal-console-corrupt-20260523.sqlite (54GB) AFTER this merge succeeds."
fi

if lsof "$GOLD_DB" 2>/dev/null | grep -q .; then
  echo "Processes holding $GOLD_DB:"
  lsof "$GOLD_DB" || true
  die "stop the nba-predict worker (and any sqlite3 shells) before merging"
fi

echo "Backing up live gold DB metadata..."
cp -p "$GOLD_DB" "${GOLD_DB}.pre-merge-$(date +%Y%m%dT%H%M%S)"

before="$(sqlite3 "$GOLD_DB" "SELECT COUNT(*) FROM quote_ticks;")"
echo "quote_ticks before merge: $before"
echo "Streaming recovered ticks into $GOLD_DB (log: $LOG) ..."

# Rename corrupt table → quote_ticks; keep INSERT OR IGNORE for idempotent re-runs.
rg "^INSERT OR IGNORE INTO 'quote_ticks_corrupt_20260523'" "$RECOVER_SQL" \
  | sed "s/quote_ticks_corrupt_20260523/quote_ticks/g" \
  | sqlite3 "$GOLD_DB" 2>&1 | tee "$LOG"

after="$(sqlite3 "$GOLD_DB" "SELECT COUNT(*) FROM quote_ticks;")"
echo "quote_ticks after merge: $after (added $((after - before)))"

echo "Running integrity_check (may take several minutes)..."
sqlite3 "$GOLD_DB" "PRAGMA integrity_check;" | tee -a "$LOG" | head -5

gap="$(sqlite3 "$GOLD_DB" "SELECT COUNT(*) FROM quote_ticks WHERE captured_at >= '2026-05-11' AND captured_at < '2026-05-23';")"
echo "ticks in May 11–22 window: $gap"

echo "Done. Clear detector cache and restart API/worker so backtest recomputes:"
echo "  sqlite3 $HOME/signal-console/data/detector-cache.sqlite \"PRAGMA foreign_keys=ON; DELETE FROM detector_runs;\""
echo "After verifying backtest, you can delete:"
echo "  $RECOVER_SQL"
echo "  $HOME/signal-console/data/signal-console-corrupt-20260523.sqlite{,-wal,-shm}"
