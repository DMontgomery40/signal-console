#!/usr/bin/env bash
# Ralph hang-detection + auto-recovery watchdog.
#
# Polls the ralph/signal-console-v2 branch every POLL_MIN minutes. If no new
# commit lands within HANG_MIN minutes of the last one, kills the stuck Ralph
# process tree, relaunches it, and fires a macOS notification.
#
# Calibration: healthy iteration median 9.1 min, max observed 22 min.
# Threshold 25 min sits just above the slowest healthy iteration.
#
# Recovery cap: MAX_RECOVERIES (default 5) — after the cap, the watchdog stops
# auto-recovering and fires a "manual intervention needed" notification with the
# loud sound. This prevents infinite kill→hang→kill loops if something
# fundamentally broke.
#
# Usage:  nohup ./watchdog.sh > watchdog.log 2>&1 &
# Stop:   pkill -f ralph/watchdog.sh

set -uo pipefail

HANG_MIN=${HANG_MIN:-25}
POLL_MIN=${POLL_MIN:-3}
MAX_RECOVERIES=${MAX_RECOVERIES:-5}
REPO=${REPO:-/Users/davidmontgomery/signal-console}
RALPH_DIR="$REPO/scripts/ralph"

cd "$REPO"

LAST_COMMIT=$(git log -1 --format=%H)
# Initialize LAST_CHANGE to the actual commit timestamp, NOT to now — otherwise
# a watchdog launched mid-hang thinks "silent 0min" when it should think
# "silent however-long-it-actually-has-been". `git show -s --format=%ct` returns
# the commit time as a unix timestamp.
LAST_CHANGE=$(git show -s --format=%ct "$LAST_COMMIT")
ALERTED_FOR=""
RECOVERY_COUNT=0

echo "[$(date)] watchdog start  HANG_MIN=$HANG_MIN  POLL_MIN=$POLL_MIN  MAX_RECOVERIES=$MAX_RECOVERIES  start_commit=${LAST_COMMIT:0:7}"

get_ralph_age_min() {
  # Returns age in minutes of the oldest ralph.sh process, or 9999 if no
  # Ralph is running. Used so a freshly relaunched Ralph gets its full
  # HANG_MIN grace period before a hang verdict — preventing the watchdog
  # from killing Ralph the instant it sees a stale commit timestamp.
  local pid
  pid=$(pgrep -f "ralph.sh 15" 2>/dev/null | head -1)
  if [ -z "$pid" ]; then echo 9999; return; fi
  local etime
  etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -z "$etime" ]; then echo 9999; return; fi
  # ps etime format: "MM:SS", "HH:MM:SS", or "DD-HH:MM:SS"
  echo "$etime" | awk -F'[-:]' '{
    if (NF == 4) print int(($1*86400 + $2*3600 + $3*60 + $4) / 60);
    else if (NF == 3) print int(($1*3600 + $2*60 + $3) / 60);
    else if (NF == 2) print int(($1*60 + $2) / 60);
    else print int($1 / 60);
  }'
}

notify() {
  local title="$1" body="$2" sound="${3:-}"
  if [ -n "$sound" ]; then
    osascript -e "display notification \"$body\" with title \"$title\" sound name \"$sound\"" 2>/dev/null || echo "(osascript failed)"
  else
    osascript -e "display notification \"$body\" with title \"$title\"" 2>/dev/null || echo "(osascript failed)"
  fi
}

