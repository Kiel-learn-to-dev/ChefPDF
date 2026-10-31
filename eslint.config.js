import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/release/**', 'core/**', 'packages/contracts/src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
