import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('configure a watched folder, start polling, and stop it from the dialog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-watch-'));
  const source = path.join(root, 'inbox');
  const output = path.join(root, 'outbox');
  const workflowFile = path.join(repoRoot, 'core/chef_core/resources/workflows/05-ra-word.json');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  const core = path.join(repoRoot, 'core');
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Thư mục tự động');
    await l.page.getByText('Thư mục tự động', { exact: true }).last().click();

    const dialog = l.page.getByRole('dialog', { name: 'Thư mục tự động' });
    await expect(dialog).toBeVisible();
    await l.app.evaluate(({ dialog: nativeDialog }, file) => {
      nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, workflowFile);
    await dialog.getByRole('button', { name: 'Mở JSON quy trình' }).click();
    await expect(dialog.getByText('Rã tài liệu ra Word', { exact: true })).toBeVisible();
    await dialog.getByPlaceholder('/path/to/inbox').fill(source);
    await dialog.getByPlaceholder('/path/to/output').fill(output);
    await dialog.getByRole('spinbutton').nth(1).fill('0');
    await dialog.getByRole('button', { name: 'Bắt đầu theo dõi' }).click();
    await expect(dialog.getByText('Đang theo dõi', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole('button', { name: 'Dừng sau đợt hiện tại' }).click();
    await expect(dialog.getByText('Đã dừng', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
