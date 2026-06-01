# F-008 — RETRACTED (family thesis was wrong): the board is whole-board BY DESIGN. Real residual: book-vs-market source counting is misnamed + schema-version-dependent

- **Original severity:** medium–high → **RETRACTED as a defect.** The premise was
  wrong. Replaced by a low–medium naming/legacy-fallback residual (below).
- **Status:** corrected after researching design intent (design-language + owner
  confirmation). The old root PRD is retired and deleted, so it is not live
  authority.

## Retraction — the family-blind loader is CORRECT

I initially flagged that `loadBoardMadTicksForGame` pools all market families
(no family filter) and suspected it should be moneyline-only. **That is the
intended design, not a bug.** The board signal is deliberately _whole-board_:

- **`docs/design-language.md:223`:** the canonical explainer voice is "We watch
  **how much every market on a game wiggles** relative to its own recent calm,"
  framed for the operator's job of "deciding whether to **suspend a market**."
- **Owner confirmation:** the board is meant to span _everything_ — every market
  is a potential needle; filtering families would _remove needles_. The breadth
  normalizer (÷ `activeMarketCount`) exists precisely because it pools all markets.

Adding a moneyline (or game-lines) family filter would have **corrupted the core
signal** — the exact destructive change this audit exists to prevent. Lesson
logged: confirm design intent from active docs/owner before "fixing" a signal
whose name (`whole-board`) already states the intent. `sanitizeTicks`
(`board-volatility-model.ts:35-50`) correctly keeps all non-heartbeat,
real-probability (≠ 0.5), finite-volume ticks across every family — by design.

## The real (narrow) residual — book vs market counting

While verifying, the genuine subtlety: `sourceCount` / `sourceDominance` /
`sourceDisagreement` feed the state-space `sourceTrust` gate and are meant to be
**cross-book** (how many independent _books_ agree), per the contract in
`docs/board-volatility-state-space.md` ("source dominance / agreement / count").
The implementation in `board-volatility-model.ts`:

- `tickSourceKey = tick.source ?? tick.sourceMarketId` (`:56-58`).
- `bucket.sourceMarkets.add(sourceKey)` (`:103`) — **misnamed**: the set holds the
  _sourceKey_ (the book, when `tick.source` is present), not source-market ids.
- `sourceCount: bucket.sourceMarkets.size` (`:145`).

Two problems, both invisible:

1. **Misnaming (cognitive trap).** A maintainer reading `sourceMarkets.size →
sourceCount` reasonably concludes the gate counts distinct _markets_. It
   actually counts distinct _books_ (when source is populated). The name lies
   about which quantity drives firing. `activeMarkets` (`:102`) is the real
   market set → `activeMarketCount`. The two sets are easy to confuse.

2. **Schema-version-dependent meaning (latent).** `tick.source` is populated only
   when `sourceMarketsHaveSourceColumn(goldDb)` is true; otherwise the loader
   selects `NULL AS source` (`board-mad-context.ts:80-82`). On a gold DB without
   the `source` column, every `sourceKey` falls back to `sourceMarketId`, so
   `sourceCount` silently becomes per-**(book×market)** instead of per-book, and
   `sourceDominance`/`sourceDisagreement` recompute over source-markets, not
   books — a different fire/disagreement profile with **no error**. The current
   migrations have `source_markets.source TEXT NOT NULL`, so production is
   book-level and correct _today_; the degradation is a legacy/edge fragility.

## Fix (small, mechanics-level)

- Rename `bucket.sourceMarkets` → `bucket.contributingSources` (or
  `bookKeys`) and `sourceCount`'s comment to state it is distinct _books_, so the
  name matches the contract. Distinguish it unmistakably from `activeMarkets`.
- Make the `NULL AS source` fallback explicit: either drop the legacy branch (the
  column is `NOT NULL` now) or, if kept, assert/log that source-trust degrades to
  per-market on a column-less DB so the meaning shift can't pass silently.
- Optional test: a bucket with 1 book quoting 3 markets should yield
  `sourceCount == 1` (not 3) when `source` is populated — pins book-level
  semantics against the misnaming.

## Evidence

`docs/design-language.md:223`; `board-volatility-model.ts:35-50,56-58,102-103,145`;
`board-mad-context.ts:80-82`; `migrations.ts:117` (`source NOT NULL`).

---

## RESOLUTION of the residual (2026-05-30)

The family-blind loader was left UNCHANGED (correct by design — whole-board). The
narrow book-vs-market residual is fixed:

- `board-volatility-model.ts`: renamed the misleading `sourceMarkets` set →
  `contributingSourceKeys` and documented that it holds BOOK keys
  (`tickSourceKey = tick.source ?? sourceMarketId`), feeding the book-level
  `sourceCount` — distinct from `activeMarkets` (market-level breadth). The comment
  also flags the legacy `NULL AS source` degradation path.
- `apps/api/tests/board-volatility-model.test.ts`: new test pins the semantics —
  one book quoting two markets yields `sourceCount: 1` (book) and
  `activeMarketCount: 2` (markets), so a refactor can't silently turn the
  source-trust input into a market count.

Verified: `apps/api tsc` clean; board-volatility-model suite 5/5 pass.
