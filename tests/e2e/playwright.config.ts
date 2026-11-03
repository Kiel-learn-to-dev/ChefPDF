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
  // Ảnh so sánh của bộ đo giao diện (ui-audit, UI_AUDIT_SNAPSHOT=1) nằm ngoài specs, gitignore.
  snapshotPathTemplate: '{testDir}/../ui-audit-snapshots/{arg}{ext}',
  use: { trace: 'retain-on-failure' },
});
