import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('saves color task settings as a workflow step and validates with the real core', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-task-step-'));
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
    await l.page.locator('.palette__input').fill('Chuyển màu');
    await l.page.getByRole('option', { name: /Chuyển màu/ }).click();

    const colorDialog = l.page.getByRole('dialog', { name: 'Chuyển màu' });
    await expect(colorDialog).toBeVisible();
    await colorDialog.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();

    const workflowDialog = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(workflowDialog).toBeVisible();
    const stepParams = workflowDialog.getByRole('textbox', {
      name: 'Tham số (đối tượng JSON) 1',
    });
    await expect(stepParams).toHaveValue(/"mode":\s*"gray"/);
    await expect(workflowDialog.locator('#workflow-name')).toHaveValue('Quy trình mới');
    await expect(workflowDialog.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(
      'color.convert',
    );

    await workflowDialog.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
    await expect(workflowDialog.getByText('Quy trình hợp lệ và có thể chạy.')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('saves scan and compression settings without session or fixed output paths', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-transform-steps-'));
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
    const openCommand = async (term: string) => {
      await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
      await l.page.locator('.palette__input').fill(term);
      await l.page.getByRole('option', { name: new RegExp(term) }).click();
    };
    const workflow = () => l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    const validateAndRun = async (
      op: string,
      expected: Record<string, unknown>,
      suffix: string,
    ) => {
      const dialog = workflow();
      await expect(dialog.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(op);
      const params = await dialog
        .getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' })
        .inputValue();
      expect(JSON.parse(params)).toEqual(expected);
      expect(params).not.toMatch(/sessionId|outputPath|inputPath/);
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

    await openCommand('Chuyển thành bản scan');
    const scanDialog = l.page.getByRole('dialog', { name: 'Chuyển thành bản scan' });
    await scanDialog.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateAndRun(
      'scan.rasterize',
      {
        dpi: 200,
        color: 'gray',
        jpegQuality: 75,
        threshold: 128,
        dithering: false,
        stripMetadata: true,
        effectsPreset: 'none',
        seed: 0,
      },
      '_scan',
    );

    await l.page.keyboard.press('Escape');
    await expect(workflow()).toBeHidden();
    await openCommand('Nén PDF');
    const compressDialog = l.page.getByRole('dialog', { name: 'Nén PDF' });
    await compressDialog.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateAndRun(
      'compress.pdf',
      {
        preset: 'ebook',
        grayscale: false,
        removeUnused: true,
        removeMetadata: false,
        removeThumbnails: true,
        removeAttachments: false,
        subsetFonts: true,
        flattenTransparency: false,
        maxImageDpi: 150,
        jpegQuality: 70,
      },
      '_compress',
    );
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('saves page numbering and watermark settings as reusable workflow steps', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-workflow-overlay-steps-'));
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
    const openCommand = async (term: string) => {
      await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
      await l.page.locator('.palette__input').fill(term);
      await l.page
        .getByRole('option', { name: new RegExp(term, 'i') })
        .first()
        .click();
    };
    const workflow = () => l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    const validateRun = async (op: string, suffix: string) => {
      const dialog = workflow();
      await expect(dialog.getByRole('textbox', { name: 'Mã thao tác' })).toHaveValue(op);
      const paramsField = dialog.getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' });
      const paramsText = await paramsField.inputValue();
      const params = JSON.parse(paramsText) as Record<string, unknown>;
      expect(params).not.toHaveProperty('sessionId');
      expect(params).not.toHaveProperty('inputPath');
      expect(params).not.toHaveProperty('outputPath');
      expect(params).not.toHaveProperty('pages');
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

    await openCommand('Số trang');
    const numbers = l.page.getByRole('dialog', { name: 'Số trang' });
    await numbers.getByRole('combobox', { name: 'Trang áp dụng' }).click();
    await l.page.getByRole('option', { name: /Tất cả/ }).click();
    await numbers.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateRun('overlay.pageNumbers', '_numbered');

    await l.page.keyboard.press('Escape');
    await expect(workflow()).toBeHidden();
    await openCommand('Watermark');
    const watermark = l.page.getByRole('dialog', { name: 'Watermark' });
    await watermark.getByRole('combobox', { name: 'Trang áp dụng' }).click();
    await l.page.getByRole('option', { name: /Tất cả/ }).click();
    await watermark.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateRun('overlay.watermark', '_watermarked');

    await l.page.keyboard.press('Escape');
    await expect(workflow()).toBeHidden();
    await openCommand('Header/Footer');
    const headerFooter = l.page.getByRole('dialog', { name: 'Header / Footer' });
    await headerFooter.getByRole('combobox', { name: 'Trang áp dụng' }).click();
    await l.page.getByRole('option', { name: /Tất cả/ }).click();
    await headerFooter.getByRole('button', { name: 'Lưu thành bước quy trình' }).click();
    await validateRun('overlay.headerFooter', '_header_footer');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
