# F-007 — The board's "source set" is defined three ways that don't agree; the detector `Source` type falsely claims to be the single source of truth

- **Severity:** medium (latent: harmless today, silently changes firing the day FanDuel/DraftKings ingestion is wired — an explicit roadmap item)
- **Boundary crossed:** domain source enum ↔ detector `Source` type/registry metadata ↔ runtime `sourceCount`
- **Status:** confirmed
- **Surfaces no error:** yes — three definitions coexist, nothing forces agreement,
  and the runtime quietly uses a fourth (data-driven) notion.

## Three definitions of "which sources exist"

1. **Domain enum (the official set), 5 sources** —
   `packages/domain/src/live-types.ts`:
   `marketResearchSourceIds = [bet365, fanduel, draftkings, kalshi, polymarket]`
   (+`nba`). The DB `source_markets.source` is unconstrained TEXT, so any of these
   can be persisted.
2. **Detector `Source` type + registry metadata, 3 sources** —
   `packages/detectors/src/types.ts:12`:
   `export type Source = "bet365" | "kalshi" | "polymarket";` with the comment
   _"source has to extend the union here, which forces a single source of truth."_
   `board-mad` and `ensemble-or` declare `sources: ["bet365","kalshi","polymarket"]`;
   this is surfaced to operators in the Settings "About" section and the Backtest
   detector view.
3. **Runtime `sourceCount` / `sourceDominance`, data-driven** —
   `apps/api/src/services/board-volatility-model.ts` derives the state-space
   observation's `sourceCount` from `bucket.sourceMarkets.size` and
   `sourceDominance` from `dominantShare`. It is **not** filtered by the
   detector's declared `sources`; it counts whatever `source_markets` actually
   exist in the bucket.

## Why the comment is wrong and why it matters

The `Source` type calls itself the forcing "single source of truth," but it is a
hand-written union narrower than the domain enum and unbound to it — a second
definition that disagrees with the first. A maintainer adding a source trusts
that comment and edits only the domain enum (or only the detector union), and the
two drift with no test failing.

The runtime makes it worse: `sourceCount` and `sourceDominance` feed the
**state-space fire gate** directly — `volatility.py` uses them in
`_source_trust_multiplier` (one dominant book → harder to fire; many agreeing
sources → easier) and the disagreement bonus. Because that count is data-driven,
the declared `sources: [bet365, kalshi, polymarket]` is **cosmetic** at runtime,
not load-bearing.

Today this is inert: **no adapter produces `fanduel` or `draftkings`** (confirmed
— zero files in `packages/adapters/src` reference them; `odds-api.ts` maps only
`Extract<ResearchSourceId, "bet365"|"kalshi">`, and the only producing adapters
are bet365-direct, kalshi, polymarket). So `sourceCount` currently ranges over
the same 3 sources the registry advertises.

But FanDuel/DraftKings are the documented spine (CLAUDE.md: `Bet365, DraftKings,
FanDuel, Kalshi, Polymarket`). The day an adapter starts persisting DK/FD
`source_markets` for the moneyline board:

- `sourceCount` jumps to 5 and the disagreement/trust multiplier recomputes over
  5 sources — **the board fires differently** — with no code change to the
  detector and no migration.
- The Settings "About" and Backtest UI still say "sources: bet365, kalshi,
  polymarket," so the operator reasons about 3-way agreement while the gate reacts
  to 5-way. A signal that suddenly behaves differently after an unrelated adapter
  lands, with the UI still claiming 3 sources, is exactly the "looks broken / mis-
  tuned for no visible reason" failure.

## Fix

- Make the detector `Source` type actually derive from the domain enum
  (`type Source = MarketResearchSourceId`, or a documented subset built FROM it),
  so the "single source of truth" comment becomes true and drift fails to compile.
- Decide what `registry.sources` means and enforce it: either it's the set the
  runtime counts (then derive both from one place and have the board query filter
  `source_markets` to it), or it's advisory (then label it as "currently
  ingested" and stop implying it bounds the signal).
- Add a test asserting `sourceCount`'s source universe == the detector's declared
  `sources` == a subset of the domain enum, so wiring DK/FD can't silently change
  firing without updating the declared set and the copy.

## Note (confirmed clean this slice)

Adapters convert odds→probability before persisting `implied_probability`:
`bet365-direct.ts` (`probabilityFrom{Decimal,American}`), `odds-api.ts`
(`decimalOddsToProbability`), Polymarket writes its native `[0,1]` price. So no
raw American/decimal odds or 0–100 percentages leak into `implied_probability`
today — F-006's out-of-range-probability path is latent, not active (the
guard-asymmetry fragility still stands).

## Evidence

`detectors/src/types.ts:11-12`; `board-mad/index.ts:97`, `ensemble-or/index.ts:58`,
`off-price-print/index.ts:51`; `live-types.ts:3-15`; `board-volatility-model.ts`
(`sourceMarkets.size` → `sourceCount`, `dominantShare` → `sourceDominance`);
`odds-api.ts` (`Extract<ResearchSourceId,"bet365"|"kalshi">`); no DK/FD adapter.

---

## RESOLUTION (fixed 2026-05-30)

The "three definitions" framing was right; the fix respects the real dependency
shape discovered while fixing: **`domain` imports `detectors`** (board-anomaly
uses board-mad config), so `detectors` cannot import `domain` to type-bind
`Source` — that would cycle. The detector `Source` union is therefore a legitimate
_subset_ of the domain source universe, and the durable fix is to make that subset
relationship enforced rather than asserted:

- `packages/detectors/src/types.ts`: replaced the false comment ("forces a single
  source of truth" — it didn't) with an honest one stating `Source` is the
  consumed-subset of `marketResearchSourceIds`, why it can't be type-bound, and
  where the enforcement lives. Also documented that the live whole-board signal
  counts sources **data-drivenly** (per PRD FR-8), so this union is advertised
  coverage, not a runtime filter — removing the F-008-adjacent confusion.
- `packages/shared/src/__tests__/detector-source-contract.test.ts` (new): iterates
  the detector `registry` and asserts every advertised source ∈
  `marketResearchSourceIds`. Drift (a detector declaring a source the domain
  universe doesn't know) now fails loudly. Hosted in `shared` — the lowest layer
  that depends on both packages.

Verified: `vitest run detector-source-contract` → 4/4 pass; `detectors tsc` clean.
The data-driven `sourceCount` semantics (book-level, by design) were separately
confirmed correct in the F-008 retraction.
