// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Restored from a fully-commented (non-functional) state so `eslint` runs again.
// Uses the (non-type-checked) `recommended` sets so lint is runnable without a
// full type-graph build; enabling the heavier `recommendedTypeChecked` across the
// whole legacy codebase is a separate, out-of-scope cleanup.
export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // The codebase already uses a leading underscore as its own convention
      // for "intentionally unused" (e.g. `process(_job: Job<...>)` on a
      // scheduled-sweep handler that ignores the job argument, or a
      // destructuring rename used only to omit a key). The `recommended`
      // ruleset's default has no ignore pattern, so restoring lint (this
      // session) flagged every pre-existing use of that convention at once.
      // Matching the pattern the codebase already intended, rather than
      // renaming every call site, or worse, disabling the rule outright.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
    },
  },
);
