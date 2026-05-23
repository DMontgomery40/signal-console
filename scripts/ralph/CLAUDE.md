# Ralph Agent Instructions — Signal Console v2

You are an autonomous coding agent building **Signal Console v2** at `~/signal-console/`. Read `../../PRD.md` (full spec) and `prd.json` (story list with `passes` flags) before doing anything else.

---

## ⛔️ CRITICAL: Gold DB is READ-ONLY ⛔️

A 54 GB SQLite gold-DB tick store lives at `~/signal-console/data/signal-console.sqlite` (with `-wal` and `-shm` siblings). The API/UI/cache code you write **must never** write to it.

- All gold-DB opens go through `packages/db/src/open.ts` (`openGoldDb()`), which applies four guards: `file:${path}?mode=ro` URI, `{ readonly: true, fileMustExist: true }` options, `PRAGMA busy_timeout=5000`, `PRAGMA query_only=ON` (then reads back and throws if not 1).
- Never write `INSERT`, `UPDATE`, `DELETE`, `CREATE TEMP VIEW`, `PRAGMA journal_mode=...`, or any other mutation against the gold-DB handle.
- The detector cache DB at `~/signal-console/data/detector-cache.sqlite` is the only writable store the API/UI code uses. It's safe to delete/recreate.
- `K_MAD_LIVE = 3.0` and `K_MAD_CALM = 6.0` are declared exactly once, in `packages/detectors/src/board-mad/config.ts`. Never hardcode either literal elsewhere.

---

## Your Task (one story per iteration)

1. **Read `prd.json`** (in this same directory) — it lists all 41 user stories.
2. **Read `progress.txt`** in this directory for prior iteration learnings — patterns this codebase uses, gotchas previous iterations hit.
3. **Read `../../PRD.md`** for the full spec. Re-read the section relevant to today's story before coding.
4. **Check git branch.** Branch from `prd.json` `branchName` is `ralph/signal-console-v2`. If not on it, `git checkout -b ralph/signal-console-v2` from `main` (or check it out if it exists).
5. **Pick the highest-priority story** where `passes: false`. This means the lowest `priority` number among unpassed stories.
6. **Implement that story only.** Do not start adjacent stories. Each story is sized to fit one context window.
7. **Verify acceptance criteria.** Every criterion in the story is machine-verifiable — run the actual command/grep/test that proves each one. Don't claim a criterion passes without running its check.
8. **Run quality gates** required by the story (typecheck, lint, tests). At minimum: `pnpm verify` should exit 0 if the story affects code under `pnpm verify`'s scope.
9. **Commit** with message `feat: [Story ID] - [Story Title]` (e.g. `feat: US-004 - Implement read-only gold-DB open path`).
10. **Update `prd.json`** to set `passes: true` for the completed story (use `jq` or careful read/edit).
11. **Append to `progress.txt`** (see format below).
12. **If all stories pass**, output literally `<promise>COMPLETE</promise>` on its own line.

---

## Progress Report Format

APPEND to `progress.txt` (never overwrite, always append):

```
## [ISO timestamp] - [Story ID]
- What was implemented: [1-2 sentences]
- Files changed: [list]
- Verification ran: [exact commands you executed]
- **Learnings for future iterations:**
  - Codebase patterns discovered
  - Gotchas encountered
  - Useful context for the next agent
---
```

The learnings section is critical. Future iterations have **no memory** of this one. Write down anything they'd otherwise have to re-discover.

---

## Out of Scope for Ralph (owner does these manually between phases)

The following stories' acceptance criteria require owner action; do NOT attempt to execute them yourself:

- **Gold-DB relocation execution** (Phase 0 cutover). US-013 writes `docs/gold-db-relocation.md` — the document — but the owner runs the procedure (stops nba-predict processes, parks Cloudflare tunnel, `mv` the 54 GB DB, places sentinels). You may write the doc; you may NOT run the relocation.
- **Cloudflare tunnel parking / repointing** (manual cloudflared config changes).
- **Phase 0.5 ingest writer** (not in prd.json; owner decides go/no-go).
- **Phase 5 archive of `~/nba-predict`** (owner decides archive vs delete).

If a story you pick contains an acceptance criterion that requires owner action, complete the parts you can (e.g. write a doc, write a script), then leave `passes: false` and explain in `notes` what's blocked on owner action.

---

## Hard Constraints (will fail review if violated)

- **LOC ceilings:** route handlers ≤ 80, service modules ≤ 150, query modules ≤ 80, detector modules ≤ 250.
- **No `as` casts at API boundaries.** Validate with Zod.
- **No `any`.** Eslint blocks it; do not work around.
- **`pnpm verify:no-stale-plan` must stay green.** Forbidden strings: `nba-predict/data/signal-console.sqlite`, `K = 6.0 only`, `source_data_version`, `\bdata_version\b`, `shadow mode`, `old worker keeps writing`. Allowed only in `docs/gold-db-relocation.md`, `docs/PRD.md` (or the root `PRD.md`), `docs/relocation/**`, and lines containing `(historical, do not use)`.
- **Detector contract tests are the spec.** If `canonical.test.ts` fails after your change, the detector port is wrong — do not adjust the test to make it pass. Fix the detector. The K=6.0 outcomes (Hartenstein bucket-start `2026-05-08T03:12:00Z`, Reaves no-fire on both game ids, mean 9.3 ± 1.0) are validated against the research report.
- **Dependency order.** Don't pick a UI story whose API route doesn't exist yet. Story `priority` reflects dependency order — respect it.
- **Don't run mock-only tests.** Per repo defaults: integration tests against a real (in-memory or fixture-backed) SQLite are preferred over mocked DBs.

---

## Reference Reading (locations relative to `~/`)

- `signal-console/PRD.md` — the spec (sections numbered 1–31).
- `.claude/plans/concurrent-crafting-sedgewick.md` — the original architecture plan (deeper rationale).
- `nba-predict/scripts/board_signal_v2.py` — canonical Python reference for the `board-mad` detector.
- `nba-predict/packages/shared/src/board-anomaly/game-state-volatility.ts` — TypeScript reference (don't import; read for shape).
- `nba-predict/packages/shared/src/migrations.ts` — schema documentation for the gold DB (read-only).
- `nba-predict/apps/web/src/lib/*.ts` — pure utility files worth porting wholesale with their tests.
- `nba-predict/.codex/hooks.json` — the bug-fix-regression guard to port.

When porting, **do not blindly copy** — read, understand, then re-implement under the new repo's stricter eslint ruleset.

---

## When You Finish

If `jq -r '.userStories[] | select(.passes == false) | .id' prd.json` returns empty, output `<promise>COMPLETE</promise>` on its own line. The outer loop will verify.

If you cannot complete a story (e.g. blocked on owner action, or a dependency story is itself `passes: false`), explain the block in `progress.txt` and the story's `notes` field, leave `passes: false`, and exit cleanly. The outer loop has a circuit breaker that will skip stories that fail repeatedly.

---

Start now: read `prd.json`, pick the highest-priority unpassed story, implement it, verify, commit, mark `passes: true`, log to `progress.txt`. One story per iteration. No spillover.
