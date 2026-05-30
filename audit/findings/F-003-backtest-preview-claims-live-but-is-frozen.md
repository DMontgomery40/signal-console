# F-003 — Backtest dial preview claims to update live as you tune, but is frozen at the last run

- **Severity:** HIGH (directly misleads the core tuning workflow with money/training on the line)
- **Boundary crossed:** UI copy / UX promise ↔ runtime behavior
- **Status:** confirmed
- **Surfaces no error:** yes — the number renders fine; it's just answering a
  different question than the label claims.

## The disconnect

The Sensitivity dial's center readout ("Estimated fires/game") and two pieces of
on-page copy assert a **live, in-memory recompute as you move the dial**. The
recompute was removed (see F-002). The readout is now wired to the *last server
run's* stats and does not respond to the dial at all.

Data path (all in `BacktestPage.tsx`):

```
firesPerGamePreview = formatFiresPerGamePreview(..., recomputeView?.stats.firesPerGame)   // :995
recomputeView       = clampedStats(snapshot, form.params)                                  // :987
clampedStats        => { void currentParams; return snapshot.response.stats ... }          // :723-733  (ignores form)
SensitivityDial firesPerGamePreview={firesPerGamePreview}                                   // :1455
SensitivityDial onChange => updateBoardParam(KMAD_PARAM_NAME, next)   // sets form state, NO rerun  :1456-1458
```

So `form.params.kMad` changes when you drag, but `firesPerGamePreview` is derived
only from `snapshot.response.stats` — a value frozen at the moment of the last
**Run** click.

## The false copy

1. Dial caption, `:1460-1463`:
   > "The center readout is estimated fires per game for the last run. **It updates
   > in memory as the trigger moves.**"
   The first clause is accurate; the second is false.
2. Recompute hint, `:1597-1600`:
   > "**Trigger and board-model timing recompute in memory after the first run.**
   > Changing bucketSeconds, weighting, or freshCapSeconds requires re-running."
   This tells the user kMad / warmup / trailing / opening-ramp changes recompute
   live. They do not — they only flip the `stale` flag.

## Why it's dangerous

This is the calibration surface. A scout drags the Sensitivity dial from K=3 to
K=8 expecting the fires/game estimate to fall; the dial-adjacent number — the one
the caption says is tracking the trigger — does not budge. Reasonable
conclusions a user draws, all wrong:
- "K has almost no effect on this detector" → mis-tunes or abandons a good signal.
- "The detector is broken / unresponsive" → tosses a working model.
- Trusts the frozen K=3 fires/game as if it were the K=8 result → promotes the
  wrong params to live.

There **is** a `stale` warning ("Params changed since last run — re-run to
refresh", `:1699-1706`), but it sits in the results panel while two nearer,
louder statements explicitly assert liveness. The mitigation is contradicted by
the very copy beside the control.

## Fix (pick one, then make copy match reality)

- **Preferred:** restore a live preview that calls the **sidecar** on dial
  change (debounced) so the number is honest for both board-mad and state-space.
- **Cheapest honest fix:** delete the "it updates in memory as the trigger moves"
  sentence and the "recompute in memory after the first run" hint; relabel the
  readout "fires/game — last run (re-run to refresh)" and visually tie the dial to
  the `stale` state (e.g. dim/strike the readout when `stale`).
- Either way: add a test asserting the readout changes (or visibly goes stale)
  when the dial moves **without** a rerun — the current tests pass against the
  dead engine (F-002) and never check the live readout's response to a drag.

## Evidence

`BacktestPage.tsx:723-733, 987, 995-999, 1455-1463, 1597-1600, 1699-1706`.

---

## RESOLUTION (fixed 2026-05-30)

The frozen-preview *behavior* is the team's intended post-sidecar design (tests
at BacktestPage.test.tsx:1153 explicitly assert "rows stay pinned to the last
server run"). The defect was the **copy that claimed liveness**. Fixed the copy,
not the behavior:

- Dial caption: removed the false "It updates in memory as the trigger moves";
  now "...estimated fires per game from the last run." Added a stale-aware note
  (`backtest-sensitivity-stale-note`) that appears beside the dial when params
  changed: "Trigger or timing changed since then — re-run to refresh fires/game."
- Recompute hint: replaced "Trigger and board-model timing recompute in memory
  after the first run" with "Changing any parameter after a run ... marks the
  result stale. Re-run the backtest to refresh fires/game."

Now the readout, the new stale note, and the existing results-panel stale
warning all agree: the number is the last run's, and tuning requires a re-run. No
value/behavior change, so the 48 backtest/dial tests stay green (the asserted
caption phrase "center readout is estimated fires per game" was preserved).

Follow-up (not blocking): the test titled "...tracks dial moves without an API
call" now asserts the preview stays equal to baseline — the title is legacy from
the recompute era and reads as if the preview tracks the dial. Consider renaming
to "...pins the preview to the last run (no client recompute)" for honesty.
