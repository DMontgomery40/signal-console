# Adding a data source

> Operational checklist for onboarding a **new upstream feed** (FanDuel,
> DraftKings, an additional sport's PBP, a new exchange). This is the doc the
> DetectorsPage links to from the "How to add a data SOURCE" section.
>
> **This is multi-iteration work — not a one-line change.** A new source
> touches the ingest worker, the gold-DB schema, the per-game source-watermark
> hash, the detector contract, every detector that consumes it, the Settings
> page, and tests at every layer. The 3-step "add an algorithm" recipe on the
> Detectors page is for detectors that consume data **we already ingest**.
> A new feed is not that.

The "How to add a detector ALGORITHM" panel applies when a new detector
consumes data we already have on disk (`quote_ticks`,
`market_microstructure_events`, PBP actions). This document covers the harder
case: there is no row in the gold DB yet — you are responsible for the
ingest, the schema, the cache invalidation story, and the surface area that
exposes the feed to detectors and the UI.

---

## 0. Scope check before you start

Before writing any code, answer these in the PR description:

- Which **sport(s)** does the new feed cover? (Sport gating is real — see US-040.)
- Which **market shape(s)** does it ship: moneyline, spread, totals, futures,
  player props, derivative products?
- What is the **price representation** at the wire — American odds, decimal
  odds, fractional, contract price ($0–$1 prediction-market style)?
- Does it ship **print tape** (executed trades) or only top-of-book quotes? If
  only quotes, off-price-print cannot consume it.
- What's the realistic **tick cadence** — sub-second, 1 Hz, 5 Hz, event-driven?
- Are there **legal / TOS constraints** on storing odds, broadcasting them,
  or republishing them? Owner-decision before coding.

If the answer to any of these is "I'm not sure," stop and surface the question
before writing the ingest module. It is much cheaper to land on the wrong
schema in a design review than in a migration.

---

## 1. Ingest worker module

Add a client under `apps/worker/` (path conventions: one folder per feed,
e.g. `apps/worker/src/fanduel/`).

Required components:

- **Auth.** API key, OAuth, signed-URL, or scraping consent — document
  the credential boundary and where the secret lives (env var, secret store,
  `~/.signal-console/<feed>-token`).
- **Rate limits.** Match the upstream's published policy; default to a
  conservative token bucket with backoff. Never silently drop ticks — log
  rate-limit hits.
- **Retry + circuit breaker.** Idempotent retries on 5xx with exponential
  backoff. Open the breaker after N consecutive failures and surface the open
  state to `/v1/settings` (see step 6).
- **IP normalization** (the most error-prone step — see step 2 for details).
- **Heartbeat handling.** If the feed emits keepalives, tag them
  `is_heartbeat = 1` so board-MAD drops them from the volatility window.
- **Sanitation rules** specific to this feed: drop 0.500 anchors if the
  upstream emits midline placeholders, drop pre-tipoff "0/0" lines, drop
  closed/suspended quotes, drop stale-watermark resends.

Smell test: the ingest module should be a clean read-through to the gold DB.
Detector logic does not belong here.

## 2. Implied-probability normalization

Every quote tick must arrive at the gold DB normalized to the **unit
interval [0, 1]** as a Yes-side implied probability. The detectors assume
this representation; getting the math wrong here corrupts every downstream
metric.

Conversions:

- **American odds** (e.g. `+150`, `-220`): standard moneyline-to-implied
  formula, then strip the vig if you're storing a single side. Document the
  vig-strip choice (proportional vs. additive) in the worker module.
- **Decimal odds** (e.g. `2.50`): `p = 1 / d`, then vig-strip.
- **Fractional odds** (e.g. `5/2`): convert to decimal first, then 1/d.
- **Contract price** (Polymarket / Kalshi; $0–$1 already): pass through
  unchanged. These are **already** Yes-side probabilities — no vig strip.

Edge cases the worker must handle explicitly:

- Pre-tipoff lines with no real two-sided market — drop or flag as
  `is_heartbeat`.
- Mid-game suspensions — preserve the last tick before suspend, then
  resume with a marker the watcher can use.
- Outright zero or one prints (i.e. the side is locked) — store but flag,
  so detectors can skip them.

## 3. Heartbeat and sanitation

The board-MAD detector explicitly filters out:

- `is_heartbeat = 1` rows (`packages/detectors/src/board-mad/index.ts`),
- ticks at exactly `0.500` (treated as midline placeholders, not anchors).

Your ingest worker must set `is_heartbeat = 1` on:

- upstream keepalive frames,
- duplicate-timestamp resends,
- any tick the upstream marks as "indicative" rather than tradeable.

If the new feed has its own placeholder convention (e.g. exactly `0.000` or
`1.000` for one-sided locks), document it in this section and consider
whether board-MAD's filter set needs to widen. **Do not** change board-MAD
to silently match a new convention — extend the filter set in a separate
story with its own contract test.

## 4. Gold-DB schema

The default is to **reuse the existing tables**. Adding a new table requires
a migration plan and an owner sign-off.

Reuse path:

- `source_markets` — one row per (source, market) tuple. Add a new row
  per upstream market id at ingest time.
- `quote_ticks` — one row per price observation. Schema already includes
  `source_market_id`, `captured_at`, `implied_probability`, `volume`,
  `is_heartbeat` — no new columns needed.
- `market_microstructure_events` — only for sources that ship print tape
  (executed trades with price + size). Quote-only feeds do not write here.
- PBP tables (`nba_play_by_play_actions`, etc.) — sport-specific, schema
  extension required when adding a new sport, not a new sportsbook.

New-table path (only when reuse is genuinely impossible):

- Add the migration to `packages/db/src/migrations/`.
- Document the table in `packages/db/src/migrations.ts` (the schema-doc
  pattern lives in nba-predict for reference — read, then re-implement to
  the stricter eslint ruleset).
- Update `openGoldDb()` consumers if the new table needs to be queried via
  the read-only handle.
- Update the per-game source-watermark hash (step 5) to include the new
  table's `(cnt, max_id, max_timestamp)` triple.

**The gold DB is read-only from the API/UI side** — only the ingest worker
writes to it. The detector cache (`detector-cache.sqlite`) is the only
writable store from this codebase.

## 5. Source enum and propagation

Edit `packages/detectors/src/types.ts`:

```ts
export type Source = "bet365" | "kalshi" | "polymarket" | "fanduel";
```

This is a **closed union on purpose**. Every TypeScript consumer narrows on
it; adding a literal forces every downstream type to be updated, which is
exactly the propagation we want.

After extending the union, fix the resulting type errors in this order:

1. Each detector's `sources` array in `packages/detectors/src/<name>/index.ts`
   — set it to whatever the desk wants this detector to read from. The
   registry barrel re-exports the union.
2. `apps/web/src/data/queries.ts` — extend the `detectorSourceSchema` Zod
   enum so the queries-side Zod parse accepts the new literal.
3. Any test fixtures that hard-code `sources: ["bet365","kalshi","polymarket"]`
   — update to the new closed set.
4. Tokens — if the feed needs its own brand token (e.g. a sources-coverage
   badge), declare it in `packages/ui/src/tokens.ts` (no hex literals
   anywhere else).

## 6. Cache watermark inclusion

The board-MAD service caches per game keyed by `(detector, version, params,
source_watermark_hash, game_id)`. The watermark hash is computed in
`apps/api/src/services/board.ts` (`computeGameWatermarkHash`) and must
include **every table the detector reads from**.

To add a feed:

- If the feed writes to `quote_ticks` (the reuse path), no watermark change
  is required — the existing `(cnt, max_id, max_captured_at)` triple over
  `quote_ticks` already covers it.
- If the feed writes to a **new table**, extend `computeGameWatermarkHash`
  to include that table's `(cnt, max_id, max_timestamp)` triple in the
  canonical-JSON tuple.

Verify the cache invalidates by running the same backtest before and after
a new tick from the new source lands. Same params + same game = same hash
when no new data; different hash (and a recompute) the moment ticks arrive.

## 7. Detector source-list updates

For each detector that should now consume the new feed:

- **board-mad** — add the new source to the `sources` array if the feed is
  IP-comparable (i.e. you can normalize its quotes to the unit interval and
  they share the same Yes-side reference). All quote-shaped feeds are
  in-scope; print-only feeds are not.
- **off-price-print** — add the new source **only if** the feed provides
  print tape at the required granularity (one row per executed trade with
  price + size). Quote-only feeds are out of scope. Document the choice
  in the PR.

The SOURCES chip on the Detectors page is generated from `sources`; if you
forget to update the array, the chip silently lies. Tests for the chip
should fail before you forget.

## 8. UI updates

- **Sources chip** on every detector card (`DetectorsPage.tsx`) — generated
  from `detector.sources`, no code change needed once the registry entry is
  updated.
- **Settings → Sources** section — add a row for the new feed showing
  sync status, last error, and tick count. Pull from `/v1/settings`.
- **Source-coverage badges** anywhere a sportsbook or exchange is named
  visually. Default styling uses `text-text-md` + the standard token
  palette; new tokens only if the desk needs a brand color, and only
  declared in `packages/ui/src/tokens.ts`.
- **No icons.** The design language is text-only — keep it that way.

## 9. Tests

Required test layers (in order):

1. **Ingest unit tests** under `apps/worker/` — auth handshake, IP
   normalization for the source's price format, retry/backoff behaviour,
   heartbeat tagging. Use small fixtures from the upstream's documented
   examples.
2. **Fixture-backed integration test** under `apps/worker/tests/` — boot a
   fake upstream (msw, recorded HTTP fixtures), let the worker run end-to-
   end against an in-memory gold DB, assert rows land with the right
   `source_market_id`, `implied_probability`, and `is_heartbeat`.
3. **Per-detector contract test** under
   `packages/detectors/src/<name>/__tests__/` — small fixture of ticks
   from the new source, run board-MAD (or off-price-print) at K=3 and
   K=6, assert fires/no-fires match the desk's expectation. **Anchor at
   least one assertion to a real moment** (a documented anomaly) so a
   regression has somewhere to land.
4. **API integration smoke** under `apps/api/tests/` — call
   `GET /v1/detectors` and assert the new source appears in the right
   detector's `sources` array.
5. **UI integration test** under `apps/web/src/features/detectors/__tests__/`
   — render the page with the new fixture and assert the SOURCES chip
   contains the new source.

Do **not** use mock-only detector tests — the repo defaults to
fixture-backed integration tests against a real (in-memory or fixture-
backed) SQLite. Mocked detectors hide ingest bugs.

---

## Worked example — FanDuel onboarding (minimum-touch path)

Smallest realistic path for adding FanDuel as a quote-only NBA moneyline
feed (no print tape):

1. **Ingest:**
   `apps/worker/src/fanduel/` — Bearer-token auth against the FanDuel
   Trading API; American-odds → unit-interval conversion with documented
   vig-strip (proportional); 5 Hz polling per active game; tag suspends
   as `is_heartbeat`.
2. **Schema:** reuse `source_markets` + `quote_ticks`. No new tables.
3. **Watermark:** no change — the `quote_ticks` triple already covers
   the new rows.
4. **Source enum:** add `"fanduel"` to the union in `types.ts`.
5. **Detector sources:**
   - board-mad: `["bet365","kalshi","polymarket","fanduel"]` (IP-comparable)
   - off-price-print: unchanged (no print tape from FanDuel quotes)
6. **UI:**
   - Detectors page SOURCES chip on board-mad gains "FANDUEL" automatically.
   - Settings → Sources gains a "FANDUEL" row.
7. **Tests:**
   - `apps/worker/src/fanduel/__tests__/normalize.test.ts` — American →
     unit-interval round-trip with vig strip.
   - `apps/worker/tests/fanduel.integration.test.ts` — msw-backed end-to-
     end ingest against an in-memory gold DB.
   - `packages/detectors/src/board-mad/__tests__/fanduel-fixture.test.ts`
     — small NBA-moneyline fixture, K=3 fires, K=6 fires, mean
     ± tolerance documented.
   - `apps/api/tests/detectors.test.ts` — board-mad row contains
     `"fanduel"` in sources.
   - `apps/web/src/features/detectors/__tests__/DetectorsPage.test.tsx`
     — fixture includes fanduel, chip text asserts on it.

Realistic landed-PR cadence: 3–6 stories in `prd.json`, each gated by the
prior. **Do not** try to land all of it in one iteration.

---

## What this doc does NOT cover

- Operational concerns specific to one upstream's TOS or legal review.
- Pricing-data licensing — owner decision before coding.
- Sport extension (new sport with new PBP shape) — that's a different
  doc, scoped under `docs/sport-onboarding.md` (US-041, pending).
- Removing a source — different problem; involves grandfathering existing
  cache rows and announcing a deprecation window to consumers.

If your situation hits one of those, surface it in the PR description and
ask for an owner decision before writing code.
