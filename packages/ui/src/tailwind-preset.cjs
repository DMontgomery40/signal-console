// Tailwind preset for Signal Console.
//
// CJS file because Tailwind's config loader accepts .cjs/.js/.mjs/.ts and a
// CJS preset is the most portable across consumer apps. The values here MIRROR
// `./tokens.ts` — keep them in sync. The repo's `verify:no-hex-literals` check
// allow-lists this file by name, so hex literals are permitted here as part of
// the tokens system. Any drift between this file and tokens.ts will be caught
// by the tokens snapshot test plus visual review.

/** @type {import('tailwindcss').Config['theme']} */
const themeExtend = {
  colors: {
    "surface-0-from": "#06140E",
    "surface-0-to": "#0E2A1F",
    "surface-1": "#0F2419",
    "surface-2": "#163020",
    "surface-elevated": "#1A3528",
    "accent-green": "#14EB6F",
    "accent-yellow": "#FFD000",
    negative: "#FF5757",
    "text-hi": "#FFFFFF",
    "text-md": "#B4C4BD",
    "text-lo": "#6E7E77",
  },
  fontFamily: {
    sans: ["Inter", '"Geist Sans"', "system-ui", "sans-serif"],
    mono: ['"JetBrains Mono"', '"Berkeley Mono"', '"IBM Plex Mono"', "ui-monospace", "monospace"],
  },
  fontSize: {
    xs: "12px",
    sm: "13px",
    base: "14px",
    lg: "16px",
    xl: "20px",
    "2xl": "28px",
    "3xl": "40px",
    "4xl": "64px",
    "5xl": "96px",
  },
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
  },
  transitionDuration: {
    fast: "100ms",
    base: "150ms",
    slow: "200ms",
    pulse: "1500ms",
  },
  transitionTimingFunction: {
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    in: "cubic-bezier(0.4, 0, 1, 1)",
    out: "cubic-bezier(0, 0, 0.2, 1)",
    "in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
  },
};

/** @type {Partial<import('tailwindcss').Config>} */
const preset = {
  theme: {
    extend: themeExtend,
  },
  plugins: [],
};

module.exports = preset;
// ESM interop: expose the preset as a default export AND set the
// __esModule marker so `import preset from "./tailwind-preset.cjs"` resolves
// to the preset object under both Node's CJS->ESM interop and bundlers that
// honor __esModule. The `module.exports = preset` line above remains the
// canonical CJS export shape that Tailwind's config loader consumes directly.
module.exports.default = preset;
Object.defineProperty(module.exports, "__esModule", { value: true });
