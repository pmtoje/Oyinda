// ESLint (flat config) for the whole monorepo. Type safety is enforced by `tsc --noEmit` (strict); ESLint adds
// correctness rules that the compiler does not catch, plus the React Hooks rules for the web app.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/test-results/**', '**/playwright-report/**', '**/storage*/**', '**/*.snap'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Untyped JSON from the API and database rows are typed `any` deliberately at the boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
    },
  },
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', '**/*.mjs', 'apps/web/e2e/**/*.ts', 'apps/web/*.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Plain browser script loaded before the app (applies the theme before first paint).
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser }, sourceType: 'script' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Scripts and test diagnostics may print.
    files: ['apps/api/scripts/**', 'apps/api/src/seed/**', 'apps/api/src/server.ts', 'apps/api/src/db/migrate*.ts', 'apps/web/e2e/**', '**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
