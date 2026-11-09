import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * The lint gate (docs/06-conventions.md).
 *
 * Deliberately a short list. A linter earns its place by catching things a typechecker and a test
 * cannot, and loses it the moment it reports enough noise that people stop reading the output —
 * so stylistic rules are left to Prettier, and the rules here are ones whose findings are bugs:
 * a hook that will not re-run when its inputs change, a `catch` that swallows an error, an
 * interactive element a keyboard cannot reach.
 *
 * Not type-checked linting. The type-aware rules are slow enough to change how often this gets run,
 * and `tsc --noEmit` already runs over every package in CI and covers most of what they would say.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '.tmp/**',
      'test-results/**',
      'playwright-report/**',
      'fixtures/**',
      // Written by `next build`; not ours to lint.
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // An unused name is either a mistake or a leftover. The underscore prefix is the way to say
      // "deliberately unused", which the codebase already uses for ignored route parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` defeats the point of the strict compiler settings this repo runs under.
      '@typescript-eslint/no-explicit-any': 'error',
      // Empty blocks are usually a swallowed error; a comment saying why is enough to allow one.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // `==` against anything but null is a source of surprises nobody wants to debug.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Control characters in a regex are how this codebase *rejects* them — in uploaded file
      // names, in storage keys, in the paths inside a pack archive. The rule assumes anyone writing
      // one meant something else, which is backwards here.
      'no-control-regex': 'off',
      // Two of the same key: one of them was meant to be something else.
      'no-dupe-keys': 'error',
      'no-constant-binary-expression': 'error',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      // The two that matter most in this codebase: the editor is a pile of hooks over a WebGL
      // canvas, and a missing dependency there shows up as a preview that quietly stops updating.
      ...reactHooks.configs.recommended.rules,
      // Accessibility, as far as a linter can see it: labels that name a control, images that say
      // what they are, and nothing interactive that only a mouse can reach.
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },

  {
    // k6 scripts run in k6's own runtime, not Node's: `__ENV` and friends are provided by the host.
    // They are linted rather than ignored — a load script is code that has to work under pressure —
    // so its globals are declared instead.
    files: ['load/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' },
    },
  },

  {
    files: ['apps/web/components/face-view-canvas.tsx'],
    rules: {
      // `role="application"` on the placement canvas is the accessible choice, not a mistake: the
      // canvas handles arrow keys itself to nudge artwork by exact millimetres, and the role is
      // what stops a screen reader capturing them first. The rule cannot tell the two apart, and
      // the directive cannot go inline — the report lands on an attribute, where JSX has nowhere
      // to put a comment.
      'jsx-a11y/no-interactive-element-to-noninteractive-role': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'apps/web/e2e/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // Tests reach for shapes the production types would refuse, on purpose: a fixture that is
      // deliberately malformed is the point of the test.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
