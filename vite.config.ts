import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the project site from /aperture/; preview mirrors it.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/aperture/' : '/',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/tone') ? 'tone' : undefined),
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 120000,
  },
}));
