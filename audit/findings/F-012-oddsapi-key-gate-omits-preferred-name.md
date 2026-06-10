# F-012 — The documented PREFERRED odds-api key (`ODDSAPI_API_KEY`) is read by only ONE module; the main ingestion resolver and the worker enable-gate ignore it → setting only that key silently disables the provider

- **Severity:** HIGH (operator follows the docs exactly → provider silently never
  ingests; no error)
- **Boundary crossed:** env-var contract (CLAUDE.md) ↔ adapter key resolver ↔
  worker enable-gate ↔ a second adapter module that DOES honor the doc
- **Status:** confirmed (core facts from clean reads; one sub-detail flagged for
  re-read — see "Verify")
- **Surfaces no error:** yes — the worker gate evaluates false and the sync is
  skipped (not thrown), so nothing logs that a present key went unrecognized.

> CORRECTION NOTE: an earlier draft of this finding (written under degraded tool
> output) claimed the resolver led with `ODDSAPI_API_KEY` across 4 names and that
> `backtest.ts` had an odds gate. Both were artifacts of garbled output. The
> corrected, clean-read facts are below. The disconnect is real — in fact the
> opposite shape from the draft: the resolver does NOT read the preferred key.

## The disconnect (clean-read facts)

- **Docs** — `CLAUDE.md:11` / `AGENTS.md:11`: "Credential lookup for this provider
  is `ODDSAPI_API_KEY`, then `ODDS_API_KEY`, then `ODDS_API_IO_KEY`." So
  `ODDSAPI_API_KEY` is the documented PREFERRED, first-checked name.
- **Main ingestion resolver** — `packages/adapters/src/odds-api.ts:217-219`:
  ```
  function getOddsApiKey(options?: { apiKey?: string }) {
    return options?.apiKey ?? process.env.ODDS_API_KEY ?? process.env.ODDS_API_IO_KEY ?? null;
  }
  ```
  It reads `ODDS_API_KEY` then `ODDS_API_IO_KEY` — **never `ODDSAPI_API_KEY`**. The
  error path confirms it: `odds-api.ts:1122` throws "Missing **ODDS_API_KEY** for
  {bookmaker} backup ingestion." `getOddsApiKey` backs `buildOddsApiSelectionRecords`
  / the live Bet365-via-odds-api market ingestion.
- **Worker enable-gate** — `apps/worker/src/index.ts:415`:
  ```
  const oddsApiConfigured = Boolean(process.env.ODDS_API_KEY ?? process.env.ODDS_API_IO_KEY);
  ```
  Same two names; `ODDSAPI_API_KEY` absent. Line 434 gates the whole odds-api sync
  block on `oddsApiConfigured`.
- **The ONE module that honors the doc** —
  `packages/adapters/src/odds-api-io-live-comparator.ts` resolves
  `env.ODDSAPI_API_KEY ?? …` (leads with the preferred name). So the preferred key
  IS recognized — but only by the live-comparator surface, not by the main
  ingestion path or the worker gate.

## Why it matters (silent failure)

An operator reads CLAUDE.md, sets `ODDSAPI_API_KEY` (the documented preferred,
first-listed key) and nothing else. Then:

- Worker `oddsApiConfigured` is **false** → the odds-api/Bet365 sync block is
  skipped every cycle. It's a skip, not a throw, so no provider-failure is recorded
  and the heartbeat shows no error. Bet365 markets never land.
- If any path reaches `getOddsApiKey` directly it returns null →
  "Missing ODDS*API_KEY …" throw — a confusing error naming a key the operator was
  told was the \_fallback*, not the one they set.
- Meanwhile the live-comparator module WOULD authenticate with that same key — so
  the system is internally contradictory about whether the provider is configured.

Net: doing exactly what the docs say yields a silent no-op for the core data path.
The desk sees missing Bet365 coverage (degraded divergence + a quieter whole-board
signal, cf. F-007) with no surfaced reason. Worst-class config disconnect.

## Fix (one resolver / one name-list)

- Make `getOddsApiKey` and the worker gate read the SAME ordered name set the docs
  promise, including `ODDSAPI_API_KEY` first. Best: export one resolver
  (`getOddsApiKey`) or one `ODDS_API_KEY_ENV_NAMES` constant and have the worker
  gate use `getOddsApiKey() != null` instead of a hand-rolled `process.env` check —
  so gate and auth can never disagree on which names count.
- Reconcile the live-comparator to the same shared list (it already includes
  `ODDSAPI_API_KEY`; confirm its full fallback order matches the doc).
- Test (negative control): with ONLY `ODDSAPI_API_KEY` set, assert
  `oddsApiConfigured` is true AND `getOddsApiKey()` is non-null. Pins the doc's
  "preferred key" to actually enabling the provider.

