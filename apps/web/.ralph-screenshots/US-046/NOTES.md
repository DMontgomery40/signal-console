# US-046 — ExplainerCard visual verification

Visual screenshots for US-046 were intentionally NOT captured by Ralph
because the Playwright MCP and computer-use MCP have hung indefinitely
on this machine twice during prior US-046 UI verification attempts (see
scripts/ralph/CLAUDE.md "KNOWN HANG MODE" — same signature both times:
claude process sleeps at 0% CPU, API child process dies, no MCP response
ever returns, watchdog has to kill the run).

Per the CLAUDE.md HTTP-smoke fallback rule, the feature is verified
without Playwright by:

- 24 component-level tests in packages/ui/src/__tests__/ExplainerCard.test.tsx,
  run under vitest + jsdom + @testing-library/react + @testing-library/user-event,
  asserting:
  - the trigger applies `border-b border-dashed border-text-lo/50 cursor-help`
    with `data-explainer-id="<id>"`,
  - the HoverCard opens on hover and exposes the "Plain English" + "Formal"
    section labels,
  - KaTeX math is RENDERED (DOM contains `.katex` nodes), not raw `$...$`,
  - Escape dismisses the card,
  - multi-paragraph eli5 renders as separate `<p>` elements,
  - the dev-mode warning fires when an `eli5` body contains a `$`,
  - an unknown ExplainerId renders children pass-through with a dev warning,
  - every authored explainer id renders cleanly (no KaTeX parse errors,
    no thrown markdown).

- a static-build HTTP smoke (`pnpm --filter @signal-console/web build` +
  `pnpm dlx serve`) confirms the production bundle:
  - contains the trigger class `border-b border-dashed border-text-lo` (the
    visible underline cue on every wrapped term),
  - contains the HoverCard content class `explainer-card-content`,
  - references all 10 explainer ids wired into BacktestPage + DetectorsPage:
    board-mad, bucket-seconds, fires-per-game, fresh-cap-seconds,
    k-mad / k-mad-sensitive / k-mad-calm, off-price-print, trailing-buckets,
    warmup-buckets, weighting,
  - ships the bundled KaTeX CSS (`@import "katex/dist/katex.min.css";` from
    packages/ui/src/global.css; the CSS bundle contains "katex").

The owner can capture the five required screenshots (trigger underline
baseline; HoverCard open with eli5 visible; scrolled-to-formal LaTeX;
trigger→card mouse traversal; unknown-id passthrough) manually when the
MCP hang is resolved. The functional contract is already verified above.
