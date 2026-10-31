import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const readonly = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));

// Node.js globals for plain .mjs scripts (build/dev scripts, packaging, mock core).
const nodeGlobals = readonly([
  'process',
  'console',
  'Buffer',
  'URL',
  'URLSearchParams',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'AbortController',
  'structuredClone',
]);

// Browser globals for the desktop fallback page script.
const browserGlobals = readonly(['window', 'document', 'console', 'setTimeout', 'clearTimeout']);

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      'spikes/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      'core/**',
      'packages/contracts/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['**/*.mjs', 'packaging/**/*.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['apps/desktop/static/**/*.js'],
    languageOptions: { sourceType: 'script', globals: browserGlobals },
  },
);
