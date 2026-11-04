import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 워크스페이스 패키지(@f1sim/*)를 dist 대신 src로 해석한다 (package.json exports의 "@f1sim/source").
  ssr: { resolve: { conditions: ['@f1sim/source', ...defaultServerConditions] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
