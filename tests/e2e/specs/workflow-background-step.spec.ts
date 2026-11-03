import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('saves background cleanup settings as a workflow step that validates and runs', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-background-step-'));
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
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Gỡ / đổi nền trang');
    await l.page.getByRole('option', { name: /Gỡ \/ đổi nền trang/ }).click();

    const task = l.page.getByRole('dialog', { name: 'Gỡ hoặc đổi nền trang' });
    await expect(task).toBeVisible();
    await task.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();

    const workflow = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(workflow.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(
      'background.remove',
    );
    const params = workflow.getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
    expect(JSON.parse(await params.inputValue())).toEqual({ mode: 'remove' });
    await workflow.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
    await expect(workflow.getByText('Quy trình hợp lệ và có thể chạy.')).toBeVisible({
      timeout: 30_000,
    });

    await workflow.locator('.workflow-panel').nth(1).locator('input').first().fill('_cleaned');
    await l.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    await workflow.getByRole('button', { name: 'Chọn PDF' }).click();
    await workflow.getByRole('button', { name: 'Chạy quy trình' }).click();
    await expect(workflow.getByText('1 hoàn tất · 0 lỗi · 0 bỏ qua')).toBeVisible({
      timeout: 60_000,
    });
    expect(fs.existsSync(path.join(folder, 'contract_cleaned.pdf'))).toBe(true);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
