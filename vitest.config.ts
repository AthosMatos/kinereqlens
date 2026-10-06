import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __E2E__: 'false',
    __DEV__: 'false',
    __VERSION__: '"test"',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
