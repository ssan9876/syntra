import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a running stack. Chromium is told to resolve the tenant
 * hostname to loopback: Syntra selects a tenant from the Host header, so the
 * end-to-end tests must arrive on a name a tenant actually claims.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://acme.localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--host-resolver-rules=MAP acme.localhost 127.0.0.1',
            '--no-proxy-server',
          ],
        },
      },
    },
  ],
});
