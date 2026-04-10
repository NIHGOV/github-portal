//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import globals from 'globals';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import pluginSecurity from 'eslint-plugin-security';
import pluginN from 'eslint-plugin-n';
import tsParser from '@typescript-eslint/parser';
import js from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  pluginSecurity.configs.recommended,
  {
    rules: {
      // These are so common in Node codebases it does not provide sufficient value to warn
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    ignores: [
      '.github/build/*.cjs',
      '.github/build/*.js',
      'default-assets-package/thirdparty/**/*.js',
      'dist/**/*.js',
      'dist/**/*.cjs',
      'dist/**/*.mjs',
      'dist/**/*.d.ts',
      '.environment/validate.js',
      '.ossdev/build/*.cjs',
      '**/frontend/',
      '**/vendor/**/*',
      '**/vendor.nocommit/**/*',
      'views/js/**/*',
      '.eslint.config.mjs', // this file
    ],
  },
  js.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    // Rules added in eslint:recommended for ESLint v10 - disable for now
    rules: {
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-unassigned-vars': 'off',
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.js'],

    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...typescriptEslint.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  ...[pluginN.configs['flat/recommended']].map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],

    languageOptions: {
      parser: tsParser,
    },

    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'n/no-missing-import': 'off',
      'n/no-process-exit': 'off',
      'n/shebang': 'off',
      'no-case-declarations': 'off',
      'no-empty': 'off',
      'no-ex-assign': 'off',
      'no-inner-declarations': 'off',
      'no-useless-catch': 'off',

      'prefer-const': [
        'error',
        {
          destructuring: 'all',
        },
      ],

      'prefer-rest-params': 'off',
      'prefer-spread': 'off',
    },
  },
];