recover() {
  local stuck_commit="$1"
  RECOVERY_COUNT=$((RECOVERY_COUNT + 1))
  echo "[$(date)] RECOVERY #$RECOVERY_COUNT — killing stuck Ralph (stuck on ${stuck_commit:0:7})"
  notify "Ralph Watchdog" "Hang on ${stuck_commit:0:7} — recovering (attempt $RECOVERY_COUNT/$MAX_RECOVERIES)" "Submarine"

  # Kill in reverse-dependency order (graceful first, then force)
  pkill -TERM -f "tsx watch src/server.ts" 2>/dev/null || true
  pkill -TERM -f "claude --dangerously-skip-permissions --print" 2>/dev/null || true
  pkill -TERM -f "ralph.sh 15" 2>/dev/null || true
  sleep 3
  pkill -KILL -f "tsx watch src/server.ts" 2>/dev/null || true
  pkill -KILL -f "claude --dangerously-skip-permissions --print" 2>/dev/null || true
  pkill -KILL -f "ralph.sh 15" 2>/dev/null || true
  pkill -KILL -f "playwright/mcp@latest" 2>/dev/null || true
  pkill -KILL -f "21st-dev/magic@latest" 2>/dev/null || true
  pkill -KILL -f "gitnexus mcp" 2>/dev/null || true
  sleep 2

  # Verify port 4100 is free
  if lsof -nP -iTCP:4100 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
    echo "[$(date)] WARN: port 4100 still bound after kill — proceeding anyway"
  fi

  # Relaunch Ralph detached
  echo "[$(date)] relaunching Ralph (15 iterations)"
  (
    cd "$RALPH_DIR"
    nohup ./ralph.sh 15 --skip-security-check >> ralph.log 2>&1 &
    disown $! 2>/dev/null || true
  )
  sleep 5

  # Verify relaunch took
  if pgrep -f "ralph.sh 15" > /dev/null; then
    echo "[$(date)] relaunch confirmed — fresh Ralph running"
    notify "Ralph Watchdog" "Auto-recovered. Ralph running (recovery $RECOVERY_COUNT/$MAX_RECOVERIES). Sleep on."
  else
    echo "[$(date)] FAILED to confirm relaunch"
    notify "Ralph Watchdog" "Recovery failed to start a fresh ralph.sh — manual intervention needed" "Sosumi"
  fi

  # Reset hang-tracking state — use commit time, not now, in case the relaunched
  # Ralph quickly produces a fresh commit before this point is reached.
  LAST_COMMIT=$(git log -1 --format=%H)
  LAST_CHANGE=$(git show -s --format=%ct "$LAST_COMMIT")
  ALERTED_FOR=""
}

while true; do
  sleep $((POLL_MIN * 60))

  CURRENT=$(git log -1 --format=%H 2>/dev/null) || continue
  NOW=$(date +%s)

  if [ "$CURRENT" != "$LAST_COMMIT" ]; then
    DELTA_MIN=$(( (NOW - LAST_CHANGE) / 60 ))
    echo "[$(date)] new commit ${CURRENT:0:7} (${DELTA_MIN}min since prior)"
    LAST_COMMIT=$CURRENT
    LAST_CHANGE=$(git show -s --format=%ct "$CURRENT")
    ALERTED_FOR=""
    continue
  fi

  COMMIT_AGE_MIN=$(( (NOW - LAST_CHANGE) / 60 ))
  RALPH_AGE_MIN=$(get_ralph_age_min)
  # Effective hang age = min(commit age, ralph process age). A freshly
  # relaunched Ralph against an old last-commit gets grace until its own
  # process has been alive HANG_MIN minutes.
  if [ "$RALPH_AGE_MIN" -lt "$COMMIT_AGE_MIN" ]; then
    ELAPSED_MIN=$RALPH_AGE_MIN
  else
    ELAPSED_MIN=$COMMIT_AGE_MIN
  fi

  if [ $ELAPSED_MIN -ge $HANG_MIN ] && [ "$ALERTED_FOR" != "$CURRENT" ]; then
    if [ $RECOVERY_COUNT -ge $MAX_RECOVERIES ]; then
      echo "[$(date)] CAP HIT: $RECOVERY_COUNT recoveries already, giving up auto-recovery"
      notify "Ralph Watchdog" "Cap hit ($MAX_RECOVERIES recoveries). Manual intervention needed — Ralph stuck on ${CURRENT:0:7}." "Sosumi"
      ALERTED_FOR=$CURRENT
    else
      recover "$CURRENT"
      ALERTED_FOR=$CURRENT
    fi
  else
    echo "[$(date)] ok (silent ${ELAPSED_MIN}min effective [commit ${COMMIT_AGE_MIN}min, ralph age ${RALPH_AGE_MIN}min], threshold ${HANG_MIN}min, recoveries ${RECOVERY_COUNT}/${MAX_RECOVERIES})"
  fi
done
