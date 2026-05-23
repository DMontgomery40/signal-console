# Gold-DB Relocation Runbook (Phase 0, one-shot)

> Owner-executed procedure. Ralph and other automation MUST NOT run this; this is
> the cutover that moves the 54 GB gold SQLite tick store from its legacy location
> at `~/nba-predict/data/signal-console.sqlite` (historical, do not use) into its
> permanent home at `~/signal-console/data/signal-console.sqlite`.
>
> After this procedure completes successfully, the Signal Console v2 API/UI/cache
> opens the gold DB **read-only** via `openGoldDb()` and never writes to it again.
> A future Phase 0.5 ingest writer (if ported) is the only authorised writer; it
> lives in `~/signal-console/apps/worker/` and reviews under its own procedure.

---

## Hard rules for whoever runs this

- **do not wrap in a single script; each Bash invocation is reviewed and approved individually; no bypass-permissions.** If you find yourself wanting to paste the whole runbook into one terminal, stop and re-read PRD §11.3. The point of the manual checkpoint structure is to catch a holder-of-DB or an unexpected `ps` row before it corrupts the move.
- No shadow mode. No crossover. No "old worker keeps writing while new app boots."
  The hard cutover is the spec; any deviation needs a new proposal.
- If step `f` (integrity check) fails, **halt immediately**. Do not proceed to
  step `g`. Consider rolling back by moving the three files back to
  `~/nba-predict/data/`.
- Each step assumes the previous one passed its verification. Do not skip
  verifications.

---

## Step `a` — Stop the old app's processes

Send `Ctrl-C` to every terminal running `pnpm dev` for `nba-predict` and wait for
each one's shutdown log line to print. If you started any nba-predict service
under `nohup`, `pm2`, `launchd`, or `systemd`, stop it via that manager's command
(do not just `kill -9`; let the process flush).

Verify nothing matching the project is still running:

```bash
ps aux | grep -E "signal-console/(worker|api|web)|tsx .*signal-console|vite .*signal-console" \
    | grep -v grep
```

This must show no rows besides your own `grep`. If any row remains, stop that
PID explicitly with `kill <pid>` and re-run the check until it is clean.

Verify the old API port is closed (replace `4000` with the value from
`~/nba-predict/.env` or the `defaultApiPort` constant in
`@signal-console/shared`):

```bash
lsof -iTCP:4000 -sTCP:LISTEN
```

This must return empty.

---

## Step `b` — Park the Cloudflare tunnel

Manual step on the cloudflared side. Stop the cloudflared service (or switch it
to a maintenance config) so nothing public can reach the old API while the DB
files are in motion.

Verify the public hostname no longer reaches an upstream:

```bash
curl --fail --max-time 5 https://nba-predict.dtmont.com
```

This must fail. Any 5xx response, connection error, or `curl: (22)` exit is
acceptable proof that the tunnel is parked.

**Do NOT auto-repoint here.** Phase 1 (step `h`, after the cutover smoke passes)
is where cloudflared gets repointed to `localhost:4100`. Repointing inside this
step would expose the new API to the internet before its smoke gate has run.

---

## Step `c` — Confirm no holders of the gold DB files

```bash
lsof | grep "nba-predict/data/signal-console.sqlite"
```

This must return empty. If anything appears (a stray `sqlite3` REPL, an
editor previewing the file, a Python REPL with an open connection, a `cloudflared`
worker, anything), stop the holder first. Do not proceed to step `d` while
a process still has any of the three files open.

> **Note on `lsof` and the allow-list.** The string above is an exact match for
> the forbidden literal `nba-predict/data/signal-console.sqlite` (historical, do
> not use) — this file is explicitly allow-listed in
> `scripts/verify-no-stale-plan.ts`, which is why the runbook can spell out the
> legacy path verbatim. Outside this doc and `PRD.md`, no code or doc may write
> that literal.

---

## Step `d` — Optional safety backup (if disk permits)

A `.backup` is recommended but not required. Run it only if you have ~54 GB of
free space on `~`:

```bash
df -h ~
sqlite3 ~/nba-predict/data/signal-console.sqlite \
    ".backup ~/db-backups/signal-console-$(date +%Y%m%dT%H%M%SZ).sqlite"
```

Then verify the backup's integrity:

```bash
sqlite3 ~/db-backups/signal-console-*.sqlite \
    "PRAGMA integrity_check;" | grep -qx ok
```

