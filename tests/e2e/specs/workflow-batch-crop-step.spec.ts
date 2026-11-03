import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('saves batch auto-crop settings as an all-pages workflow step and runs it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-batch-crop-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/batch_crop_corpus.py');
  const source = path.join(folder, 'batch.pdf');
  execFileSync(
    'uv',
    ['run', '--project', core, 'python', fixture, path.join(core, 'tests'), source],
    {
      cwd: repoRoot,
    },
  );
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Cắt hàng loạt');
    await l.page.getByRole('option', { name: /Dò viền và cắt hàng loạt/ }).click();

    const task = l.page.getByRole('dialog', { name: 'Dò viền và cắt hàng loạt' });
    await expect(task).toBeVisible();
    await task.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();

    const workflow = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(workflow.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(
      'pageimg.autoCrop',
    );
    const params = workflow.getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
    expect(JSON.parse(await params.inputValue())).toEqual({
      minConfidence: 0.6,
      paperSize: 'auto',
    });
    await workflow.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
    await expect(workflow.getByText('Quy trình hợp lệ và có thể chạy.')).toBeVisible({
      timeout: 30_000,
    });

    await workflow.locator('.workflow-panel').nth(1).locator('input').first().fill('_cropped');
    await l.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    await workflow.getByRole('button', { name: 'Chọn PDF' }).click();
    await workflow.getByRole('button', { name: 'Chạy quy trình' }).click();
    await expect(workflow.getByText('1 hoàn tất · 0 lỗi · 0 bỏ qua')).toBeVisible({
      timeout: 60_000,
    });
    expect(fs.existsSync(path.join(folder, 'batch_cropped.pdf'))).toBe(true);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('saves the reviewed page selection after detection', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-crop-selection-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(folder, 'batch.pdf');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      core,
      'python',
      path.join(repoRoot, 'tests/e2e/fixtures/batch_crop_corpus.py'),
      path.join(core, 'tests'),
      source,
    ],
    { cwd: repoRoot },
  );
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Cắt hàng loạt');
    await l.page.getByRole('option', { name: /Dò viền và cắt hàng loạt/ }).click();
    const task = l.page.getByRole('dialog', { name: 'Dò viền và cắt hàng loạt' });
    await task.getByRole('button', { name: 'Dò các trang' }).click();
    await expect(task.locator('.batch-crop__list li')).toHaveCount(2, { timeout: 30_000 });
    await task.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    const params = l.page
      .getByRole('dialog', { name: 'Tạo quy trình' })
      .getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
    expect(JSON.parse(await params.inputValue())).toEqual({
      pages: [0],
      minConfidence: 0.6,
      paperSize: 'auto',
    });
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
