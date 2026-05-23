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
