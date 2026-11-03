import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('saves QR and barcode task settings as reusable workflow steps', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-code-step-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/textedit_corpus.py');
  execFileSync('uv', ['run', '--project', core, 'python', fixture, folder], { cwd: repoRoot });
  const source = path.join(folder, 'contract.pdf');
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    const openCodeDialog = async () => {
      await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
      await l.page.locator('.palette__input').fill('Mã QR/vạch');
      await l.page.getByRole('option', { name: /^Mã QR\/vạch/ }).click();
      return l.page.getByRole('dialog', { name: 'Mã QR hoặc mã vạch' });
    };
    const workflow = () => l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    const validateRun = async (op: string, suffix: string) => {
      const dialog = workflow();
      await expect(dialog.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(op);
      const paramsField = dialog.getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
      const params = JSON.parse(await paramsField.inputValue()) as Record<string, unknown>;
      expect(params).toHaveProperty('content');
      expect(params).toHaveProperty('x');
      expect(params).toHaveProperty('y');
      expect(params).not.toHaveProperty('sessionId');
      await dialog.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
      await expect(dialog.getByText('Quy trình hợp lệ và có thể chạy.')).toBeVisible({
        timeout: 30_000,
      });
      await dialog.locator('.workflow-panel').nth(1).locator('input').first().fill(suffix);
      await l.app.evaluate(({ dialog: nativeDialog }, file) => {
        nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, source);
      await dialog.getByRole('button', { name: 'Chọn PDF' }).click();
      await expect(dialog.getByText('contract.pdf', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Chạy quy trình' }).click();
      await expect(dialog.getByText('1 hoàn tất · 0 lỗi · 0 bỏ qua')).toBeVisible({
        timeout: 60_000,
      });
      expect(fs.existsSync(path.join(folder, `contract${suffix}.pdf`))).toBe(true);
    };

    const qr = await openCodeDialog();
    await qr.getByRole('textbox', { name: 'Nội dung' }).fill('https://chef.test/{filename}');
    await qr.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateRun('overlay.qrCode', '_qr');

    await l.page.keyboard.press('Escape');
    await expect(workflow()).toBeHidden();
    const barcode = await openCodeDialog();
    await barcode.getByRole('radio', { name: 'Mã vạch' }).click();
    await barcode.getByRole('textbox', { name: 'Nội dung' }).fill('HS-12345');
    await barcode.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateRun('overlay.barcode', '_barcode');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
