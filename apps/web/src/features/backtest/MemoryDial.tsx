// Memory dial (US-053).
//
// Sibling of the Cry Wolf K dial. Controls `trailingBuckets` — how many prior
// 1-minute buckets the trailing median + MAD baseline reads from. Same rotary
// primitive (packages/ui/src/components/RotaryDial.tsx); the only difference
// is the configuration vector. Range 5-60, integer step, snap detents +
// chips at 10 (Quick), 20 (Default), 40 (Steady). Tick interval 5 to keep
// the bezel from getting too busy at 56 ticks.

import type { JSX } from "react";

import { RotaryDial, type RotaryDialSnapChip } from "@signal-console/ui";

const MEM_MIN = 5;
const MEM_MAX = 60;
const MEM_SMALL_STEP = 1;
const MEM_LARGE_STEP = 5;

const MEM_SNAP_POINTS: readonly number[] = [10, 20, 40];

const MEM_SNAP_CHIPS: readonly RotaryDialSnapChip[] = [
  { value: 10, label: "Quick", testId: "memory-dial-chip-quick" },
  { value: 20, label: "Default", testId: "memory-dial-chip-default" },
  { value: 40, label: "Steady", testId: "memory-dial-chip-steady" },
];

const MEM_TICK_INTERVAL = 5;

function formatMem(v: number): string {
  return String(Math.round(v));
}

export interface MemoryDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
}

export function MemoryDial({ value, onChange }: MemoryDialProps): JSX.Element {
  return (
    <RotaryDial
      value={value}
      onChange={onChange}
      ariaLabel="Trailing window (memory)"
      valueMin={MEM_MIN}
      valueMax={MEM_MAX}
      smallStep={MEM_SMALL_STEP}
      largeStep={MEM_LARGE_STEP}
      snapPoints={MEM_SNAP_POINTS}
      snapChips={MEM_SNAP_CHIPS}
      majorTickValues={MEM_SNAP_POINTS}
      tickInterval={MEM_TICK_INTERVAL}
      formatValue={formatMem}
      testIdPrefix="memory-dial"
      label="Memory"
      labelExplainerId="trailing-window-memory"
    />
  );
}
