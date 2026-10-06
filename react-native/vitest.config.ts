import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone config for the React Native package (the root config only includes tests/unit, so the root
// `npm test` is unaffected). From the repo root: npx vitest run --config react-native/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
