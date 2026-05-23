<!-- Signal Console v2 PR template. Keep this short; the checklist is the contract. -->

## Summary

<!-- One paragraph: what changed and why. Link the user story id (e.g. US-021). -->

## Test Plan

<!-- Exact commands you ran, in the order you ran them. Paste failure output if any.
     Example:
       pnpm verify
       pnpm verify:no-stale-plan
       pnpm --filter @signal-console/api test
-->

## Checklist

- [ ] `pnpm verify` exits 0 locally (format:check, lint, typecheck, turbo verify)
- [ ] `pnpm verify:no-stale-plan` exits 0 (zero forbidden-string hits)
- [ ] Every new file under `packages/db/src/queries/` has a WHERE clause naming `game_id` or a time column
- [ ] No `as` casts at API boundaries; request/response bodies validated by Zod
- [ ] No new occurrences of `any`; lint passes with `--max-warnings=0`
- [ ] If a detector changed, `canonical.test.ts` at K=6.0 still passes (Hartenstein bucket-start `2026-05-08T03:12:00Z`; Reaves no-fire on both anchor games)
- [ ] Gold DB is opened only via `openGoldDb()`; no direct `new Database(...)` against the gold path
- [ ] If a new SQL query was added, an EXPLAIN QUERY PLAN snapshot was updated under `packages/db/src/queries/__tests__/__snapshots__/`
- [ ] LOC ceilings respected: route handler ≤ 80; service module ≤ 150; query module ≤ 80; detector module ≤ 250

## Notes for the reviewer

<!-- Anything subtle, intentional, or surprising. Risks, follow-ups, manual steps. -->
