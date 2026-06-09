# F-005 — A whole "EventFrame" domain model is dead, exported as canonical, and defined twice with nothing tying the copies together

- **Severity:** medium (contributor trap + latent dual-definition drift; not currently executed)
- **Boundary crossed:** domain package public API ↔ (nothing) ; Zod schema ↔ hand-written TS type
- **Status:** confirmed (finding); **fix DEFERRED — not shipped** (see resolution)
- **Surfaces no error:** yes — it's exported, type-checks, and looks like the
  authoritative event model. It just has no producer or consumer.

## What it is

`packages/domain/src/schemas/core.ts` defines a betting-event model as Zod schemas
(`eventFrameSchema` composing `sportEventSchema`, `sourceQuoteSchema`,
`eventContextSchema` with `modelProbability`/`restEdge`/`paceEdge`/`exposureScore`,
`auditEntrySchema`, `suggestedActionSchema`, `teamSchema`). It is re-exported from the
domain barrel. `packages/domain/src/types.ts` independently re-declares the SAME shapes
as hand-written TS (`EventFrame`, `SourceQuote`, `EventContext`, …) — NOT via
`z.infer`, so the two can only agree by manual discipline.

## Evidence it is dead

Repo-wide (apps + packages, incl. tests), excluding the two defining files:
`eventFrameSchema`/`sportEventSchema`/`sourceQuoteSchema`/`eventContextSchema`/
`suggestedActionSchema` and the `EventFrame`/`SourceQuote`/`EventContext`/
`SuggestedAction`/`AuditEntry` types have **0 referencing files**. The distinctive
fields (`restEdge`/`paceEdge`/`exposureScore`/`narrativeHints`) appear only in the
`types.ts` duplicate. The real pipeline uses entirely different shapes (DB
`quote_ticks`, sidecar `CanonicalGame*`, board observation models). The only LIVE
exports in those two files are `severityBandSchema` (core.ts → `research.ts`) and
`WatchlistRecord` (types.ts → `watchlist-repository.ts`).

## Why it matters

It is the most authoritative-_looking_ model in the codebase (domain package, barrel
export, clean event→quotes→context→actions hierarchy with bounded units). A
contributor builds against it and wires a feature to a model nothing populates or
reads; and if anyone does adopt it, the unbound Zod-vs-TS duplication is an
F-001-class agree-by-accident surface.

## Fix

Delete `core.ts`/`types.ts` down to their one live export each
(`severityBandSchema`, `WatchlistRecord`); drop the dead schemas + mirror types. If
any is meant to be the forward model, bind it (`export type X = z.infer<…>`) and wire
a real producer/consumer.

## RESOLUTION — DEFERRED, not shipped (2026-05-30)

The deletion was attempted, then **reverted; the dead model remains at HEAD.**
`packages/domain/src/{schemas/core.ts,types.ts}` are unchanged from HEAD in this
work (verified: `git diff` empty; `eventFrameSchema` still present).

Why deferred: the full `pnpm verify` gate's strict step
(`tsc -p scripts/tsconfig.json`, which compiles `packages/shared` under
`exactOptionalPropertyTypes: true` even though shared's own tsconfig sets it `false`)
reports **122 `exactOptionalPropertyTypes` errors in `packages/shared/src`**
(board-anomaly cluster, `signal-quality.ts`, and unrelated `live-repository.ts`
functions). Those errors are in files this work never edited, are pre-existing strict
-mode debt of the branch (unchanged code under an unchanged stricter tsconfig), and
made it impossible to get a clean, fast read on whether deleting the dead domain
exports is gate-neutral — the typecheck repeatedly timed out under measurement, and I
produced contradictory readings before settling on the structural conclusion above.

Rather than ship a dead-code cleanup (the lowest-value finding: zero live consumers,
no correctness or UX impact) while unable to verify the gate, I reverted it. Land
F-005 only once the branch's pre-existing 122-error strict debt is resolved or the
gate can be measured cleanly.

> RETRACTED earlier drafts of this section: (a) "deleted & shipped, gate green" —
> false; (b) "deletion unmasks 122 via an F-013 domain-barrel collision" — the
> collision mechanism was DISPROVEN (reverting the domain files to HEAD still yields
> 122), and the F-013 finding was deleted; (c) "live-repository `?? undefined` was the
> root cause" — false. The honest, verified state is only what is written above:
> dead model retained; 122 errors are pre-existing shared/strict debt independent of
> this finding.
