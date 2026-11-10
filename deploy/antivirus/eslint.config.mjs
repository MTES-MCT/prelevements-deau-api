import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import node from 'eslint-plugin-n'
import globals from 'globals'

// These tools are already present in main's locked XO dependency tree. Keep the
// standalone scanner's production style without weakening the legacy app's XO.
export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {ecmaVersion: 'latest', sourceType: 'module', globals: globals.node},
    plugins: {'@stylistic': stylistic, n: node},
    rules: {
      '@stylistic/indent': ['error', 2, {SwitchCase: 1}],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
      '@stylistic/comma-dangle': ['error', 'never'],
      'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', ignoreRestSiblings: true}],
      'no-await-in-loop': 'error',
      'n/no-deprecated-api': 'error',
      'n/no-unsupported-features/node-builtins': 'error',
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 5]
    }
  }
]
