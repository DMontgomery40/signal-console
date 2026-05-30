# F-008 — The state-space board loader pools ALL market families with no family filter, while its sibling board-anomaly model is family-aware

- **Severity:** medium–high, **pending design-intent confirmation** (if the board is
  meant to be moneyline win-probability, this silently corrupts the core signal;
  if it's meant to be all-market churn, the copy/semantics are under-specified and
  mixing probability scales is still questionable)
- **Boundary crossed:** DB (`quote_ticks` across families) ↔ board-mad/state-space
  detector input ↔ the sibling board-anomaly model's family model
- **Status:** confirmed mechanism; active-vs-latent and intended-vs-bug need an owner call
- **Surfaces no error:** yes — the signal is just computed over a different market
  set than its name implies; nothing throws.

## The mechanism (confirmed)

`apps/api/src/services/board-mad-context.ts` `loadBoardMadTicksForGame` selects:

```sql
SELECT ... qt.implied_probability, COALESCE(qt.volume,0) ...
FROM quote_ticks qt
JOIN source_markets sm ON sm.id = qt.source_market_id
WHERE sm.game_id = ?  AND qt.captured_at BETWEEN ? AND ?
```

There is **no filter on market family or instrument** — not in the SQL, not in
`rowToTick`, and the detector never even SELECTs `family`, so it cannot filter
what it never loads. Every `quote_tick` for the game is treated as one
interchangeable probability stream and fed into the board intensity
(`log(1+v)·|Δp|`) and into `sourceCount` / `sourceDisagreement`.

Meanwhile `quote_ticks` demonstrably holds multiple families:

- `appendQuoteTick` (`live-repository.ts`) is family-agnostic — it writes whatever
  `source_market_id` it's handed.
- The Kalshi adapter (`kalshi-direct.ts`) emits `moneyline, spread, total,
  team-prop, player-prop, other`; the odds-api classifier emits
  `moneyline/spread/total/player-prop`.
- The Live view's own tick schema carries `rawFamily`/`rawLabel` (F-006), i.e. the
  product expects mixed families in `quote_ticks`.
- CLAUDE.md states Kalshi **NBA player props** are actively ingested, and they
  share the NBA game's `game_id`.

So for a game with prop/spread/total markets, those ticks' `implied_probability`
(a spread-cover prob, a total-over prob, a player-prop prob — different
quantities, all in [0,1]) are pooled into the "whole-board **win-probability**
volatility" intensity and inflate the source count that gates firing.

## Why I'm not calling it a flat bug

The detector's displayName is **"Board State-Space (whole-board volatility)."**
"Whole-board" could legitimately mean "how much is the entire board of markets
churning," in which case pooling families is intentional and the breadth
normalizer (`activeMarketCount`) is consistent with it.

The disconnect that is NOT ambiguous: the **sibling** board-volatility model —
the board-anomaly residual detector (`board-volatility-baselines.ts`,
`board-volatility-model.ts`) — is explicitly **family-aware**: it computes
`coreFamilies`, `distinctCoreSources`, `predictionMarketRows`, and buckets
baselines by `core_family_bucket`. So two sibling "board volatility" models
disagree on whether market family matters: one buckets by it, the other is blind
to it. At most one of those reflects the real intent; the other is wrong or
mislabeled.

## The risk, both ways

- **If the board is meant to be moneyline win-probability:** prop/spread/total
  ticks silently corrupt the intensity AND inflate `sourceCount` /
  `sourceDisagreement` (more families → more "sources" → easier/harder firing via
  the source-trust multiplier). The corruption scales with how many non-moneyline
  markets a game has — so a calibrated K behaves differently on prop-rich games,
  the exact "great model looks erratic for no visible reason" failure.
- **If it's meant to be whole-board churn:** then (a) `|Δp|` is pooling
  heterogeneous probability types as if equivalent, which needs justification, and
  (b) the explainers and `sourceCount`/`sourceDisagreement` semantics must say
  "all markets," because a desk operator reading "board volatility" on a
  win-probability product will assume moneyline.

## Confirm before fixing (cheap, decisive)

On the gold DB, for a representative board game (e.g. `nba-0042500222`):

```sql
SELECT mi.family, COUNT(*) AS ticks
FROM quote_ticks qt
JOIN source_markets sm ON sm.id = qt.source_market_id
LEFT JOIN market_instruments mi ON mi.id = sm.instrument_id
WHERE sm.game_id = 'nba-0042500222' AND qt.implied_probability IS NOT NULL
GROUP BY mi.family;
```

If anything but `moneyline` returns rows, the pollution is active today.

## Fix (if moneyline-intended)

- Filter the board loader to moneyline instruments
  (`JOIN market_instruments mi ON mi.id = sm.instrument_id AND mi.family = 'moneyline'`),
  or to source_markets mapped to a moneyline instrument.
- Add a test/fixture with a prop tick in the window asserting it does NOT change
  board intensity or `sourceCount`.
- Reconcile with the family-aware board-anomaly model so the two siblings share
  one definition of "the board."

## Evidence

`board-mad-context.ts:85-136` (no family filter); `live-repository.ts`
`appendQuoteTick` (generic writer); `kalshi-direct.ts` (multi-family producer);
`board-volatility-model.ts` / `board-volatility-baselines.ts` (family-aware
sibling); `live.ts` route + web tick schema carry `rawFamily` (F-006).
