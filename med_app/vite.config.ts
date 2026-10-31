/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// amazon-cognito-identity-js (and the `buffer` polyfill it pulls in) reference Node's
// `global` at import time. Rollup's CommonJS plugin shims that in production builds, but
// esbuild's dev pre-bundling does not — without this mapping the dev server renders a
// blank page with "ReferenceError: global is not defined".
const nodeGlobalShim = { global: 'globalThis' };

// The build this bundle is: baked into the code as `__BUILD_ID__` and written next to it as `/version.json`. A panel
// left open across a deploy compares the two (src/panel/UpdateNotice.tsx) and offers a reload — the registry it keeps
// polling may by then carry manifests its own, older schema refuses. The id is the moment of the build; the hosting
// stack only rebuilds when the sources changed, so equal sources keep their id.
const buildId = process.env.MEDAPP_BUILD_ID ?? new Date().toISOString();
const versionFile = (): Plugin => ({
  name: 'medapp-version-json',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) });
  },
  configureServer(server) {
    server.middlewares.use('/version.json', (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ build: buildId }));
    });
  },
});

// The manifests and seed sets live outside `src/` on purpose: they are data (the app registry),
// not code. Vite is allowed to read them via import.meta.glob('/manifests/*/*.yaml', '/showcase/*.yaml').
export default defineConfig({
  plugins: [react(), versionFile()],
  define: { ...nodeGlobalShim, __BUILD_ID__: JSON.stringify(buildId) },
  optimizeDeps: {
    esbuildOptions: { define: nodeGlobalShim },
  },
  server: {
    port: 5173,
    fs: { allow: ['.'] },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // The tests are written against Klinikum Musterstadt's seed set (thirteen apps, three collections) — the mock registry shows the
    // configured hospital's set, so the tests say which, whatever a checkout's .env holds.
    env: { VITE_HOSPITAL_ID: 'hsp-musterstadt' },
  },
});
