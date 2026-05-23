import preset from "@signal-console/ui/tailwind-preset";

// Tailwind config for apps/web. All token values come from the
// @signal-console/ui preset (which mirrors packages/ui/src/tokens.ts).
// Do not declare colors, fontFamily, fontSize, etc. inline here — the preset
// is the single source of truth (docs/design-language.md).
//
// The exported shape is intentionally NOT annotated with Tailwind's `Config`
// type: the preset is shipped with `readonly` properties (US-043) and would
// otherwise require a widening assertion that the repo's lint config forbids
// (`consistent-type-assertions: never`). Tailwind's config loader is duck-typed
// at runtime, so the structural shape below is consumed correctly.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  presets: [preset],
  theme: {},
  plugins: [],
};