`grep -qx ok` exits 0 only if the entire grep output is the single token `ok` on
its own line. Any other output (e.g. `ok` plus warnings, or the more verbose
multi-line report on a corrupt DB) exits non-zero — investigate before
proceeding.

If you skip the backup, accept that step `e` is the cutover point and roll-back
becomes a `mv` in the other direction (assuming nothing else has touched the new
location yet).

---

## Step `e` — Move main + WAL + SHM

The three files belong together. Move them in one APFS rename so SQLite never
sees a torn pair (the `-wal` and `-shm` files are produced by the writer and
must travel with their main DB).

```bash
mkdir -p ~/signal-console/data
mv ~/nba-predict/data/signal-console.sqlite       ~/signal-console/data/
mv ~/nba-predict/data/signal-console.sqlite-wal   ~/signal-console/data/ 2>/dev/null || true
mv ~/nba-predict/data/signal-console.sqlite-shm   ~/signal-console/data/ 2>/dev/null || true
```

The `-wal` and `-shm` moves use `|| true` because either file may legitimately
be absent depending on the last writer's state (a clean shutdown checkpoints the
WAL and removes the SHM). The main `.sqlite` move has no `|| true` — if it fails,
the procedure halts loudly.

Source and destination are on the same APFS volume, so each `mv` is an atomic
rename rather than a copy + delete. The cutover is effectively instantaneous;
there is no window where the file exists in both places or in neither.

---

## Step `f` — Integrity-check the moved DB

```bash
sqlite3 -readonly ~/signal-console/data/signal-console.sqlite \
    "PRAGMA integrity_check;" | grep -qx ok
```

If this exits non-zero (i.e. the output is anything other than the literal `ok`),
**halt**. Do NOT proceed to step `g`. Roll back by moving the three files back
to `~/nba-predict/data/` (the legacy directory still exists at this point,
sentinel-free) and contact the owner with the full `PRAGMA integrity_check`
output. The new app's read-only open does NOT run `integrity_check` on every
boot; this step is the single integrity proof for the relocation.

The `-readonly` flag on `sqlite3` is belt-and-suspenders. The actual integrity
check is read-only; the flag just guarantees the CLI cannot accidentally take
a write lock that conflicts with the API's first connection.

---

## Step `g` — Sentinel the old path

Plant tombstones at the legacy location so any future accidental nba-predict
start (a forgotten launchd plist, a fresh clone of the old repo, a curious
developer running `pnpm dev` in the wrong directory) fails loudly instead of
silently re-opening a non-existent DB or — worse — recreating an empty one
under the old path:

```bash
echo "MOVED to ~/signal-console/data/signal-console.sqlite on $(date)" \
    > ~/nba-predict/data/MOVED.txt
touch ~/nba-predict/.DEPRECATED
```

`MOVED.txt` is the human-readable forwarding address. `.DEPRECATED` is the
machine-readable marker that future hooks or pre-flight scripts under
`~/nba-predict/` should check and refuse to run if present.

Verify both exist:

```bash
ls -la ~/nba-predict/data/MOVED.txt ~/nba-predict/.DEPRECATED
```

---

## Step `h` — Phase-1 Cloudflare tunnel repoint (placeholder)

**Out of scope for the Phase-0 cutover.** Documented here so the procedure ends
with a clear handoff to Phase 1.

After Phase 1 ships the read-only API on `localhost:4100` and its acceptance
smoke (`/v1/health/ready`, `/v1/games`, `/v1/settings`) returns green, the
cloudflared config is updated to point at `localhost:4100` instead of the old
`localhost:4000` upstream. That config edit is its own reviewed change and is
documented separately under the Phase-1 story that owns it.

Until then, leave the cloudflared service parked from step `b`.

---

## Post-cutover sanity (informational)

Once steps `a`–`g` are green, the new API can boot against the moved DB. The
following smoke is a useful sanity check but is **not** a step of this runbook
— it belongs to the Phase-1 story that wires `openGoldDb()` into the live API.

```bash
GOLD_DB_PATH=~/signal-console/data/signal-console.sqlite \
    pnpm --filter @signal-console/db test
```

If the read-only open tests pass against the moved file, the four
read-only guards (`file:…?mode=ro` URI, `{ readonly: true, fileMustExist: true }`,
`busy_timeout=5000`, `query_only=ON` runtime assertion) are confirmed effective
on the production-size DB.
