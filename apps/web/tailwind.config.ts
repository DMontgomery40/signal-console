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
// US-048: include packages/ui/src so arbitrary Tailwind values used inside
// shared UI components (e.g. ExplainerCard's `w-[min(560px,calc(100vw-32px))]`)
// are picked up by Tailwind's JIT scanner. Token classes (bg-surface-1 etc.)
// already render because they're reused across apps/web, but per-component
// arbitrary values would otherwise be silently dropped.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  presets: [preset],
  theme: {},
  plugins: [],
};
