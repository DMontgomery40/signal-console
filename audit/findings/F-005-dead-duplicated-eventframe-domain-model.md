# F-005 — A whole "EventFrame" domain model is dead, exported as canonical, and defined twice with nothing tying the copies together

- **Severity:** medium (contributor trap + latent dual-definition drift; not currently executed)
- **Boundary crossed:** domain package public API ↔ (nothing) ; Zod schema ↔ hand-written TS type
- **Status:** confirmed
- **Surfaces no error:** yes — it's exported, type-checks, and looks like the
  authoritative event model. It just has no producer or consumer.

## What it is

`packages/domain/src/schemas/core.ts` (96 lines) defines a rich betting-event
model as Zod schemas: `eventFrameSchema` composing `sportEventSchema`,
`sourceQuoteSchema` (`probability` 0–1, `spread`, `volume`, `depthScore` 0–100,
`reliabilityWeight` 0–1), `eventContextSchema` (`modelProbability`, `restEdge`,
`formEdge`, `paceEdge`, `exposureScore`, `volatilityScore`, `liquidityRisk`),
`auditEntrySchema`, `suggestedActionSchema`, `teamSchema`. It is re-exported from
the package barrel (`packages/domain/src/index.ts`: `export * from "./schemas/core"`).

`packages/domain/src/types.ts` **independently re-declares the same shapes** as
hand-written TypeScript (`Team`, `SportEvent`, `EventFrame`, `SourceQuote`,
`EventContext`, `SuggestedAction`, `AuditEntry`) — NOT via `z.infer`. So the same
concept has two definitions that can only agree by manual discipline.

## Evidence it is dead

Repo-wide (apps + packages, including tests and web mocks), excluding the two
defining files:

- `eventFrameSchema`, `sportEventSchema`, `sourceQuoteSchema`,
  `eventContextSchema`, `suggestedActionSchema` → **0 referencing files**.
- The `EventFrame`, `SourceQuote`, `EventContext`, `SuggestedAction`,
  `AuditEntry` *types* → **0 referencing files** outside `types.ts`/`core.ts`.
- The distinctive fields `restEdge` / `paceEdge` / `exposureScore` /
  `narrativeHints` appear only in the `types.ts` duplicate.
- `z.infer` is used in **neither** file, so the schema and the type are not bound.

The real pipeline uses entirely different shapes: DB `quote_ticks`
(`price_raw`, `implied_probability`, `best_bid`, `best_ask`, `volume`,
`depth_score`), the sidecar `CanonicalGame`/`CanonicalGameState` (pydantic), and
the board-anomaly/state-space observation models. None of `core.ts`'s
`modelProbability`/`restEdge`/`exposureScore` exists anywhere in persistence or
runtime.

## Why it matters (the trap)

It is the most authoritative-*looking* model in the codebase: it lives in the
`domain` package, it is exported from the barrel, it composes a clean
event→quotes→context→actions hierarchy with bounded units. A contributor asking
"what's the canonical event/quote shape?" finds this first and builds against it —
wiring a feature, a fixture, or a detector input to a model that nothing
populates and nothing reads. Effort is wasted, or worse, two event models end up
half-coexisting. And if anyone *does* start using it, the Zod-vs-TS dual
definition (unbound by `z.infer`) is an F-001-class agree-by-accident surface.

## Fix

- If it's genuinely retired demo scaffolding: delete `core.ts` and the mirrored
  shapes from `types.ts`, and drop the barrel re-export. Dead public API that
  looks canonical is worse than absent API.
- If any of it is meant to be the forward model: collapse the duplication
  (`export type EventFrame = z.infer<typeof eventFrameSchema>`), and wire at least
  one real producer/consumer — otherwise it's indistinguishable from dead.
- Grep `rg "eventFrameSchema|EventFrame|sourceQuoteSchema"` before deleting to
  reconfirm no late binding (none found 2026-05-30).

## Note (separately confirmed clean)

The state-space `VolatilityHistoricalPrior {median, mad, sampleSize}` is NOT
sourced from the `board_volatility_baselines` percentile table. Production builds
it via `buildBoardMadHistoricalPriors` → `weightedMedian`/`weightedMad` on raw
pooled intensities (a true MAD), correctly consumed by `volatility.py`'s
`mad * madScale (1.4826)`. The percentile table (`p50..p99`) feeds only the
separate board-anomaly residual detector. Two parallel baseline systems, each
internally consistent — no lossy percentile→MAD conversion. Recorded so later
slices don't re-investigate.
