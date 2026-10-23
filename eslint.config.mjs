import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', '.tools/**', 'dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  } },
  // Test response fixtures inspect heterogeneous HTTP JSON; runtime production code remains checked.
  { files: ['infra/test/api.test.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
