import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import functional from 'eslint-plugin-functional';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const PURE_DOMAIN_FILES = ['src/lib/domain/**/*.ts', 'src/lib/types/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '../dist/**',
      'eslint.config.js',
      'stylelint.config.mjs',
      'vite.config.ts',
      'svelte.config.js',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...svelte.configs['flat/recommended'],
  {
    files: ['src/**/*.ts', 'src/**/*.svelte', 'src/**/*.svelte.ts'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },
  {
    files: ['src/**/*'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': [
        { type: 'types', pattern: 'src/lib/types/*', mode: 'file' },
        { type: 'domain', pattern: 'src/lib/domain/*', mode: 'file' },
        { type: 'api', pattern: 'src/lib/api/*', mode: 'file' },
        { type: 'state', pattern: 'src/lib/state/*', mode: 'file' },
        { type: 'ui', pattern: 'src/lib/components/*', mode: 'file' },
        { type: 'app', pattern: ['src/App.svelte', 'src/main.ts'], mode: 'file' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        2,
        {
          default: 'disallow',
          rules: [
            { from: 'types', allow: ['types'] },
            { from: 'domain', allow: ['types', 'domain'] },
            { from: 'api', allow: ['types', 'api'] },
            { from: 'state', allow: ['types', 'domain', 'api', 'state'] },
            { from: 'ui', allow: ['types', 'domain', 'api', 'state', 'ui'] },
            { from: 'app', allow: ['types', 'domain', 'api', 'state', 'ui', 'app'] },
          ],
        },
      ],
      'no-param-reassign': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: PURE_DOMAIN_FILES,
    plugins: { functional },
    rules: {
      'functional/immutable-data': 'error',
      'functional/no-let': 'error',
      'functional/prefer-readonly-type': 'error',
      'functional/no-loop-statements': 'error',
    },
  }
);
