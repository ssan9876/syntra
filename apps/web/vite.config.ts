import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        // Must NOT change origin. Syntra resolves the tenant from the Host
        // header, and Vite's string-shorthand proxy rewrites it to the
        // target, which makes every request look like an unknown tenant.
        changeOrigin: false,
      },
    },
  },
});
