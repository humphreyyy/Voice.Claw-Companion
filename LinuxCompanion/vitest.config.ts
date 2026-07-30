import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    exclude: [
      ...configDefaults.exclude,
      'service/**/*.test.mjs',
      'scripts/**/*.test.mjs',
    ],
  },
});
