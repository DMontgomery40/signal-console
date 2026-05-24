export {
  colors,
  typography,
  motion,
  type ColorTokens,
  type TypographyTokens,
  type TypographyWeights,
  type TypographyScale,
  type MotionTokens,
  type MotionDurations,
  type MotionEasings,
} from "./tokens";

// The Tailwind preset is shipped as a CommonJS file consumed by Tailwind's
// config loader (runs in Node) via the `@signal-console/ui/tailwind-preset`
// subpath. We deliberately do NOT re-export it from this index, because Vite
// pulls index.ts into the browser bundle and cannot load the .cjs as an ESM
// module ("does not provide an export named 'default'"). The subpath import
// is the single, working path. Types still re-export below.
export type { TailwindPreset, TailwindPresetThemeExtend } from "./tailwind-preset.cjs";

// Explainer content for HoverCards. 17 entries spanning the board-MAD and
// off-price-print detectors, the Sensitivity dial and its labeled snap points, detector
// params, math foundations, and data sanitations.
export { explainers, type Explainer, type ExplainerId } from "./explainers";

// HoverCard primitive consuming the explainer content above. See US-046.
export { ExplainerCard, type ExplainerCardProps } from "./components/ExplainerCard";

// Generic rotary-dial primitive (US-053). Sensitivity and timing dials both
// configure this; consumers supply value/min/max/step + snap points + chips.
export { RotaryDial, type RotaryDialProps, type RotaryDialSnapChip } from "./components/RotaryDial";
