// Flat-config ESLint for Signal Console v2.
// Rules listed in US-002 acceptance criteria are enforced at 'error'.
// Note: eslint-plugin-functional renamed `no-mutation` to `immutable-data` in v4+;
// US-002's literal text predates that rename. We apply `immutable-data` (the
// semantically identical successor) under packages/detectors/ to enforce the same intent.

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");
// eslint-plugin-functional is ESM-only; require() wraps it in { default, __esModule }.
const functional = require("eslint-plugin-functional").default;
const globals = require("globals");

const requiredTypeAwareRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/strict-boolean-expressions": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/no-confusing-void-expression": "error",
  "@typescript-eslint/return-await": ["error", "always"],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
};

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "dist/**",
      "**/dist/**",
      "build/**",
      "**/build/**",
      ".turbo/**",
      "**/.turbo/**",
      "coverage/**",
      "**/coverage/**",
      "data/**",
      "scripts/ralph/**",
      "PRD.md",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...requiredTypeAwareRules,
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["packages/detectors/**/*.{ts,tsx}"],
    plugins: {
      functional,
    },
    rules: {
      "functional/no-let": "error",
      "functional/immutable-data": "error",
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.cjs", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
);
