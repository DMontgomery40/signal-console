# Signal Console — Design Language

> One-page spec. Tokens + principles + don'ts. If you're about to add a new color or component pattern, reread this first.

## Lineage

The palette and typographic restraint borrow directly from **bet365**: dark green field, vivid green for structure, vivid yellow for attention, white on green for legibility. Everything else — layout, density, motion, charting — is **forward** of bet365: stripped of icon chrome, denser without cards, charts done Tufte-style, the Cry Wolf dial as the single hero object.

The reference triangle: **bet365** (palette, type), **Linear** (typography craft, restraint), **NYT election needle** (the dial as an experiential object).

---

## Color tokens

All values declared once in `packages/ui/src/tokens.ts`, re-exported via a Tailwind preset, consumed everywhere. **No hex literals outside this file.**

| Token            | Hex       | Role                                                                                                                                                                                                       |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface-0-from` | `#06140E` | App background, top of gradient                                                                                                                                                                            |
| `surface-0-to`   | `#0E2A1F` | App background, bottom of gradient (subtle vertical gradient on `<body>` only)                                                                                                                             |
| `surface-1`      | `#0F2419` | Cards, panels, dial track                                                                                                                                                                                  |
| `surface-2`      | `#163020` | Row hover, focused list item                                                                                                                                                                               |
| `accent-green`   | `#14EB6F` | Brand/structural — nav underline, live pulse, status dots, "ok" state, secondary actions ("Open Alerts" pattern)                                                                                           |
| `accent-yellow`  | `#FFD000` | **Action + positive + anomaly.** Primary CTAs (buttons you want clicked), fires/anomaly markers, active K value on the dial, positive deltas, suspend warnings. The bet365 "Join button + plus-odds" role. |
| `negative`       | `#FF5757` | Used sparingly — error banners, negative deltas in dense tables                                                                                                                                            |
| `text-hi`        | `#FFFFFF` | Headings, primary numerics                                                                                                                                                                                 |
| `text-md`        | `#B4C4BD` | Body, secondary metadata                                                                                                                                                                                   |
| `text-lo`        | `#6E7E77` | Labels, axis ticks, helper text                                                                                                                                                                            |

**Rules:**

- **Every screen with an action shows yellow.** Primary CTAs are yellow-outlined buttons. Yellow also marks fires, anomaly markers, the active K value, and positive deltas. Yellow is scarce but **visible on every page** — that's the bet365 lineage. A screen with no yellow at all (no CTA, no fire, no positive delta) is a sign you're either on a pure-display surface or missed an affordance.
- **Don't sprinkle yellow.** No yellow chrome, decoration, gridlines, or hover ornaments. Yellow says "click me / fire / good news" — nothing else.
- **Green is the structural quiet.** Nav underline, live pulse, status dots, the "Open Alerts"-style secondary action. Green is not a CTA color.
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

**This is a rotary dial — a circular knob you turn — not a horizontal slider.** The original plan, the video, and the trader mental model all say "dial." The UI must match that — a tactile-looking knob that a desk operator would reach to grab.

**Aesthetic level:** ~20% of the way from "minimal flat" toward "fully rendered 3D knob." Inspiration: an analog audio potentiometer (Sennheiser volume, Yamaha mixing console, hi-fi tuning dial). It looks like a real thing, but the depth is implied by flat hairlines, not raster shadows. **NO** dynamic shadows, **NO** 3D / WebGL rendering, **NO** haptics, **NO** GPU-blurred glows.

**Geometry (all SVG):**

- **Knob body:** 160 px diameter circle, `surface-1` fill.
- **Inner bezel ring:** 1 px inset stroke, `text-lo` at 30% opacity, 4 px inside the knob edge. Implies machined metal lip; no drop shadow.
- **Outer bezel:** 192 px diameter ring (16 px wider than knob), 1 px `text-lo` at 30% opacity. Holds the tick marks.
- **Ticks:** every 1.0 K from K=2 to K=8 = 7 ticks across a 270° travel arc (K=2 at -135°, K=5 at 0°, K=8 at +135°). Each tick is a 12 px line, `text-lo`. Major ticks at K=3 and K=6 (the snap detents) are 16 px and `accent-green`.
- **Indicator:** 3 px wide line from center to bezel edge (radius 88 px), `accent-yellow` stroke, rounded ends. Rotates with the knob. A 0.5 px lighter `accent-yellow` hairline along its leading edge suggests bevel depth without a shadow.
- **K value (inside the knob):** mono 32 px (`text-2xl`), `accent-yellow`, 2-decimal precision, centered.
- **K value (large above):** mono 96 px (add `text-5xl 96 px` token if not present — used here and nowhere else), `accent-yellow`, 2-decimal precision. Sits above the knob when the dial is the focal point; this is the bet365-style oversized headline number.

