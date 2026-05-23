# US-049 — Honest 'add a detector' UI copy + adding-a-source.md doc

US-049 is a copy-only change to the existing `HowToAddPanel` in
`apps/web/src/features/detectors/DetectorsPage.tsx` plus a new doc at
`docs/adding-a-source.md`. No data flow, no DB interaction, no new
interactive controls.

Per `scripts/ralph/CLAUDE.md` UI Verification Protocol §"KNOWN HANG MODE":
visual verification was satisfied via the **HTTP-smoke fallback** (production-
bundle DOM assertions + Vitest jsdom render) — Playwright was not invoked
because the change is pure DOM copy with deterministic Vitest coverage.

## Evidence

1. **Production-bundle grep** (proves new strings ship in the built JS):

   ```
   $ pnpm --filter @signal-console/web build
   $ grep -o "How to add a detector ALGORITHM\
   |How to add a data SOURCE (FanDuel, DraftKings, etc.)\
   |Multi-iteration work — not a one-line change.\
   |docs/adding-a-source.md\
   |how-to-add-algorithm-heading|how-to-add-algorithm-steps\
   |how-to-add-source-heading|how-to-add-source-steps\
   |how-to-add-source-multi-iteration\
   |adding-a-source-link\
   |packages/detectors/src/types.ts" apps/web/dist/assets/index-*.js | sort -u
   ```

   All 11 strings present in the bundle.

2. **DetectorsPage.test.tsx — 10 tests pass** including two new assertions:
   - `renders the 'How to add a detector ALGORITHM' section with the 3-step recipe (US-049)`
   - `renders the 'How to add a data SOURCE' section enumerating ≥7 touch points (US-049)`

3. **`pnpm verify` — 5/5 turbo tasks green** (format:check, lint, typecheck,
   verify:no-stale-plan, verify:no-hex-literals, turbo run verify). The new
   doc `docs/adding-a-source.md` did **not** trip `verify:no-stale-plan`,
   so no allow-list edit was required.

## What the owner sees on `/detectors`

1. The existing card list with the SOURCES chip per detector.
2. Below the cards: a left-accented panel with two clearly separated
   sections:
   - **"How to add a detector ALGORITHM"** — 3 numbered steps, prefaced
     by the honest "For a new algorithm that consumes existing ingested
     data" disclaimer.
   - **"How to add a data SOURCE (FanDuel, DraftKings, etc.)"** — 7
     numbered touch points (ingest worker → schema → watermark → Source
     enum → detector sources → Settings → tests), a yellow link to
     `docs/adding-a-source.md`, and the closer **"Multi-iteration work
     — not a one-line change."** in yellow.

If the owner wants a real screenshot capture, run
`pnpm --filter @signal-console/web dev`, open `/detectors`, scroll to the
panel, and save to `1-baseline-1440x900.png` in this directory.
