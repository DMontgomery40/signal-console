# US-051 visual verification

Per CLAUDE.md "KNOWN HANG MODE" section, Playwright/computer-use MCPs
have hung indefinitely on this machine during UI verification. Ralph
fell back to the documented HTTP-smoke + DB-parity verification path
for this story:

- **Real-data API smoke** against the moved gold DB:
  `GET /v1/board/nba-0042500222/fanout?bucket_start=2026-05-08T03:12:00Z`
  returned 28 PBP events (all within ±5 min) and 10 movers with
  top-10 contribution sum = 96.2%, 5 markets >5%.

- **Hartenstein anchor (AC criterion 7) verified end-to-end:**
  the response includes `timeActual=2026-05-08T03:12:36.8Z`,
  `actionType=rebound`, `description=I. Hartenstein REBOUND (Off:4 Def:4)`,
  `playerName=I. Hartenstein`, `deltaSecondsFromFire=36.8` (tier yellow,
  <60s). sqlite3 cross-check returned the identical row.

- **Strict ±5 min window:** no event with |Δt| > 300s appeared in the
  response (jq assertion ran).

- **Static-build DOM smoke:** `apps/web/dist/assets/index-*.js`
  contains the `fanout-panel`, `fanout-narrative`, `fanout-pbp-timeline`,
  `fanout-mover-row`, `fanout-pbp-empty`, and `fanout-window` markers,
  along with the rendered "Fanout window (±5 min PBP cap)" explainer
  title and the empty-state copy.

- **Vitest jsdom render:** `FanoutPanel.test.tsx` exercises the
  loading, success, empty-PBP, and error states under the real
  `useFanout` query path.

Visual screenshots (baseline + interaction + tier-color decode + empty
state) to be captured manually by the owner when Playwright is
available on this machine.
