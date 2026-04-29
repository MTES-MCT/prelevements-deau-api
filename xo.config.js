const config = [
  {
    semicolon: false,
    space: 2,
    rules: {
      // Désactivation de camelcase pour permettre snake_case en DB
      camelcase: 'off',

      // Désactivation des règles de formatage
      'object-curly-newline': 'off',
      '@stylistic/object-curly-newline': 'off',
      '@stylistic/function-paren-newline': 'off',

      // Pas de trailing commas (ESLint core + stylistic)
      'comma-dangle': ['error', 'never'],
      '@stylistic/comma-dangle': ['error', 'never'],

      // Désactivation des règles unicorn qui ne conviennent pas au projet
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/prefer-event-target': 'off',
      'unicorn/no-array-callback-reference': 'off',

      // Désactivation des règles d'import (nouveau préfixe import-x dans XO 1.x)
      'import/no-unassigned-import': 'off',
      'import/order': 'off',
      'import-x/no-unassigned-import': 'off',
      'import-x/order': 'off',
      'import-x/no-extraneous-dependencies': 'off',

      // Désactivation de la validation des dépendances Node.js
      'n/no-extraneous-import': 'off'
    }
  },
  {
    files: [
      'scripts/**/*.js'
    ],
    rules: {
      'no-await-in-loop': 'off',
      'promise/prefer-await-to-then': 'off',
      'n/prefer-global/process': 'off',
      'n/prefer-global/buffer': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'no-eq-null': 'off',
      eqeqeq: 'off',
      'no-bitwise': 'off',
      'unicorn/prefer-math-trunc': 'off',
      'unicorn/prefer-code-point': 'off',
      '@stylistic/no-mixed-operators': 'off'
    }
  }
]

export default config
