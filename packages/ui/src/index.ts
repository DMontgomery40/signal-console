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

// The Tailwind preset is shipped as a CommonJS file. We re-export it here so
// `import { tailwindPreset } from "@signal-console/ui"` works alongside the
// direct `@signal-console/ui/tailwind-preset` subpath import. Tailwind config
// loaders (which run in Node) consume the .cjs file directly; this ESM re-export
// is for tests, tooling, and any future consumer that wants a single entry.
import tailwindPreset from "./tailwind-preset.cjs";
export { tailwindPreset };
export type { TailwindPreset, TailwindPresetThemeExtend } from "./tailwind-preset.cjs";

// Explainer content for HoverCards. 17 entries spanning the board-MAD and
// off-price-print detectors, the K dial and its labeled snap points, detector
// params, math foundations, and data sanitations.
export { explainers, type Explainer, type ExplainerId } from "./explainers";

// HoverCard primitive consuming the explainer content above. See US-046.
export { ExplainerCard, type ExplainerCardProps } from "./components/ExplainerCard";
