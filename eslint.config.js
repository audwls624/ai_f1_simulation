// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * packages/core 순수성 (DESIGN.md 1·11·13절, CLAUDE.md 불변 규칙).
 * core는 입력 → 출력만: I/O, 시간, 환경, 전역 난수, 로케일 의존 동작, 객체 키 순회 금지.
 */
const PURE = 'packages/core is pure (docs/DESIGN.md §1, §13)';

const coreRestrictedGlobals = [
  ['window', 'no DOM'],
  ['document', 'no DOM'],
  ['navigator', 'no environment access'],
  ['self', 'no environment access'],
  ['globalThis', 'no environment access'],
  ['global', 'no environment access'],
  ['process', 'no Node API'],
  ['Buffer', 'no Node API'],
  ['require', 'no Node API'],
  ['__dirname', 'no Node API'],
  ['__filename', 'no Node API'],
  ['fetch', 'no I/O'],
  ['XMLHttpRequest', 'no I/O'],
  ['WebSocket', 'no I/O'],
  ['localStorage', 'no I/O'],
  ['console', 'no logging — return data instead'],
  ['Date', 'no wall clock — pass time in as input'],
  ['performance', 'no wall clock'],
  ['crypto', 'no external randomness — use core/rng'],
  ['setTimeout', 'no scheduling'],
  ['setInterval', 'no scheduling'],
  ['setImmediate', 'no scheduling'],
  ['queueMicrotask', 'no scheduling'],
  ['Intl', 'locale-dependent output is not deterministic'],
].map(([name, why]) => ({ name, message: `${PURE}: ${why}.` }));

const coreRestrictedProperties = [
  { object: 'Math', property: 'random', message: `${PURE}: use makeRng() from core/rng.` },
  ...['keys', 'values', 'entries'].map((property) => ({
    object: 'Object',
    property,
    message: `${PURE}: iterate a fixed ordered list instead of object keys (CLAUDE.md).`,
  })),
  { property: 'localeCompare', message: `${PURE}: locale-dependent ordering is not deterministic.` },
  { property: 'toLocaleString', message: `${PURE}: locale-dependent output is not deterministic.` },
];

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'runs/**'] },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 리플레이 뷰어 (브라우저)
    files: ['apps/web/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...coreRestrictedGlobals],
      'no-restricted-properties': ['error', ...coreRestrictedProperties],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 허용: zod, yaml, 상대 경로. 그 외(node:*, fs, 다른 워크스페이스 패키지 등)는 전부 금지.
              regex: '^(?!(?:zod|yaml)$)(?!\\.{1,2}/)',
              message: `${PURE}: only zod, yaml and relative imports are allowed.`,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ForInStatement', message: `${PURE}: no for...in — iterate a fixed ordered list.` },
        { selector: 'MetaProperty', message: `${PURE}: no import.meta — environment access.` },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
);
