// Runtime-error lint for server/ only. Run with `npm run lint:server`.
//
// Deliberately tiny: it flags code that throws or misbehaves when it runs, and
// nothing stylistic. The reason it exists is PR #58, where a deleted import
// (`SC_WRITE_PACING_MS`) shipped to main and made POST /api/growth/reverse
// return 500 on every call. `no-undef` catches that class of mistake.
//
// No new dependency: the Node globals are declared here, and the ESLint binary
// is the one frontend-UI already installs (see package.json `lint:server`).

const nodeGlobals = Object.fromEntries(
  [
    'AbortController', 'AbortSignal', 'Blob', 'Buffer', 'FormData', 'Headers',
    'Request', 'Response', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams',
    'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'fetch',
    'global', 'globalThis', 'performance', 'process', 'queueMicrotask',
    'setImmediate', 'setInterval', 'setTimeout', 'structuredClone',
    // CommonJS names, in case a file still uses them
    '__dirname', '__filename', 'exports', 'module', 'require',
  ].map((name) => [name, 'readonly'])
);

export default [
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-import-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
    },
  },
];
