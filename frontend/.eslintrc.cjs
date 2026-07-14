/* ESLint (legacy config) — mandatory per spec §8; bans the innerHTML XSS sink (FE §11). */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: 'detect' } },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'jsx-a11y'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  rules: {
    // FE §11: no raw innerHTML sink anywhere. react-markdown + rehype-sanitize is the only render path.
    'react/no-danger': 'error',
    'no-restricted-syntax': [
      'error',
      {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message:
          'dangerouslySetInnerHTML is banned (FE §11). Render untrusted markdown via react-markdown + rehype-sanitize.',
      },
    ],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/eval', '**/eval/**', '*/eval/*'],
            message: 'src/** must never import from eval/** — the eval harness must not enter the shipped bundle (eval spec §4).',
          },
        ],
      },
    ],
  },
  ignorePatterns: ['dist', 'node_modules', 'vite.config.ts', '*.cjs'],
};
