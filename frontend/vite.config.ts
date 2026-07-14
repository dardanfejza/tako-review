/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/ — Vite SPA, static dist/ served same-origin by Caddy (FE §16).
export default defineConfig({
  plugins: [react()],
  // Dev-server proxy so the browser sees one origin (the SameSite=lax session cookie stays
  // first-party). In Docker, Compose sets VITE_PROXY_TARGET=http://backend:8000; a plain
  // host-side `pnpm dev` falls back to localhost:8000. No effect on `vite build` / prod (docker spec §9).
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  // The WebLLM engine runs in an ES-module Web Worker (FE §4.1).
  worker: { format: 'es' },
  // CSS Modules: expose kebab-case classes as camelCase keys (styles.editorPane).
  css: { modules: { localsConvention: 'camelCaseOnly' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: false,
    // The heavy jsdom integration tests (fake timers + MSW + findBy* waits) can exceed the
    // 5s default under full-suite parallel load — and coverage instrumentation (CI runs with
    // --coverage) roughly doubles execution — and flake; 30s gives headroom without forcing
    // single-threaded runs. Isolated/--no-file-parallelism runs are well under this.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Exclude the reference UI and the local backend venv if ever picked up.
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      all: true,
      // Ratchet floor: set just below CURRENT's measured coverage so the gate passes today and
      // catches regressions. Raise toward 100 as behavioral tests fill the gaps (Task 4.2).
      thresholds: {
        statements: 96,
        branches: 88,
        functions: 87,
        lines: 96,
      },
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx', // app entry — bootstraps the tree, nothing to assert
        'src/inference/engine.worker.ts', // runs in a Web Worker, not measurable in jsdom
        'src/inference/engineClient.ts', // real WebLLM worker-client (WebGPU); mockEngineClient.ts is the tested double
        'src/components/layout/FishBackground.tsx', // canvas/RAF shell; logic lives in fish/boids.ts (tested)
        'src/inference/types.ts', // type-only (zero runtime statements)
        'src/**/*.d.ts',
        'src/vite-env.d.ts',
        'src/i18n/**', // JSON catalogs + i18next init
        'src/test/**', // test harness/setup
        'src/**/*.test.{ts,tsx}', // tests must not measure themselves
        'src/types/review.ts', // type-only re-exports (zero runtime statements)
      ],
    },
  },
});
