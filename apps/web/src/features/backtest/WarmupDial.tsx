// Warmup horizontal slider (US-042).
//
// Sibling of the Cry Wolf rotary dial (US-036). Unlike CryWolf — which is a
// rotary potentiometer because the trader mental model is an analog knob —
// the warmup is a linear-feel "how many leading buckets to skip" so a
// horizontal range slider is the right primitive (per AC #2: `input
// type=range`).
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
      className="flex flex-col items-center select-none"
    >
      {/* Headline value — mirrors the CryWolf K headline visual weight (96 px
          accent-yellow tabular mono) so the two dials read as a pair. */}
      <div
        data-testid="warmup-dial-headline"
        className="tabular font-mono leading-none text-accent-yellow"
        style={{ fontSize: "96px" }}
      >
        {String(clamped)}
      </div>

      <span className="mt-2 text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
        Warmup buckets
      </span>

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
        className="mt-4 w-48 accent-accent-yellow"
      />

      <div className="mt-4 flex items-center gap-3" data-testid="warmup-dial-chips">
        {SNAP_CHIPS.map((chip) => {
          const active = clamped === chip.value;
          const className = active
            ? "border border-accent-green bg-accent-green px-3 py-1 text-xs font-mono uppercase tracking-wider text-surface-1"
            : "border border-accent-green bg-transparent px-3 py-1 text-xs font-mono uppercase tracking-wider text-accent-green hover:bg-accent-green/10";
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
