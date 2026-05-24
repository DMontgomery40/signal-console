// Volatility-lookback slider (US-053).
//
// Controls `trailingBuckets`: how many prior current-game buckets define
// "normal" for the trailing median + MAD threshold. It is intentionally a
// slider, paired visually with the opening holdoff slider, because traders
// tune those two timing choices together.

import type { ChangeEvent, JSX } from "react";

import {
  BOARD_MAD_TRAILING_BUCKETS_DEFAULT,
  BOARD_MAD_TRAILING_BUCKETS_MAX,
  BOARD_MAD_TRAILING_BUCKETS_MIN,
} from "@signal-console/detectors/board-mad/config";
import { ExplainerCard } from "@signal-console/ui";

const LOOKBACK_MIN = BOARD_MAD_TRAILING_BUCKETS_MIN;
const LOOKBACK_MAX = BOARD_MAD_TRAILING_BUCKETS_MAX;
const LOOKBACK_DEFAULT = BOARD_MAD_TRAILING_BUCKETS_DEFAULT;
const LOOKBACK_SHORT = Math.max(LOOKBACK_MIN, Math.round(LOOKBACK_DEFAULT / 2));
const LOOKBACK_LONG = Math.min(LOOKBACK_MAX, LOOKBACK_DEFAULT * 2);

interface SnapChip {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
}

const SNAP_CHIPS: readonly SnapChip[] = [
  {
    value: LOOKBACK_SHORT,
    label: `Short (${String(LOOKBACK_SHORT)})`,
    testId: "memory-dial-chip-quick",
  },
  {
    value: LOOKBACK_DEFAULT,
    label: `Default (${String(LOOKBACK_DEFAULT)})`,
    testId: "memory-dial-chip-default",
  },
  {
    value: LOOKBACK_LONG,
    label: `Long (${String(LOOKBACK_LONG)})`,
    testId: "memory-dial-chip-steady",
  },
];

function clampLookback(n: number): number {
  if (!Number.isFinite(n)) return LOOKBACK_DEFAULT;
  const rounded = Math.round(n);
  if (rounded < LOOKBACK_MIN) return LOOKBACK_MIN;
  if (rounded > LOOKBACK_MAX) return LOOKBACK_MAX;
  return rounded;
}

export function formatBucketDurationForDisplay(bucketCount: number, bucketSeconds: number): string {
  const totalSeconds = Math.max(0, Math.round(bucketCount * bucketSeconds));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0 sec";
  if (totalSeconds < 60) return `${String(totalSeconds)} sec`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${String(minutes)} min`;
  return `${String(minutes)} min ${String(seconds)} sec`;
}

export interface MemoryDialProps {
  readonly value: number;
  readonly bucketSeconds: number;
  readonly onChange: (next: number) => void;
}

export function MemoryDial({ value, bucketSeconds, onChange }: MemoryDialProps): JSX.Element {
  const clamped = clampLookback(value);
  const duration = formatBucketDurationForDisplay(clamped, bucketSeconds);
  const minLabel = formatBucketDurationForDisplay(LOOKBACK_MIN, bucketSeconds);
  const maxLabel = formatBucketDurationForDisplay(LOOKBACK_MAX, bucketSeconds);

  const handleSliderChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const parsed = Number.parseInt(e.target.value, 10);
    if (Number.isFinite(parsed)) onChange(clampLookback(parsed));
  };

  return (
    <div
      data-testid="memory-dial-root"
      data-memory-value={String(clamped)}
      className="flex flex-col select-none"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-text-lo text-xs uppercase tracking-[0.08em] font-sans">
            <ExplainerCard id="trailing-window-memory">Volatility lookback</ExplainerCard>
          </div>
          <p className="mt-1 max-w-[34ch] text-xs text-text-md">
            Recent in-game minutes used to decide what normal board movement looks like.
          </p>
        </div>
        <div className="text-right">
          <span
            data-testid="memory-dial-headline"
            className="tabular font-mono text-text-hi text-3xl leading-none"
          >
            {String(clamped)}
          </span>
          <span
            data-testid="memory-dial-headline-detail"
            className="ml-2 tabular font-mono text-sm text-text-md"
          >
            ({duration})
          </span>
        </div>
      </div>

      <input
        type="range"
        min={LOOKBACK_MIN}
        max={LOOKBACK_MAX}
        step={1}
        value={String(clamped)}
        onChange={handleSliderChange}
        title="Volatility lookback: how many recent current-game buckets feed the trailing median and MAD threshold."
        aria-label="Volatility lookback buckets"
        aria-valuemin={LOOKBACK_MIN}
        aria-valuemax={LOOKBACK_MAX}
        aria-valuenow={clamped}
        aria-valuetext={`${String(clamped)} (${duration})`}
        data-testid="memory-dial"
        className="mt-4 w-full accent-accent-yellow"
      />

      <div className="mt-1 flex justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-text-lo">
        <span data-testid="memory-dial-min-label">{minLabel}</span>
        <span data-testid="memory-dial-max-label">{maxLabel}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="memory-dial-chips">
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
