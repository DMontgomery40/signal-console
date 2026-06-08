# F-004 — Sensitivity dial range [2,8] silently disagrees with the kMad contract [1,12]

- **Severity:** medium (calibration tool can't reach part of the deployment range; out-of-range values are misrepresented and silently truncated)
- **Boundary crossed:** backtest tuning UI ↔ detector params contract ↔ Settings UI ↔ live/promote path
- **Status:** confirmed
- **Surfaces no error:** yes — no validation fails; the dial just quietly caps and (on touch) rewrites.

## The disconnect

`kMad` (the "Innovation trigger" / sensitivity) has ONE documented range
everywhere except the backtest dial:

| Surface                       | kMad range  | Source                                                                                               |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| Detector params schema        | **[1, 12]** | `params.ts:68` `z.number().min(BOARD_MAD_K_MAD_MIN).max(BOARD_MAD_K_MAD_MAX)` → `config.ts` `1`/`12` |
| Live defaults / promote       | **[1, 12]** | `apps/api/src/services/detector-defaults.ts` `kMadLive` min/max                                      |
| **Settings page slider**      | **[1, 12]** | `SettingsPage.tsx` imports `BOARD_MAD_K_MAD_MIN`/`MAX`                                               |
| **Backtest Sensitivity dial** | **[2, 8]**  | `SensitivityDial.tsx:12-13` `SENSITIVITY_MIN = 2`, `SENSITIVITY_MAX = 8` — **hardcoded literals**    |

So the tool whose entire job is to _find a good kMad_ can only explore [2, 8],
while the value you actually deploy can be anywhere in [1, 12]. You can run live
at a sensitivity (e.g. K=10 "very calm", or K=1.5 "very hot") that the backtester
structurally refuses to let you test or even display.

## Two concrete failure modes

1. **Unreachable valid range (always).** K in [1, 2) and (8, 12] is valid per the
   contract and settable on the Settings slider, but the backtest dial cannot
   reach it. A scout calibrating sensitivity silently believes 2–8 is "the
   range." When board-mad is the selected detector the plain `kMad` number input
   is removed (the dial owns it — `BacktestPage` drops `backtest-param-kMad`), so
   there is **no** other UI path to a value outside [2,8] on this page.

2. **Misrepresent-then-truncate (when a kMad outside [2,8] reaches the dial).**
   `RotaryDial` clamps only for _display_: `clamped = clampValue(value, min, max)`
   (`RotaryDial.tsx:189`) and `latestValueRef.current = clamped` (`:206-207`), but
   it does **not** `onChange` on mount. So a form `kMad = 10` renders as
   **"8.00"** — the dial actively lies about the current value — and the first
   key/drag commits from the clamped ref (`:245`, `:251`), silently rewriting
   `kMad` to ≤8. Combined with the frozen fires/game preview (F-003), the user
   gets almost no signal that their 10 became an 8. This is a silent mutation of a
   tuning parameter on the surface specifically meant to tune it.

## Aggravating: a stated constraint that looks honored but isn't

`SensitivityDial.tsx:1-5` asserts: "The live and calm values continue to come
exclusively from `@signal-console/detectors` per the project-wide constraint."
Only `K_MAD_LIVE`/`K_MAD_CALM` (the snap points) are imported; the **range
bounds** are hardcoded magic numbers. A reader trusts the comment and assumes the
whole dial tracks config. If `BOARD_MAD_K_MAD_MAX` is ever widened, the dial
stays at 8 with no test catching it — same "lockstep by accident" class as F-001.

## Fix

- Drive the dial from the contract: `valueMin = BOARD_MAD_K_MAD_MIN`,
  `valueMax = BOARD_MAD_K_MAD_MAX` (import from `config.ts`). If a _friendlier_
  default arc is genuinely wanted, derive it from config (e.g. a documented
  `K_MAD_UI_SOFT_MIN/MAX`) and add a test asserting the soft range stays within
  and references the hard `[BOARD_MAD_K_MAD_MIN, MAX]` — never bare 2/8.
- Make `RotaryDial` reconcile an out-of-range incoming `value` honestly: either
  `onChange(clamped)` once on mount (so the form and the display agree) or surface
  the real value rather than rendering a clamped lie.
- Add a test: load `kMad = 11`, assert the dial does not display "8.00" as if it
  were the value, and does not silently truncate on first interaction.

## Evidence

`SensitivityDial.tsx:12-13` (hardcoded 2/8) and `:1-5` (the "from detectors"
claim); `params.ts:68`, `config.ts` (`BOARD_MAD_K_MAD_MIN=1`/`MAX=12`);
`detector-defaults.ts` + `SettingsPage.tsx` (both [1,12]);
`RotaryDial.tsx:189, 206-207, 245, 251` (display-clamp, no mount write-back).
Related: F-003 (frozen preview hides the truncation).
