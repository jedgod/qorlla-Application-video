import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests: pure logic only (formatting, the upload state machine), no browser and no network.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
