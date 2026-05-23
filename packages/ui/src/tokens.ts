// Design tokens — the SOURCE OF TRUTH for every color/type/motion value in the
// app. Re-exported via the Tailwind preset (./tailwind-preset.cjs) and via
// CSS custom properties (./global.css). See docs/design-language.md for the
// rationale behind each value; this file may not declare anything that contradicts
// that doc.
//
// Hex literals are allowed ONLY in this file (and ./global.css + ./tailwind-preset.cjs).
// `pnpm verify:no-hex-literals` enforces the rule.

export interface ColorTokens {
  readonly surface0From: string;
  readonly surface0To: string;
  readonly surface1: string;
  readonly surface2: string;
  readonly surfaceElevated: string;
  readonly accentGreen: string;
  readonly accentYellow: string;
  readonly negative: string;
  readonly textHi: string;
  readonly textMd: string;
  readonly textLo: string;
}

export interface TypographyWeights {
  readonly normal: number;
  readonly medium: number;
  readonly semibold: number;
  readonly bold: number;
}

export interface TypographyScale {
  readonly xs: string;
  readonly sm: string;
  readonly base: string;
  readonly lg: string;
  readonly xl: string;
  readonly "2xl": string;
  readonly "3xl": string;
  readonly "4xl": string;
}

export interface TypographyTokens {
  readonly fontSans: string;
  readonly fontMono: string;
  readonly weights: TypographyWeights;
  readonly scale: TypographyScale;
}

export interface MotionDurations {
  readonly fast: string;
  readonly base: string;
  readonly slow: string;
  readonly pulse: string;
}

export interface MotionEasings {
  readonly standard: string;
  readonly in: string;
  readonly out: string;
  readonly inOut: string;
}

export interface MotionTokens {
  readonly durations: MotionDurations;
  readonly easings: MotionEasings;
}

export const colors: ColorTokens = {
  surface0From: "#06140E",
  surface0To: "#0E2A1F",
  surface1: "#0F2419",
  surface2: "#163020",
  surfaceElevated: "#1A3528",
  accentGreen: "#14EB6F",
  accentYellow: "#FFD000",
  negative: "#FF5757",
  textHi: "#FFFFFF",
  textMd: "#B4C4BD",
  textLo: "#6E7E77",
};

export const typography: TypographyTokens = {
  fontSans: 'Inter, "Geist Sans", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace',
  weights: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  scale: {
    xs: "12px",
    sm: "13px",
    base: "14px",
    lg: "16px",
    xl: "20px",
    "2xl": "28px",
    "3xl": "40px",
    "4xl": "64px",
  },
};

export const motion: MotionTokens = {
  durations: {
    fast: "100ms",
    base: "150ms",
    slow: "200ms",
    pulse: "1500ms",
  },
  easings: {
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    in: "cubic-bezier(0.4, 0, 1, 1)",
    out: "cubic-bezier(0, 0, 0.2, 1)",
    inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
};