**Interaction:**

- **Vertical drag:** mousedown anywhere inside the knob, then drag up to raise K, down to lower K. 200 px of vertical travel = full 270° rotation = K range 2.0 → 8.0. Drag is the primary interaction.
- **Click a tick mark:** snaps the dial to that K value (instant, no animation longer than the 50 ms snap-magnetize below).
- **Click a snap chip** ("Sensitive" K=3, "Calm" K=6): snaps with an 80 ms `text-hi`→`accent-yellow` flash on the inline K value.
- **Wheel / scroll over knob:** each tick = ±0.25 K.
- **Keyboard (when focused):** ← ↓ = -0.25, → ↑ = +0.25, PageUp/Down = ±1.0, Home/End = K=2.0/8.0.
- Touch: vertical pan, same mapping. No haptic vibration.

**Snap detents:**

- At K=3.0 ("Sensitive — live default") and K=6.0 ("Calm — comparison preset"). Both tick marks rendered in `accent-green` (vs `text-lo` for non-snap ticks).
- **Magnetize behavior:** when the dragged value lands within ±0.1 K of a snap, the indicator smoothly transitions to the exact snap value over 50 ms — no bounce, no spring, just a tight ease-out to lock in.

**Snap chips (below the knob):**

- Two chips horizontally: `Sensitive` and `Calm`. `accent-green` 1 px outline for unselected, filled `accent-green` background + `surface-0` text for the currently-active snap. Click to snap. Same chip styling pattern as elsewhere; the only "selected" state in the whole app.

**The "20% toward rich" deltas vs a flat circle:**

1. The 1 px inset bezel ring (machined-edge hint).
2. The 16 px outer bezel ring with tick marks (looks mounted, not painted-on).
3. Major-tick differentiation in `accent-green` (subtle, only the two snap positions get the brand color).
4. The indicator line's 0.5 px bevel hairline (depth without shadow).
5. Tick tips have a 1 px `text-hi` at 10% opacity (faint glow without `box-shadow`).

That's it. Anything beyond these five — drop shadows, gradients, glow filters, animated rotation on idle — is over the line.

**Everything else on the Backtest page recedes** so the dial earns its prominence. The dial is the only object on its row; the params form (US-035) lives below it; the per-game timelines (US-038) live below that.

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

- **Buttons (primary CTA):** text + 1 px `accent-yellow` outline; hover fills `accent-yellow` background with `surface-0` text. This is the bet365 "Join button" treatment — apply to Reload, Refresh, Run Backtest, Clear Cache, and any action you want the user to take. No drop shadows.
- **Buttons (secondary action):** text + 1 px `accent-green` outline; hover fills `accent-green` background with `surface-0` text. Use for "Open Alerts"-style affordances — informational/navigational, not the primary intent of the page.
- **Inputs:** `surface-1` background, 1 px `text-lo` border, focus border `accent-green`. No floating labels.
- **Status indicators:** dot + label, never icons. Dot is `accent-green` (live), `text-lo` (idle), `accent-yellow` (firing), `negative` (error).
- **Lists/tables:** zebra forbidden. Use whitespace + tabular figures + row hover.
- **Tooltips (quick label only):** `surface-1` fill, `text-md`, no shadow, 1 px `text-lo` border on top edge only. Use for terse one-liners ("scheduled start time", "team identifier"). For anything substantive, use Explainer Cards.

---

## Explainer Cards (hover for verbose, multi-paragraph, LaTeX-capable explanations)

Many numbers and concepts in this app (`K_MAD`, `fires/game`, the various detector params, "median + K·MAD" itself, "implied probability", "MAD") are non-obvious to a sports-brain trader. A bet365 user knows "+115" — they may not know "trailing median absolute deviation." Explainer cards close that gap **without** dumbing the app down or requiring a "Help" page.

