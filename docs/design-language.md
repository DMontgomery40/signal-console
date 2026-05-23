# Signal Console — Design Language

> One-page spec. Tokens + principles + don'ts. If you're about to add a new color or component pattern, reread this first.

## Lineage

The palette and typographic restraint borrow directly from **bet365**: dark green field, vivid green for structure, vivid yellow for attention, white on green for legibility. Everything else — layout, density, motion, charting — is **forward** of bet365: stripped of icon chrome, denser without cards, charts done Tufte-style, the Cry Wolf dial as the single hero object.

The reference triangle: **bet365** (palette, type), **Linear** (typography craft, restraint), **NYT election needle** (the dial as an experiential object).

---

## Color tokens

All values declared once in `packages/ui/src/tokens.ts`, re-exported via a Tailwind preset, consumed everywhere. **No hex literals outside this file.**

| Token            | Hex       | Role                                                                                            |
| ---------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `surface-0-from` | `#06140E` | App background, top of gradient                                                                 |
| `surface-0-to`   | `#0E2A1F` | App background, bottom of gradient (subtle vertical gradient on `<body>` only)                  |
| `surface-1`      | `#0F2419` | Cards, panels, dial track                                                                       |
| `surface-2`      | `#163020` | Row hover, focused list item                                                                    |
| `accent-green`   | `#14EB6F` | Brand/structural — nav underline, live pulse, "recent" active, positive deltas                  |
| `accent-yellow`  | `#FFD000` | **Fires only.** Anomaly markers, active K value on the dial, suspend warnings. Earn the yellow. |
| `negative`       | `#FF5757` | Used sparingly — error banners, negative deltas in dense tables                                 |
| `text-hi`        | `#FFFFFF` | Headings, primary numerics                                                                      |
| `text-md`        | `#B4C4BD` | Body, secondary metadata                                                                        |
| `text-lo`        | `#6E7E77` | Labels, axis ticks, helper text                                                                 |

**Rules:**

- Yellow only marks fires/anomalies/the active K. If a screen has yellow with no fires on it, something is wrong.
- Negative red appears at most once per screen, only when contrasting positive.
- The gradient applies to `<body>` exclusively — no per-panel gradients, no card gradients.
- All non-token-color literals (e.g. `#fff`, `rgb(...)`, named colors) are forbidden in component code.

---

## Typography

| Family | Stack                                                                         | Use                                                                   |
| ------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Sans   | `Inter, "Geist Sans", system-ui, sans-serif`                                  | All UI text, headings, body                                           |
| Mono   | `"JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace` | All numerics — fire counts, K values, timestamps, prices, deltas, IDs |

**Scale (Tailwind):** `text-xs 12 / text-sm 13 / text-base 14 / text-lg 16 / text-xl 20 / text-2xl 28 / text-3xl 40 / text-4xl 64` — pixel sizes locked, no fluid type.

**Weights:** 400 (body), 500 (emphasis), 600 (headings). No 700+ except the K-value display.

**Tabular figures locked** on every monospace text element via `font-variant-numeric: tabular-nums`. Numbers must align column-wise without thinking.

---

## Layout & density

