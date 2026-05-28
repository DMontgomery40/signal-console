# Odds-API.io NBA live comparator

This is the durable operator contract for the NBA Odds-API.io comparator.
Odds-API.io is `https://api.odds-api.io/v3` plus
`wss://api.odds-api.io/v3/ws`; it is not the older
`api.the-odds-api.com/v4` service.

## Contract

- Credential lookup is `ODDSAPI_API_KEY`, then `ODDS_API_KEY`, then
  `ODDS_API_IO_KEY`. Never write the key into evidence artifacts.
- The account bookmaker spine is
  `Bet365,DraftKings,FanDuel,Kalshi,Polymarket`. Verify it with
  `GET /bookmakers/selected?apiKey=...` before any proof run.
- NBA discovery starts from `GET /leagues?sport=basketball`, then uses the
  NBA slug reported by the API, expected to be `usa-nba` when present.
- Live comparator behavior is WebSocket-first. Use
  `wss://api.odds-api.io/v3/ws` with `markets=ML,Spread,Totals,Player Props`
  and either exact `eventIds` or `leagues=usa-nba`. Do not combine `eventIds`
  and `leagues`.
- The WebSocket client must persist and replay `lastSeq`, track every incoming
  `seq`, detect gaps, ignore stale replay frames for state advancement, and
  treat `resync_required` as a hard signal to refresh from REST before
  reconnecting.
- REST is allowed for initial snapshots, health/readiness checks,
  historical/backfill work, and WebSocket resync/gap repair. When fresh deltas
  are needed, use `GET /odds/updated?since=...`, not repeated full `/odds` or
  `/odds/multi` loops.
- Prediction markets are normalized as first-class books, but Kalshi and
  Polymarket coverage is claimed only when a live Odds-API.io payload proves it
  for the exact event/bookmaker/market family.
- Kalshi player props remain direct-API authoritative for now. This repo
  already ingests Kalshi NBA player props from the direct Kalshi API, while
  Odds-API.io docs/live payloads may not expose equivalent Kalshi prop depth
  yet. Use Odds-API.io as a Kalshi comparator only for the market families it
  actually proves in live payloads; do not replace, downscope, or discredit the
  direct Kalshi player-prop path because Odds-API.io lacks matching coverage.
- Player props are a required NBA proof family. A smoke run that proves only
  ML/spread/totals is useful but not product-ready for Finals coverage.

## Smoke Command

Run from `/Users/davidmontgomery/signal-console`:

```bash
pnpm smoke:odds-api-io:nba
```

Useful flags:

```bash
pnpm smoke:odds-api-io:nba -- --timeout-ms=90000
pnpm smoke:odds-api-io:nba -- --from=2026-06-01T00:00:00.000Z --to=2026-06-15T00:00:00.000Z
pnpm smoke:odds-api-io:nba -- --skip-websocket
```

The command writes redacted, no-secret evidence under
`outputs/odds-api-io-live-comparator/<timestamp>/`:

- `summary.json` and `SUMMARY.md` with selected-bookmaker verification, NBA
  league/event discovery, WebSocket status, REST snapshot/delta status, and
  family-level counts.
- `raw/*.json` for selected bookmakers, basketball leagues, NBA events,
  snapshot odds, and `/odds/updated` responses.
- `raw/websocket-messages.jsonl` for raw WebSocket frame provenance when the
  WebSocket is attempted.

If no NBA Finals events or markets are available in the provider window, the
run is calendar-blocked, not product-ready. Re-run the same command closer to
tipoff or with an explicit date range; do not fill gaps with fixture claims.

## Current implementation boundary

`packages/adapters/src/odds-api-io-live-comparator.ts` contains the
WebSocket-first contract helpers and smoke-path REST helpers. The existing
worker Bet365 Odds-API.io sync is still a REST backup/snapshot path, and the
existing direct Kalshi adapter remains the Kalshi player-prop authority. This
is not the production WebSocket ingestion loop. Persisted DB coverage, Settings
admin visibility, detector/live/recent exposure, and source-watermark proof
remain pending until a real WebSocket ingest writer is wired.
