// Sensitivity dial (US-036) — configured instance of the generic <RotaryDial>
// primitive (US-053). The primitive owns the SVG geometry, drag/wheel/key
// handling, snap-magnetize, and chip flash; this file only declares the
// sensitivity configuration. The live and calm values continue to come
// exclusively from @signal-console/detectors per the project-wide constraint.

import type { JSX } from "react";

import { K_MAD_CALM, K_MAD_LIVE } from "@signal-console/detectors/board-mad/config";
import { RotaryDial, type RotaryDialSnapChip } from "@signal-console/ui";

const SENSITIVITY_MIN = 2;
const SENSITIVITY_MAX = 8;
const SENSITIVITY_SMALL_STEP = 0.25;
const SENSITIVITY_LARGE_STEP = 1.0;

const SENSITIVITY_SNAP_POINTS: readonly number[] = [K_MAD_LIVE, K_MAD_CALM];

const SENSITIVITY_SNAP_CHIPS: readonly RotaryDialSnapChip[] = [
  { value: K_MAD_LIVE, label: "Sensitive", testId: "sensitivity-chip-sensitive" },
  { value: K_MAD_CALM, label: "Calm", testId: "sensitivity-chip-calm" },
];

function formatSensitivity(v: number): string {
  return v.toFixed(2);
}

export interface SensitivityDialProps {
  readonly value: number;
  readonly onChange: (next: number) => void;
  readonly firesPerGamePreview: string;
  readonly ariaLabel?: string;
}

export function SensitivityDial({
  value,
  onChange,
  firesPerGamePreview,
  ariaLabel,
}: SensitivityDialProps): JSX.Element {
  return (
    <RotaryDial
      value={value}
      onChange={onChange}
      ariaLabel={`${ariaLabel ?? "Sensitivity"}; center readout is estimated fires per game`}
      valueMin={SENSITIVITY_MIN}
      valueMax={SENSITIVITY_MAX}
      smallStep={SENSITIVITY_SMALL_STEP}
      largeStep={SENSITIVITY_LARGE_STEP}
      snapPoints={SENSITIVITY_SNAP_POINTS}
      snapChips={SENSITIVITY_SNAP_CHIPS}
      formatValue={formatSensitivity}
      inlineValueText={firesPerGamePreview}
      inlineDetailText="fires/gm"
      showInlineValue
      testIdPrefix="sensitivity-dial"
      label="Sensitivity"
      labelExplainerId="k-mad"
    />
  );
}