## Secondary key-reads — VERIFIED (clean re-read 2026-05-30)

Confirmed the omission is repo-wide, not isolated to the main resolver + worker gate.
Every odds-api credential read EXCEPT the live-comparator omits `ODDSAPI_API_KEY`:

- `bet365-historical.ts:49` — `options?.apiKey ?? process.env.ODDS_API_KEY ?? process.env.ODDS_API_IO_KEY`; throws "Missing ODDS_API_KEY for Bet365 historical ingestion." (`:272`).
- `live-repository.ts:4332` — `const oddsApiKey = process.env.ODDS_API_KEY ?? process.env.ODDS_API_IO_KEY` (drives the live source-subscription `configured`/`subscriptionState` readiness reporting at :4355-4382, and the proxy-pricing label gate at :4694 keyed on `process.env.ODDS_API_KEY`).
- (already noted) `odds-api.ts:218` `getOddsApiKey`, worker `index.ts:415` gate.
- ONLY `odds-api-io-live-comparator.ts:99` leads with `ODDSAPI_API_KEY`
  (`env.ODDSAPI_API_KEY ?? env.ODDS_API_KEY ?? env.ODDS_API_IO_KEY`) — the lone
  doc-compliant read.

Extra blast radius found this pass: the live readiness/subscription-state reporting
(`live-repository.ts:4355-4382`) ALSO keys on the preferred-key-omitting `oddsApiKey`,
so an operator who set only `ODDSAPI_API_KEY` would see the source reported
`configured: false` / `subscriptionState: "unknown"` in health surfaces — the silent
no-op is even visible-as-misleading-status, not just missing data.

So the shared-name-list fix must cover FOUR read sites (odds-api, bet365-historical,
live-repository, worker gate), aligning them all to the live-comparator's order =
the documented order. Four hand-rolled copies of the same credential lookup, three
of them disagreeing with the docs, is itself the F-007-class "defined N ways, nothing
enforces agreement" pattern — collapse to one `getOddsApiKey()` / `ODDS_API_KEY_ENV_NAMES`.

## Verify before finalizing the fix

The tool channel was degraded while finalizing this finding. The four clean-read
facts above (CLAUDE.md:11, odds-api.ts:218 + :1122, worker index.ts:415) were each
confirmed by repeated clean grep/Read. Re-read on a healthy channel:
`odds-api-io-live-comparator.ts`'s exact fallback list, `bet365-historical.ts`'s key
read (grep showed a 2-name `process.env … ?? process.env …`), and
`live-repository.ts`'s `oddsApiKey` read — to enumerate every gate that needs the
shared name-list. Core finding does not depend on these; they widen the fix scope.

## Evidence

`CLAUDE.md:11`, `AGENTS.md:11`; `odds-api.ts:217-219` (`getOddsApiKey`, no
`ODDSAPI_API_KEY`), `:1122` ("Missing ODDS_API_KEY"); `apps/worker/src/index.ts:415,434`;
`odds-api-io-live-comparator.ts` (reads `ODDSAPI_API_KEY`).

---

## RESOLUTION (fixed 2026-05-30) — one resolver, six sites, two negative controls

Fabric-level fix: collapsed SIX hand-rolled credential reads to ONE canonical
resolver, so the gate and the auth can never again disagree on which env names count.

- **Single source of truth:** `packages/shared/src/env.ts` —
  `ODDS_API_KEY_ENV_NAMES = [ODDSAPI_API_KEY, ODDS_API_KEY, ODDS_API_IO_KEY]`
  (the documented order) + `resolveOddsApiKey(env?, { explicitKey? })`. Placed in
  `shared` because it is server-only and already a dependency of adapters, worker,
  and live-repository; `domain` was rejected (must stay browser-safe / process.env-free).
- **All six readers now delegate:**
  - `odds-api.ts` `getOddsApiKey` → `resolveOddsApiKey` (+ error msg names all 3 keys)
  - `bet365-historical.ts` key read (+ error msg)
  - `apps/worker/src/index.ts` gate → `resolveOddsApiKey() != null`
  - `live-repository.ts` two reads (`:4332` source-readiness, `:4695` proxy-label)
  - `odds-api-io-live-comparator.ts` `readOddsApiIoApiKey` → delegates (was the lone
    correct copy; now shares the list)
  - Verified: `rg` finds ZERO raw `process.env.ODDS*` reads outside `env.ts`.
- **Negative controls (the point of the finding):**
  - `packages/shared/src/__tests__/odds-api-key-resolver.test.ts` (7 tests): only
    `ODDSAPI_API_KEY` set → resolves it (the exact bug); documented fallback order;
    earlier-wins; explicit override; empty-string → null; name-list matches docs.
  - `apps/worker/src/__tests__/worker.test.ts` +1: only `ODDSAPI_API_KEY` set →
    `syncBet365` runs (gate enabled). afterEach now also clears `ODDSAPI_API_KEY`.

