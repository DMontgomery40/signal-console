# F-009 — BoardGameStateVolatility carries redundant alias fields (state≡band, headlineScore≡score) and different live consumers already read different aliases

- **Severity:** medium (latent split-brain; agrees today only by producer
  discipline, and the field names actively invite the divergence)
- **Boundary crossed:** producer (shared) ↔ multiple consumers (ranking, alerting,
  UI) ↔ domain type contract
- **Status:** confirmed
- **Surfaces no error:** yes — the two names hold the same value today; the day
  they don't, sorting and alerting silently disagree with no exception.

## The duplication

`BoardGameStateVolatility` (`packages/domain/src/board-anomaly.ts:225-271`)
declares four fields that are really two values:

- `state: BoardGameStateVolatilityBand` **and** `band: BoardGameStateVolatilityBand`
- `headlineScore: number` **and** `score: number`

The producer guarantees each pair is identical
(`packages/shared/src/board-anomaly/game-state-volatility.ts`):

- `band,` (`:706`) and `state: band,` (`:802`) → both the local `band`.
- `headlineScore: score,` (`:767`) and `score,` (`:781`) → both the local `score`.

So `state === band` and `headlineScore === score` always — by assignment, not by
type. The domain type presents them as four distinct concepts.

## Why it's a live trap (not just dead weight)

Different consumers have already chosen different aliases of the same value:

- **Ranking / sort** (`board-anomaly-live-listings.ts`): `stateRank` switches on
  `row.state` (`:154`); the tiebreak sorts on `right.score`/`left.score` (`:170`).
- **Alerting / severity** (`game-state-volatility.ts:873-875`): the alert object
  reads `measurement.headlineScore`, and `severity: scoreToSeverity(measurement.headlineScore)`.

Today these agree because producer assigns the pairs identically. But the names
_invite_ divergence: "headlineScore" reads like a display-clamped/rounded variant
distinct from a raw "score"; "state" reads like a lifecycle status distinct from a
"band". The first maintainer who "adds the obvious distinction" — e.g. makes
`headlineScore` a clamped display value while `score` stays raw — silently splits
the system: alerts fire and severity is computed on one number, the cross-game
list ranks and tiebreaks on a different number, and nothing throws. A desk sees a
game sorted as more severe than the alert it raises, or vice versa. Same failure
mode for `state` (sort key) vs `band` (likely the UI badge): display and ordering
drift apart.

This is the canonical "two differently-named things that don't NEED to agree but
obviously must, with no enforcement" disconnect — inside one live API type that
crosses shared → API → UI.

## Fix (fabric-level)

- Collapse each pair to ONE field in the domain type, the producer, and every
  consumer:
  - `state`/`band` → keep `band` (matches the type `BoardGameStateVolatilityBand`);
    repoint `stateRank` to `row.band`.
  - `headlineScore`/`score` → keep one canonical name (recommend `score` as the
    value, or `headlineScore` if that is the documented output — but exactly one),
    repoint the alert builder + `scoreToSeverity` + the ranker tiebreak to it.
- If a genuine display-vs-raw distinction IS wanted later, introduce it
  deliberately with distinct, honestly-named fields and update ALL consumers in
  the same change — never as a silent edit to one of today's aliases.
- Update `board-anomaly.test.ts` expectations accordingly.

## Evidence

`board-anomaly.ts:225-271` (4-field type); `game-state-volatility.ts:706,767,781,802`
(producer assigns pairs equal), `:873-875` (alert reads `headlineScore`);
`board-anomaly-live-listings.ts:154,170` (ranker reads `state` + `score`).