- **Single horizontal top nav** of five text links: `Recent / Live / Backtest / Detectors / Settings`. Active route gets a 2px `accent-green` underline (bet365's "All Sports" pattern). No sidebar.
- **Full bleed, max content width 1440px** centered. No bordered cards by default — separate sections with whitespace (≥ 32px vertical) and the type hierarchy.
- **Time is the only axis.** Every primary surface reads left-to-right as a timeline. Recent is a stack of horizontal sparkline-style timelines, one per game. Live is one game at higher resolution. Backtest is the same shape, scaled to the chosen window.
- **Spacing scale:** 4px base (Tailwind default). Comfortable density target: list rows 40–48 px tall, generous line height (1.5 body, 1.2 heading).
- **No cards with borders.** Use surface-1 fills + whitespace. A hovered row gets `bg-surface-2`.

---

## Motion

| Element                  | Behavior                                      | Duration | Easing        |
| ------------------------ | --------------------------------------------- | -------- | ------------- |
| Live indicator           | Opacity pulse 0.4 → 1.0                       | 1500 ms  | `ease-in-out` |
| Hover (any)              | Color/background fade                         | 100 ms   | `ease-out`    |
| Route transition         | Crossfade                                     | 150 ms   | `ease-out`    |
| Dial drag                | None — value updates synchronously, no easing | —        | —             |
| Chart update on K change | Markers fade in                               | 200 ms   | `ease-out`    |

No bouncy springs, no parallax, no scroll-jacking, no entrance animations on initial mount.

---

## The Cry Wolf dial (centerpiece)

The single chunky thing on the entire app. Specs:

- **Track:** `surface-1`, 8 px tall, rounded full.
- **Thumb:** 32 px diameter, `accent-yellow` filled, 2 px white inner ring. Active drag area extends 24 px beyond the thumb for fat-finger tolerance.
- **K value display:** Mono, 64 px (`text-4xl`), `accent-yellow`, 2-decimal precision, positioned above the thumb.
- **Snap detents:** at K=3.0 (`Sensitive`) and K=6.0 (`Calm`). Detent feedback is a subtle 1 px white tick on the track + the K value flashing `text-hi` for 80 ms when the snap engages. No sound.
- **Label chips:** below the slider, `accent-green` outline (1 px) for the unselected, filled `accent-green` background for the active snap. Click to snap.

Everything else on the Backtest page recedes so the dial earns its prominence.

---

## Charts (Recharts theme)

Strip Recharts to the bone. Custom theme exported from `packages/ui/src/chart-theme.ts`.

- **Lines:** 1 px stroke, `accent-green` for normal, `accent-yellow` for above-threshold buckets.
- **Markers:** 6 px filled circle `accent-yellow` for fires; nothing else marked.
- **No gridlines, no axis labels** until hover.
- **On hover:** subtle vertical hairline (`text-lo`, 1 px dashed), tooltip in `surface-1` with token-bordered top edge in `accent-green`.
- **Empty states:** monospace one-line message in `text-lo`, no illustration.

---

## Components style

- **Buttons:** text + 1 px `accent-green` outline; hover fills `accent-green` background with `surface-0` text. No drop shadows.
- **Inputs:** `surface-1` background, 1 px `text-lo` border, focus border `accent-green`. No floating labels.
- **Status indicators:** dot + label, never icons. Dot is `accent-green` (live), `text-lo` (idle), `accent-yellow` (firing), `negative` (error).
- **Lists/tables:** zebra forbidden. Use whitespace + tabular figures + row hover.
- **Tooltips:** `surface-1` fill, `text-md`, no shadow, 1 px `text-lo` border on top edge only.

---

## Don't

- Don't add a third accent color. Yellow + green is the contract.
- Don't add icons. The app has none in v1. If something needs explanation, write text.
- Don't add a light mode. Dark only.
- Don't add card borders. Whitespace + surface fills do the work.
- Don't add drop shadows. Flat surfaces.
- Don't introduce emoji.
- Don't introduce promotional/marketing UI patterns (sticky CTAs, "what's new" toasts, badges over avatars).
- Don't animate on initial mount. Only on interaction.
- Don't use a fluid type scale. Pixel sizes are locked.
- Don't use hex literals outside `tokens.ts`.

---

## Acceptance for UI stories

Any UI story (US-022 onward) is incomplete until:

1. All colors are sourced from `packages/ui/src/tokens.ts`. Grep for hex literals outside the tokens file = automatic fail.
2. All numeric text uses `font-mono` with `tabular-nums`.
3. Dark mode is the only mode (no `dark:` Tailwind variants needed because there is no light mode).
4. Verified in the browser using the dev-browser skill at 1440 × 900 baseline.
