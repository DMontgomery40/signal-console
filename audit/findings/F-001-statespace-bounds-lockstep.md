# F-001 — state-space config bounds: lockstep by discipline only, nothing enforces it

- **Severity:** medium (latent / fragility — "a giant fragile wall standing right now")
- **Boundary crossed:** TypeScript Zod tuning contract ↔ Python pydantic runtime
- **Status:** confirmed
- **Surfaces no error:** yes — drift produces no failure until a specific value
  is submitted, and even then only on one side.

## What is claimed

`apps/nba-sidecar/src/nba_sidecar/models.py` carries an explicit comment:

> Each config field mirrors the inclusive [min, max] bounds enforced by the TS
> `BoardStateSpaceConfigSchema` (`packages/detectors/src/board-mad/state-space-config.ts`).
> ... Keep these bounds in lockstep with the Zod schema.

The same intent appears as the `scaleFloor <= scaleCeiling` refine duplicated on
both sides (Zod `superRefine`, pydantic `model_validator`).

## What is actually true

The two files agree **today** — I diffed all 30 fields across the 7 groups
(`trigger`, `breadth`, `observationModel`, `anchors`, `dynamics`, `sourceTrust`,
`scale`); every `min/max` matches every `ge/le`.

But **nothing enforces it**:

- `packages/detectors/src/board-mad/__tests__/state-space-config.test.ts` tests
  only the Zod schema in isolation (default resolution, the `scaleFloor`/`scaleCeiling`
  refine). It never references `models.py`.
- `apps/nba-sidecar/tests/test_volatility.py` independently _hardcodes_ the same
  default numbers (0.9, 0.45, 0.05, 1.4826, 4, …). It never references the Zod schema.
- There is no codegen, JSON-schema export, or shared fixture binding the two files.
  Each is a hand-maintained copy of the same 30-row table.

## Why it matters (silent failure mode)

`models.py`'s own comment names the exact danger: the sidecar "accepts direct
POSTs (UI, backtest, bakeoff, and any quant hitting the tunable API)". The TS
schema and the pydantic model are the **two gatekeepers of the same tuning
envelope**, reached by different callers:

- A value validated/clamped by Zod in one path, then validated again by pydantic
  in the sidecar path.
- If someone widens a Zod bound (say `disagreementWeight` max 2 → 3) and forgets
  `models.py`, the UI/contract will accept 2.5 and the sidecar will **422** it —
  or the reverse: pydantic widens, a quant POSTs a value the product contract was
  built to forbid, and it silently runs out-of-envelope math.
- No test in either language goes red. The drift ships. It surfaces later as an
  intermittent 422 (looks like a sidecar outage) or as a tuning run that behaves
  outside the documented range (looks like the model is broken).

This is exactly the "two definitions of the same thing that don't NEED to agree
but obviously should" pattern, with money/training cost on the line.

## Fix options (in order of strength)

1. **Single source of truth.** Export the Zod schema's bounds as JSON Schema (or a
   plain JSON table) at build time and have the pydantic models _load_ the bounds
   from that artifact (or generate `models.py` from it). Then drift is impossible.
2. **Cross-language contract test.** A test (CI step) that parses both files'
   numeric bounds and asserts equality — e.g. a Python test that reads a JSON
   table emitted by the TS package, or a node script diffing the two. Cheaper than
   #1, still fails loudly on drift.
3. **At minimum**, a single shared fixture of `(field, min, max)` consumed by both
   test suites, so the two independent hardcoded copies can't diverge silently.

## Repro / evidence

- Bounds table: `models.py:119-188` vs `state-space-config.ts:50-247`.
- Refine duplicated: `models.py:179-188` (`_floor_not_above_ceiling`) vs
  `state-space-config.ts:234-247` (`superRefine`).
- No enforcing test: `state-space-config.test.ts` (Zod-only),
  `test_volatility.py` (pydantic-only, hardcoded literals).

---

## RESOLUTION (fixed 2026-05-30)

Implemented fix option #2/#3 (shared contract artifact + enforcement on both real
validators):

- Added `packages/detectors/src/board-mad/state-space-bounds.json` — the single
  source of truth for all 30 `(field → min,max,int?)` bounds.
- `packages/detectors/src/board-mad/__tests__/state-space-bounds.contract.test.ts`
  introspects the live `BoardStateSpaceConfigSchema` (Zod `_def`) and asserts it
  equals the JSON.
- `apps/nba-sidecar/tests/test_state_space_bounds_contract.py` introspects the
  live pydantic models (`model_fields` + annotated-types `Ge`/`Le`) and asserts
  the same.

Now a bound changed in one language without the others goes red. **Negative
control verified:** perturbing one JSON bound (`trigger.enterOffset.min 0→0.5`)
failed BOTH the TS and Python contract tests; reverting made both pass. So the
guard genuinely catches drift (not a vacuous green). The schemas were left
untouched (additive enforcement) to avoid validation-behavior risk.
