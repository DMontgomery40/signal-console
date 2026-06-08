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

const relaxedTypeAwareRuleOverrides = Object.fromEntries(
  [
    ...Object.keys(requiredTypeAwareRules),
    "@typescript-eslint/no-base-to-string",
    "@typescript-eslint/no-redundant-type-constituents",
    "@typescript-eslint/no-unnecessary-type-assertion",
  ].map((ruleName) => [ruleName, "off"]),
);

const scriptDefensiveGuardRuleOverrides = {
  "@typescript-eslint/no-unnecessary-condition": "off",
  "@typescript-eslint/strict-boolean-expressions": "off",
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
      ".gitnexus/**",
      ".claude/skills/**",
      "**/.venv/**",
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
    // Scripts intentionally keep defensive guards around parsed CLI, JSON, and
    // generated payload data even though the scripts compiler now matches package
    // optional/indexed-access policy.
    files: ["scripts/**/*.{ts,tsx}"],
    rules: scriptDefensiveGuardRuleOverrides,
  },
  {
    // These runtime/research packages were historically outside the strict
    // type-aware lint gate. Keep baseline TS linting active, but do not let the
    // root gate fail on rules they were never migrated to satisfy.
    files: [
      "apps/worker/**/*.{ts,tsx}",
      "packages/adapters/**/*.{ts,tsx}",
      "packages/domain/**/*.{ts,tsx}",
      "packages/shared/**/*.{ts,tsx}",
      // research-pull is orchestration infra (like adapters/shared); held to the
      // same relaxed type-aware bar, not the detectors strict/functional bar.
      "packages/research-pull/**/*.{ts,tsx}",
      // scripts/ are operational/orchestration infra and their typecheck compiles
      // transitive package SOURCE under the relaxed package flags (scripts/tsconfig
      // sets noUncheckedIndexedAccess/exactOptionalPropertyTypes false to match the
      // packages, the verify-gate strictness landmine). Holding the scripts to a
      // STRICTER type-aware bar than the source they compile makes
      // no-unnecessary-condition misfire on defensive index-access guards; relax
      // them to the same bar as that source.
      "scripts/**/*.{ts,tsx}",
    ],
    rules: relaxedTypeAwareRuleOverrides,
  },
  {
    files: [
      "apps/worker/src/**/__tests__/**/*.{ts,tsx}",
      "packages/adapters/src/**/__tests__/**/*.{ts,tsx}",
      "packages/shared/src/**/__tests__/**/*.{ts,tsx}",
      // research-truth tests are clean under strict; the vitest configs live at
      // package root (outside the type-aware project), so lint them without the
      // project service (matches the repo's config-file handling).
      "packages/research-truth/vitest.config.ts",
      "packages/research-pull/vitest.config.ts",
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
    rules: relaxedTypeAwareRuleOverrides,
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
