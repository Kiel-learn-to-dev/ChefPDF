import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('build, validate, save, reopen and run a workflow with the real core', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/textedit_corpus.py');
  execFileSync('uv', ['run', '--project', core, 'python', fixture, folder], { cwd: repoRoot });
  const source = path.join(folder, 'contract.pdf');
  const workflowFile = path.join(folder, 'rotate.json');
  const unsafeFile = path.join(folder, 'unsafe.json');
  const output = path.join(folder, 'contract_word.pdf');
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Tạo quy trình');
    await l.page.getByText('Tạo quy trình', { exact: true }).last().click();

    const dialog = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(dialog).toBeVisible();
    const samplePicker = dialog.getByRole('combobox', { name: 'Dùng quy trình mẫu' });
    await samplePicker.click();
    await l.page.getByRole('option', { name: 'Rã tài liệu ra Word' }).click({ force: true });
    await expect(dialog.getByLabel('Tên quy trình').first()).toHaveValue('Rã tài liệu ra Word');
    await dialog.getByRole('button', { name: 'Xóa bước' }).click();
    const operationPicker = dialog.locator('input[aria-label="Mã thao tác"]');
    await operationPicker.fill('page.rotate');
    await dialog.getByRole('button', { name: 'Thêm bước' }).click();
    const params = dialog.getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
    await params.fill('{"pages":[');
    await expect(dialog.getByRole('button', { name: 'Chạy quy trình' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Lưu JSON' }).click();
    await expect(dialog.getByRole('alert').first()).toHaveText(
      'Tham số phải là một đối tượng JSON hợp lệ.',
    );
    expect(fs.existsSync(workflowFile)).toBe(false);
    await params.fill('{"pages":[0],"angle":90}');
    await l.app.evaluate(({ dialog: nativeDialog }, target) => {
      nativeDialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, workflowFile);
    await dialog.getByRole('button', { name: 'Lưu JSON' }).click();
    await expect.poll(() => fs.existsSync(workflowFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(workflowFile, 'utf8')).steps[0].op).toBe('page.rotate');

    await l.app.evaluate(({ dialog: nativeDialog }, target) => {
      nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, workflowFile);
    await dialog.getByRole('button', { name: 'Mở JSON' }).click();
    await expect(params).toHaveValue(/angle/);
    expect(JSON.parse(await params.inputValue())).toEqual({ pages: [0], angle: 90 });
    await dialog.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
    await expect(dialog.getByText('Quy trình hợp lệ và có thể chạy.')).toBeVisible({
      timeout: 30_000,
    });

    await l.app.evaluate(({ dialog: nativeDialog }, target) => {
      nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, source);
    await dialog.getByRole('button', { name: 'Chọn PDF' }).click();
    await expect(dialog.getByText('contract.pdf', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Chạy quy trình' }).click();
    await expect(dialog.getByText('1 hoàn tất · 0 lỗi · 0 bỏ qua')).toBeVisible({
      timeout: 60_000,
    });
    expect(fs.existsSync(output)).toBe(true);

    await dialog.getByRole('button', { name: 'Quy trình mới' }).click();
    await dialog.locator('input[aria-label="Mã thao tác"]').fill('security.encrypt');
    await dialog.getByRole('button', { name: 'Thêm bước' }).click();
    await dialog
      .getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' })
      .fill('{"userPassword":"do-not-save"}');
    await l.app.evaluate(({ dialog: nativeDialog }, target) => {
      nativeDialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, unsafeFile);
    await dialog.getByRole('button', { name: 'Lưu JSON' }).click();
    await expect(
      l.page.getByText(
        'Một bước đang chứa thông tin đăng nhập viết trực tiếp. Hãy thay bằng biến bí mật trước khi lưu.',
      ),
    ).toBeVisible();
    expect(fs.existsSync(unsafeFile)).toBe(false);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