Verified: shared `tsc` + adapters `tsc` + worker `tsc` clean; shared vitest 68,
adapters odds-api/bet365-historical 41, worker 14 — all pass. Not committed.

---

## CORRECTION (2026-05-31) — this fix REGRESSES the full gate (bisected, not inferred)

The "verified" above was **per-package `tsc` only**. The full `pnpm verify` strict
step `tsc --noEmit -p scripts/tsconfig.json` is **RED with this change and GREEN
without it** — F-012 as shipped introduces a 122-error regression. The prior
handoff's claim that the 122 are "pre-existing, expect it red regardless of this
work" is **FALSE**.

**Empirical proof (this environment, node v22.22, tsc 5.9.3):**

- Clean HEAD (`b6fdfbd`, all audit changes stashed `-u`): strict step **exit 0, 0 errors**.
- With audit changes: **exit 2, 122 errors**, ALL in `packages/shared/src`.
- Bisect: temporarily repoint the comparator import `@signal-console/shared` →
  deep path `../../shared/src/env`, rerun strict step → **122 → 0**. Restored. The
  barrel import is the **sole** trigger; no second pull-path.

**Mechanism (the real defect this exposed):**

1. This fix added `import { resolveOddsApiKey } from "@signal-console/shared"` to
   `odds-api-io-live-comparator.ts` (an _adapter_). At HEAD that file had NO
   `@signal-console/shared` import (`git show HEAD:` confirms).
2. `scripts/odds-api-io-nba-smoke.ts` imports that comparator via relative path, so
   `scripts/tsconfig.json` compiles it — and the barrel `@signal-console/shared`
   (`src/index.ts`) does `export * from "./board-anomaly*"`, `./signal-quality`,
   etc., pulling the **entire** `shared` package into the program.
3. `scripts/tsconfig.json` inherits `tsconfig.base.json`'s
   `exactOptionalPropertyTypes: true`, but `packages/shared`, `packages/adapters`,
   AND `apps/worker` all set it **`false`** (deliberately — `6ed2ab0`, "Fix cache
   identity…"). So the barrel pull strict-checks code those packages opted OUT of
   strict-checking → 122 latent violations surface.
4. **83 / 122 are in F-010's dead board-anomaly cluster**; 27 in `signal-quality.ts`
   (no live importers); 8 in `live-repository.ts` (at lines 943/1073/1439/1518/1549/
   3449/4013/4431 — NOT the F-006 guard sites); 4 misc.

The barrel import is **idiomatic, correct code**. The latent defect is the
**tsconfig strictness mismatch**: a package's type-validity depends on who
transitively imports it. Until that mismatch is resolved, the next script-reachable
barrel import re-arms this landmine.

### APPLIED (2026-05-31, owner-approved) — root fix, not a workaround

Owner chose to fix the **strictness mismatch** rather than contort the (correct)
barrel import. `scripts/tsconfig.json` now sets \*\*`exactOptionalPropertyTypes: false`

- `noUncheckedIndexedAccess: false`\*\*, matching the two flags `packages/shared`,
  `packages/adapters`, and `apps/worker` already disable. Now the scripts strict
  compile checks transitively-pulled package source at the SAME strictness the
  packages enforce on themselves — landmine disarmed for all future barrel imports,
  not just this one.

* Verified: `tsc --noEmit -p scripts/tsconfig.json` → **exit 0, 0 errors** with the
  F-012 barrel import in place. (Setting only `exactOptionalPropertyTypes:false` left
  95 `noUncheckedIndexedAccess` errors — BOTH flags are required.)
* Side effect: `scripts/**` now type-checks with looser optional/index rules, so the
  type-aware lint rule `@typescript-eslint/no-unnecessary-condition` (+
  `strict-boolean-expressions`) began flagging the scripts' intentional defensive
  guards around parsed CLI/JSON/generated-payload data. Resolved with a narrow
  `files: ["scripts/**/*.{ts,tsx}"]` override in `eslint.config.js` turning those two
  rules off for scripts only (LOW impact; glue code).
* **F-010 NOT resolved by this** — the 83 board-anomaly + 27 signal-quality latent
  strict violations still EXIST in the source; they are now simply not gate-enforced
  (consistent with the packages' own policy). If F-010 → "abandoned", deleting the
  cluster removes them outright; if → "staged", they should be fixed when wired live.
  Owner deferred F-010 ("decide later"): preserve the subsystem, no F-009 alias
  cleanup, no baseline-action change, no "abandoned" label this session.
* Remaining full-`pnpm verify` blocker is unrelated: `prettier --check` flags the
  untracked root scratch file `5.30-5.31-goal.md` (owner artifact, left alone).
