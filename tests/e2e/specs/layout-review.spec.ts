import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('review a heading as a paragraph and use the reviewed model for export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-layout-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'report.pdf');
  const output = path.join(dir, 'reviewed.md');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      core,
      'python',
      '-c',
      'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from layout_support import report_pdf; report_pdf(Path(sys.argv[2]), pages=6)',
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
    await l.page.locator('.palette__input').fill('Kiểm tra bố cục');
    await l.page.getByText('Kiểm tra bố cục', { exact: true }).last().click();
    const dialog = l.page.getByRole('dialog', { name: 'Kiểm tra bố cục' });
    await dialog.getByRole('button', { name: 'Phân tích tài liệu' }).click();
    const resultPreview = dialog.getByRole('region', { name: 'Kết quả nhận diện' });
    await expect(resultPreview.getByText('Báo cáo thường niên')).toBeVisible({ timeout: 30_000 });
    const blocks = dialog.locator('.layout-review__block');
    let block = blocks.first();
    for (let index = 0; index < (await blocks.count()); index += 1) {
      const candidate = blocks.nth(index);
      if (
        (await candidate
          .locator('textarea')
          .inputValue()
          .catch(() => '')) === 'Báo cáo thường niên'
      ) {
        block = candidate;
        break;
      }
    }
    await expect(block).toBeVisible({ timeout: 30_000 });
    await block.locator('textarea').fill('BÁO CÁO THƯỜNG NIÊN');
    await expect(resultPreview.getByText('BÁO CÁO THƯỜNG NIÊN')).toBeVisible();
    await block.getByRole('button', { name: /Vị trí khối/ }).click();
    await expect(dialog.getByTestId('layout-region')).toBeVisible();
    await block.getByRole('combobox', { name: /Loại khối/ }).click();
    await l.page.getByRole('option', { name: 'Đoạn văn', exact: true }).click();
    await dialog.getByRole('button', { name: 'Tiếp tục xuất' }).click();
    const exportDialog = l.page.getByRole('dialog', { name: 'Xuất tài liệu' });
    await expect(exportDialog.getByText('Đang dùng bố cục đã kiểm tra.')).toBeVisible({
      timeout: 30_000,
    });
    await l.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, output);
    await exportDialog.locator('#document-export-format').click();
    await l.page.getByRole('option', { name: 'MD', exact: true }).click();
    await exportDialog.getByRole('button', { name: 'Chọn nơi lưu và xuất' }).click();
    await expect(exportDialog).toBeHidden({ timeout: 60_000 });
    const markdown = fs.readFileSync(output, 'utf8');
    expect(markdown).toContain('BÁO CÁO THƯỜNG NIÊN');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