**Primitive:** Radix UI `HoverCard` (not `Tooltip` — `Tooltip` auto-dismisses on blur and disallows interactive content; we need the user to be able to move the mouse INTO the card and scroll).

**Trigger discoverability — subtle but visible:**

- Any term/number with an attached explainer renders with a 1 px `text-lo` 50%-opacity dashed underline. No icon, no `(?)`, no superscript.
- Cursor turns to `help` on hover (`cursor: help`).
- That's it. The underline says "there's more here" without shouting it.

**Card layout (two sections, vertically stacked):**

```
┌──────────────────────────────────────────────────────────┐
│ <small-caps text-lo> Plain English </small-caps>         │
│                                                          │
│ <text-md sans>                                           │
│   Multi-paragraph ELI5 explanation in sports-trader      │
│   voice. We avoid math jargon here. Not condescending —  │
│   just plain. Two or three paragraphs is fine.           │
│ </text-md sans>                                          │
│                                                          │
│ ────────────────────────────────────────────  (1 px lo) │
│                                                          │
│ <small-caps text-lo> Formal </small-caps>                │
│                                                          │
│ <text-md mono with KaTeX>                                │
│   Technical explanation. Real terminology, the formula   │
│   in LaTeX, a note on why this estimator vs another.     │
│   Readable by a "normal-small nerd" — not IMO-only.      │
│                                                          │
│   intensity_t > median(B_{t-W..t-1}) + K · MAD(...)      │
│                                                          │
│   (Above renders via KaTeX block-math.)                  │
│ </text-md mono>                                          │
└──────────────────────────────────────────────────────────┘
```

**Sizing:** `max-width: 480 px`, `max-height: 60vh`, **internal scroll** (overflow-y: auto). The card persists while the cursor is over it OR over the trigger, so users can scroll without it closing.

**Hover bridge & persistence:**

- Radix HoverCard config: `openDelay: 150 ms`, `closeDelay: 200 ms`, `disableHoverableContent: false`.
- 8 px transparent bridge zone between trigger and card edge so the cursor can cross the gap without dismissal.
- A click outside dismisses; pressing `Escape` dismisses; tab-focus dismisses sibling cards before opening a new one.

**Styling:**

- `surface-1` fill, 1 px `accent-green` top-edge border (matches the regular Tooltip pattern), all other edges borderless.
- Internal padding 16 px.
- Section labels ("Plain English" / "Formal") rendered in `text-lo`, `text-xs`, `letter-spacing: 0.08em`, uppercase.
- Section divider: 1 px `text-lo` 30%-opacity, 24 px vertical margin on each side.
- Fade in 100 ms, fade out 100 ms.
- Custom scrollbar: 6 px wide, `surface-2` track, `text-lo` thumb.

**Content source:** all explainer copy lives in `packages/ui/src/explainers.ts` as a typed record keyed by concept id. Each entry has `{ title, eli5, formal }` where `eli5` is markdown (sports-trader voice, prose only) and `formal` is markdown with KaTeX delimiters (`$inline$`, `$$block$$`) for math. The data file is the single source of truth — components reference by id, never inline copy.

**Rendering:** the card body is `react-markdown` + `rehype-katex` + `remark-math`. KaTeX CSS imported once in `packages/ui/src/global.css`. No MathJax (slower, larger).

**Voice guidelines (enforced by review):**

- ELI5: second person OK, conversational, no jargon. "We watch how much every market on a game wiggles relative to its own recent calm" not "Robust dispersion of intra-game implied-probability deltas." Two or three short paragraphs. Tell them what the number means for _their job_ (deciding whether to suspend a market), not for the algorithm's job.
- Formal: technical but not IMO-only. Define notation the first time it's used. Always say WHY this estimator vs the obvious alternative ("MAD over std because a single outlier from a vacated-position blip would otherwise dominate"). Cite the canonical source (e.g. `scripts/board_signal_v2.py:33`).

**Don't:**

- Don't put an `(?)` icon next to the term. The dashed underline is enough.
- Don't write the same explainer twice — one entry per concept, referenced everywhere.
- Don't render LaTeX in the ELI5 section. If you need a formula, you're in the wrong section.
- Don't truncate. If the explanation needs a thousand words, write a thousand words — that's what the scrollbar is for. Short is preferred but not mandatory.

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
