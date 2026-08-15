import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * Both are overridable so a second stack can run beside the first — a
 * worktree checked out next to the main one, say — without either answering
 * for the other. A browser test that hits the wrong port tests the wrong
 * build, which is a failure mode that reports as success.
 */
const port = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port,
    // Fail rather than silently move to the next free port: a suite pointed at
    // 5173 must not quietly be served by whatever else was already there.
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        // Must NOT change origin. Syntra resolves the tenant from the Host
        // header, and Vite's string-shorthand proxy rewrites it to the
        // target, which makes every request look like an unknown tenant.
        changeOrigin: false,
      },
    },
  },
});
