import { defineConfig } from '@playwright/test';

// Electron e2e tests. On Linux without a display run under `xvfb-run -a`.
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});
