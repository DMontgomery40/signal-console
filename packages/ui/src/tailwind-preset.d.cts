// Type companion for ./tailwind-preset.cjs so TS consumers (and the index.ts
// re-export) see a structured shape instead of `unknown`.

export interface TailwindPresetThemeExtend {
  readonly colors: Readonly<Record<string, string>>;
  readonly fontFamily: Readonly<Record<string, readonly string[]>>;
  readonly fontSize: Readonly<Record<string, string>>;
  readonly fontWeight: Readonly<Record<string, string>>;
  readonly transitionDuration: Readonly<Record<string, string>>;
  readonly transitionTimingFunction: Readonly<Record<string, string>>;
}

export interface TailwindPreset {
  readonly theme: {
    readonly extend: TailwindPresetThemeExtend;
  };
  readonly plugins: readonly never[];
}

declare const preset: TailwindPreset;
export default preset;
