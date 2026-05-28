// Opening-holdoff slider (US-042).
//
// Controls `warmupBuckets`: an elapsed holdoff of N * bucketSeconds before
// the detector can emit its first fire. It sits beside the
// volatility-lookback slider because the two timing choices jointly decide how
// quickly the signal trusts current-game data.

import type { ChangeEvent, JSX } from "react";

import {
  BOARD_MAD_WARMUP_BUCKETS_DEFAULT,
  BOARD_MAD_WARMUP_BUCKETS_MAX,
  BOARD_MAD_WARMUP_BUCKETS_MIN,
} from "@signal-console/detectors/board-mad/config";
import { ExplainerCard } from "@signal-console/ui";

import { formatBucketDurationForDisplay } from "./MemoryDial";

const HOLDOFF_MIN = BOARD_MAD_WARMUP_BUCKETS_MIN;
const HOLDOFF_MAX = BOARD_MAD_WARMUP_BUCKETS_MAX;
const HOLDOFF_DEFAULT = BOARD_MAD_WARMUP_BUCKETS_DEFAULT;
const HOLDOFF_FAST = Math.max(HOLDOFF_MIN, Math.round(HOLDOFF_DEFAULT / 2));
const HOLDOFF_EARLIEST = HOLDOFF_MIN;

const TOOLTIP_TEXT =
  "Alert holdoff: suppress fires until N bucket durations have elapsed. Once the holdoff ends, the selected prior anchor and state-space baseline take over.";

interface SnapChip {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}

const SNAP_CHIPS: readonly SnapChip[] = [
  {
    label: `Default (${String(HOLDOFF_DEFAULT)})`,
    value: HOLDOFF_DEFAULT,
    testId: "warmup-dial-chip-default",
  },
  {
    label: `Fast (${String(HOLDOFF_FAST)})`,
    value: HOLDOFF_FAST,
    testId: "warmup-dial-chip-eager",
  },
  {
    label: `Earliest (${String(HOLDOFF_EARLIEST)})`,
    value: HOLDOFF_EARLIEST,
    testId: "warmup-dial-chip-off",
  },
];

function clampHoldoff(n: number): number {
  if (!Number.isFinite(n)) return HOLDOFF_DEFAULT;
  const rounded = Math.round(n);
  if (rounded < HOLDOFF_MIN) return HOLDOFF_MIN;
  if (rounded > HOLDOFF_MAX) return HOLDOFF_MAX;
  return rounded;
}

export interface WarmupDialProps {
  readonly value: number;
  readonly bucketSeconds: number;
  readonly onChange: (next: number) => void;
}

export function WarmupDial({ value, bucketSeconds, onChange }: WarmupDialProps): JSX.Element {
  const clamped = clampHoldoff(value);
  const duration = formatBucketDurationForDisplay(clamped, bucketSeconds);
  const minLabel = formatBucketDurationForDisplay(HOLDOFF_MIN, bucketSeconds);
  const maxLabel = formatBucketDurationForDisplay(HOLDOFF_MAX, bucketSeconds);

  const handleSliderChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const parsed = Number.parseInt(e.target.value, 10);
    if (Number.isFinite(parsed)) onChange(clampHoldoff(parsed));
  };

  return (
    <div
      data-testid="warmup-dial-root"
      data-warmup-value={String(clamped)}
      className="flex flex-col select-none"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
            <ExplainerCard id="warmup-buckets">Alert holdoff</ExplainerCard>
          </div>
          <p className="mt-1 max-w-[34ch] text-xs text-text-md">
            Opening buckets that cannot fire while the game builds enough context.
          </p>
        </div>
        <div className="shrink-0 sm:text-right">
          <span
            data-testid="warmup-dial-headline"
            className="tabular font-mono text-text-hi text-2xl leading-none sm:text-3xl"
          >
            {String(clamped)}
          </span>
          <span
            data-testid="warmup-dial-headline-detail"
            className="ml-2 tabular font-mono text-xs text-text-md sm:text-sm"
          >
            ({duration})
          </span>
        </div>
      </div>

      <input
        type="range"
        min={HOLDOFF_MIN}
        max={HOLDOFF_MAX}
        step={1}
        value={String(clamped)}
        onChange={handleSliderChange}
        title={TOOLTIP_TEXT}
        aria-label="Alert holdoff buckets"
        aria-valuemin={HOLDOFF_MIN}
        aria-valuemax={HOLDOFF_MAX}
        aria-valuenow={clamped}
        aria-valuetext={`${String(clamped)} (${duration})`}
        data-testid="warmup-dial-slider"
        className="mt-4 w-full accent-accent-yellow"
      />

      <div className="mt-1 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">
        <span data-testid="warmup-dial-min-label">{minLabel}</span>
        <span data-testid="warmup-dial-max-label">{maxLabel}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="warmup-dial-chips">
        {SNAP_CHIPS.map((chip) => {
          const active = clamped === chip.value;
          const className = active
            ? "border border-accent-green bg-accent-green px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider text-surface-1 sm:px-2.5 sm:text-xs"
            : "border border-accent-green bg-transparent px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider text-accent-green hover:bg-accent-green/10 sm:px-2.5 sm:text-xs";
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
