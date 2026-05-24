// Cry Wolf dial (US-036) — configured instance of the generic <RotaryDial>
// primitive (US-053). The primitive owns the SVG geometry, drag/wheel/key
// handling, snap-magnetize, and chip flash; this file only declares the
// K-specific configuration: range 2-8, step 0.25 small / 1.0 large, snap
// detents + chips at K_MAD_LIVE and K_MAD_CALM. The K=3.0 and K=6.0 literals
// continue to come exclusively from @signal-console/detectors per the
// project-wide constraint.

import type { JSX } from "react";

import { K_MAD_CALM, K_MAD_LIVE } from "@signal-console/detectors/board-mad/config";
import { RotaryDial, type RotaryDialSnapChip } from "@signal-console/ui";

const K_MIN = 2;
const K_MAX = 8;
const K_SMALL_STEP = 0.25;
const K_LARGE_STEP = 1.0;

const K_SNAP_POINTS: readonly number[] = [K_MAD_LIVE, K_MAD_CALM];

const K_SNAP_CHIPS: readonly RotaryDialSnapChip[] = [
  { value: K_MAD_LIVE, label: "Sensitive", testId: "cry-wolf-chip-sensitive" },
  { value: K_MAD_CALM, label: "Calm", testId: "cry-wolf-chip-calm" },
];

function formatK(v: number): string {
  return v.toFixed(2);
}

export interface CryWolfDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly ariaLabel?: string;
}

export function CryWolfDial({ value, onChange, ariaLabel }: CryWolfDialProps): JSX.Element {
  return (
    <RotaryDial
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel ?? "K_MAD threshold"}
      valueMin={K_MIN}
      valueMax={K_MAX}
      smallStep={K_SMALL_STEP}
      largeStep={K_LARGE_STEP}
      snapPoints={K_SNAP_POINTS}
      snapChips={K_SNAP_CHIPS}
      formatValue={formatK}
      testIdPrefix="cry-wolf-dial"
      label="Threshold (K)"
      labelExplainerId="k-mad"
    />
  );
}
