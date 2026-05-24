// Warmup horizontal slider (US-042; demoted to a secondary auto-form control
// per US-053 AC #8).
//
// The original US-042 placement put this dial side-by-side with the Cry Wolf
// rotary, but US-053 reorganised the prominent rotary slot to host
// CryWolf + Memory. WarmupDial now lives inside the params auto-form below
// the dual rotary dials — so visual weight is dialled down to match the
// other form controls (no 96-px headline that would compete with the rotary
// knobs). Snap chips, verbatim tooltip text, and clamping behaviour are
// preserved verbatim from the original AC.
//
// Bounds and default come from board-mad's paramsSchema.warmupBuckets
// (min 2, max 20, default 8). The dial does not own these constants; it
// receives `value` from the BacktestPage form state and emits `onChange`.
//
// The three snap chips (Default 8 / Eager 4 / Off 2) are labels from the AC
// and commit directly through `onChange` — no separate flash state.

import type { ChangeEvent, JSX } from "react";

const WARMUP_MIN = 2;
const WARMUP_MAX = 20;
const WARMUP_DEFAULT = 8;
const WARMUP_EAGER = 4;
const WARMUP_OFF = 2;

// Verbatim tooltip text per US-042 acceptance criterion 6.
const TOOLTIP_TEXT =
  "Skip the first N buckets before fires can occur. Lower = earlier fires; below ~4 the MAD becomes noisy.";

interface SnapChip {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}
const SNAP_CHIPS: readonly SnapChip[] = [
  { label: "Default (8)", value: WARMUP_DEFAULT, testId: "warmup-dial-chip-default" },
  { label: "Eager (4)", value: WARMUP_EAGER, testId: "warmup-dial-chip-eager" },
  { label: "Off (2)", value: WARMUP_OFF, testId: "warmup-dial-chip-off" },
];

function clampWarmup(n: number): number {
  if (!Number.isFinite(n)) return WARMUP_DEFAULT;
  const rounded = Math.round(n);
  if (rounded < WARMUP_MIN) return WARMUP_MIN;
  if (rounded > WARMUP_MAX) return WARMUP_MAX;
  return rounded;
}

export interface WarmupDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
}

export function WarmupDial({ value, onChange }: WarmupDialProps): JSX.Element {
  const clamped = clampWarmup(value);

  const handleSliderChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const parsed = Number.parseInt(e.target.value, 10);
    if (Number.isFinite(parsed)) onChange(clampWarmup(parsed));
  };

  return (
    <div
      data-testid="warmup-dial-root"
      data-warmup-value={String(clamped)}
      className="flex flex-col items-start select-none"
    >
      <div className="flex items-baseline gap-3">
        {/* Numeric readout — AC #5 ("Current warmupBuckets value displayed
            numerically next to slider with integer precision"). Mono +
            tabular figures so digit width is stable as the value scrubs. */}
        <span
          data-testid="warmup-dial-headline"
          className="tabular font-mono text-text-hi text-2xl leading-none"
        >
          {String(clamped)}
        </span>
        <span className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
          Warmup buckets
        </span>
      </div>

      <input
        type="range"
        min={WARMUP_MIN}
        max={WARMUP_MAX}
        step={1}
        value={String(clamped)}
        onChange={handleSliderChange}
        title={TOOLTIP_TEXT}
        aria-label="Warmup buckets"
        aria-valuemin={WARMUP_MIN}
        aria-valuemax={WARMUP_MAX}
        aria-valuenow={clamped}
        data-testid="warmup-dial-slider"
        className="mt-3 w-48 accent-accent-yellow"
      />

      <div className="mt-3 flex items-center gap-2" data-testid="warmup-dial-chips">
        {SNAP_CHIPS.map((chip) => {
          const active = clamped === chip.value;
          const className = active
            ? "border border-accent-green bg-accent-green px-2.5 py-0.5 text-xs font-mono uppercase tracking-wider text-surface-1"
            : "border border-accent-green bg-transparent px-2.5 py-0.5 text-xs font-mono uppercase tracking-wider text-accent-green hover:bg-accent-green/10";
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => {
                onChange(chip.value);
              }}
              data-testid={chip.testId}
              data-chip-active={active ? "true" : "false"}
              className={className}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
