# F-006 — The "quote tick" contract is defined four ways that disagree on volume nullability, isHeartbeat type, and probability bounds

- **Severity:** medium (latent Live-view break + two same-named `QuoteTick` types that can't both parse the same bytes)
- **Boundary crossed:** DB ↔ domain Zod schema ↔ `/v1/live` OpenAPI ↔ web client Zod
- **Status:** confirmed (one break path is latent — see "Verify before fixing")
- **Surfaces no error:** the type/bound mismatches are silent; the volume-null
  path surfaces as a Zod throw in the web query, far from its DB cause.

## The four definitions of one quote tick

| field                | DB `quote_ticks`       | domain `live.ts` `quoteTickSchema` | `/v1/live` route JSON schema        | web `queries.ts` `quoteTickSchema` |
| -------------------- | ---------------------- | ---------------------------------- | ----------------------------------- | ---------------------------------- |
| `volume`             | `REAL` (nullable)      | `z.number().nullable()`            | `{ type: "number" }` (**non-null**) | `z.number()` (**non-null**)        |
| `isHeartbeat`        | `INTEGER` 0/1          | `z.boolean()`                      | `{ type: "integer" }`               | `z.number().int()`                 |
| `impliedProbability` | `REAL` (unconstrained) | `.min(0).max(1).nullable()`        | `["number","null"]` (no bound)      | `z.number().nullable()` (no bound) |

Two of these are the same exported name (`quoteTickSchema` / `type QuoteTick`)
in two packages — `packages/domain/src/schemas/live.ts` and
`apps/web/src/data/queries.ts` — with materially different shapes (the web one
also adds `source`/`instrumentId`/`rawFamily`/`rawLabel` and drops
`priceRaw`/`oddsRaw`/`lineRaw`/`bestBid`/`bestAsk`/`depthScore`).

## Why it matters

1. **`volume` nullability — latent Live break.** The DB column is nullable and
   `rowToQuoteTick` (`live-repository.ts:517`) explicitly emits `volume: null`
   when the row is null. But `/v1/live` declares `volume: { type: "number" }` and
   the web client parses `volume: z.number()`. The day a real source persists a
   non-heartbeat tick with null volume, the `/v1/live` payload violates its own
   OpenAPI schema and the web's `z.array(quoteTickSchema).parse(...)` throws —
   the whole Live view for that game errors, with a Zod message that points at
   the web layer, not at the legal-but-null DB value that caused it.

2. **`isHeartbeat` boolean vs integer — incompatible parsers.** The domain
   schema (`z.boolean()`) and the web schema (`z.number().int()`) can NEVER both
   successfully parse the same bytes: a payload with `isHeartbeat: 1` fails the
   domain schema; `isHeartbeat: true` fails the web schema and the route's
   `integer`. Today web+route agree on integer, so the web path works — but any
   code that reaches for the _domain_ `quoteTickSchema` to validate a route-shaped
   payload (the natural thing to do, since it's the "canonical" one in the domain
   package) will throw on every non-trivial tick.

3. **`impliedProbability` bounds — three assumptions.** The domain schema enforces
   `[0,1]`; the route/web don't bound it; the DB doesn't constrain it; and the
   live-repository SQL resolves price as
   `COALESCE(implied_probability, CASE WHEN price_raw BETWEEN 0 AND 1 THEN price_raw END)`
   — it guards `price_raw` to `[0,1]` but **trusts `implied_probability` is
   already in range, with no guard**. So an out-of-range `implied_probability`
   (e.g. an adapter that ever writes a percentage 0–100, or American odds leaking
   into the field) would (a) pass the DB, (b) flow straight into the detector's
   price/intensity as a >1 "probability" via the unguarded COALESCE, and (c) be
   rejected only if read through the domain schema — three different fates for the
   same bad value. (Adapter write-side conventions are slice 4.)

## Verify before fixing

Confirm whether the `/v1/live` window query filters null-volume or heartbeat
ticks (a `WHERE q.volume IS NOT NULL` or `is_heartbeat = 0` would mask break #1
today). Even if masked, the contract is inconsistent and the mask is incidental.

## Fix

- Pick one source of truth for the tick contract. Prefer deriving the web type
  from a shared schema (or from the route's OpenAPI) rather than a third
  hand-written `quoteTickSchema`. At minimum, make `volume` and `isHeartbeat`
  agree across the route schema, the web schema, and the domain schema, and
  reconcile with the DB's actual nullability (either `volume` is nullable
  everywhere, or the route coalesces null→0 and says so).
- Guard `implied_probability` symmetrically with `price_raw` in the COALESCE (or
  add a write-side clamp / DB CHECK), so an out-of-range probability can't reach
  the detector unguarded.
- If the domain `quoteTickSchema` is not actually the serving contract, stop
  exporting it as if it were (same trap class as F-005).

## Evidence

`live.ts (domain):91-104`; `apps/web/src/data/queries.ts:165-175`;
`apps/api/src/routes/live.ts:58-71`; `live-repository.ts:512,517,719-724` and the
`COALESCE(implied_probability, CASE WHEN price_raw BETWEEN 0 AND 1 …)` price
resolution; DB `quote_ticks` (`migrations.ts:133-148`).

---

## RESOLUTION + PARTIAL RETRACTION (2026-05-30)

Verifying before fixing (as the finding instructed) corrected two of the three claims:

### Volume "break" — RETRACTED (no break)

`getLive` (`apps/api/src/services/live.ts:88`) resolves volume as
`COALESCE(qt.volume, 0)` — a null DB volume is coalesced to **0** before it
leaves the API. So `/v1/live` never emits `volume: null`; the route schema
`volume: number` and the web `z.number()` are **accurate**, not a latent break.
Making them nullable (the original fix idea) would have _misrepresented_ the real
contract. The DB column is nullable, but the serving layer pins it to a number —
a deliberate, consistent reconciliation. No change made.

### `implied_probability` unguarded COALESCE — FIXED

This was the genuine defect: the price-resolution SQL guarded `price_raw` to
`[0,1]` but trusted `implied_probability` unguarded, so an out-of-range value
would flow straight into the divergence/disagreement `price`. Fixed all **5**
occurrences in `live-repository.ts` (aliases `q`, `q2`, `prev`) to guard
`implied_probability` symmetrically:
`COALESCE(CASE WHEN x.implied_probability BETWEEN 0 AND 1 THEN x.implied_probability END, CASE WHEN x.price_raw BETWEEN 0 AND 1 THEN x.price_raw END)`.
Value-preserving for all in-range or NULL data (identical results), so it only
ever filters genuinely out-of-range probabilities. Verified: shared `tsc` clean;
`live-repository` suite 31/31 pass.

### `isHeartbeat` boolean-vs-int + dual `quoteTickSchema` name — DOWNGRADED to a naming residual

The domain `quoteTickSchema` (volume nullable, `isHeartbeat: boolean`) and the web
`quoteTickSchema` (`isHeartbeat: z.number().int()`) are not a contract break —
they are two DIFFERENT layer representations that share a name: the domain one is
the raw persistence-row shape; the web one is the `/v1/live` _response_ shape
(coalesced, integer heartbeat). Both are internally correct for their layer.
Recommended follow-up (low risk, not done here to avoid a rename ripple at the end
of a long session): rename the web `quoteTickSchema`/`QuoteTick` →
`liveTickSchema`/`LiveTick` so the name stops implying it's the same contract as
domain's. Tracked as a naming cleanup, not a correctness defect.

### Residual smell (noted)

The price-resolution COALESCE is copy-pasted 5× across different queries — a
"defined in N places" pattern. The guard is now uniform, but extracting the
fragment into one SQL helper would make future changes single-point. Deferred
(cross-query refactor risk).
