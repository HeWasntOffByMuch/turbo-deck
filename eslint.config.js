// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // tools/ holds vendored third-party code (the pixeldudesmaker generator and
    // its libs), captured as-is — not ours to lint against the strict config.
    ignores: ['dist/**', 'node_modules/**', 'tools/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Terrain (spec 043) is world data, not rendering: it carries the same
    // determinism guarantee as the sim, so it gets the same guard rails.
    files: ['src/sim/**/*.ts', 'src/cards/**/*.ts', 'src/terrain/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Sim/card/terrain code must use the seeded PRNG or spatial hash passed in explicitly, not Math.random.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Sim/card/terrain code must not read wall-clock time; it must be a pure function of its inputs.' },
      ],
    },
  },
);
