import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import ava from 'eslint-plugin-ava'
import node from 'eslint-plugin-n'
import regexp from 'eslint-plugin-regexp'
import globals from 'globals'

export default [
  {
    // Generated reports and standalone CI tools have their own validation.
    ignores: ['coverage/**', '.artifacts/**', '.pnp.*', '.github/scripts/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {ecmaVersion: 'latest', sourceType: 'module', globals: globals.node},
    plugins: {'@stylistic': stylistic, n: node, regexp},
    rules: {
      // Keep the established formatting; no naming or automatic rewrite policy.
      '@stylistic/indent': ['error', 2, {SwitchCase: 1}],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
      '@stylistic/comma-dangle': ['error', 'never'],
      'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', ignoreRestSiblings: true}],
      'no-await-in-loop': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-unsupported-features/node-builtins': 'error',
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      'regexp/no-dupe-disjunctions': 'error',
      'regexp/no-invalid-regexp': 'error',
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 5]
    }
  },
  {
    files: ['**/__tests__/**/*.js', '**/*.test.js'],
    plugins: {ava},
    rules: {
      // Test correctness, without prescribing helper structure or assertion style.
      'ava/assertion-arguments': 'error',
      'ava/no-duplicate-hooks': 'error',
      'ava/no-identical-title': 'error',
      'ava/no-invalid-modifier-chain': 'error',
      'ava/no-nested-tests': 'error',
      'ava/no-only-test': 'error',
      'ava/no-skip-test': 'warn',
      'ava/require-assertion': 'error',
      'ava/test-title': 'error',
      'ava/use-t-throws-async-well': 'error'
    }
  },
  {
    files: ['scripts/**/*.js'],
    // Import and maintenance commands deliberately serialize external writes.
    rules: {'no-await-in-loop': 'off'}
  }
]
