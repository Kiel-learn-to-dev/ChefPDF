import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('export the open document to Markdown with the real core', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-export-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/textedit_corpus.py');
  execFileSync('uv', ['run', '--project', core, 'python', fixture, folder], { cwd: repoRoot });
  const source = path.join(folder, 'contract.pdf');
  const output = path.join(folder, 'contract.md');
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('tab', { name: 'Xuất', exact: true }).click();
    await l.page.getByRole('button', { name: 'Xuất tài liệu', exact: true }).click();
    const dlg = l.page.getByRole('dialog', { name: 'Xuất tài liệu' });
    await dlg.locator('#document-export-format').click();
    await l.page.getByRole('option', { name: 'MD', exact: true }).click();
    const original = fs.readFileSync(source);
    await l.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, source);
    await dlg.getByRole('button', { name: 'Chọn nơi lưu và xuất' }).click();
    await expect(
      l.page.getByText('Hãy chọn một file khác để không ghi đè tài liệu nguồn.'),
    ).toBeVisible();
    expect(fs.readFileSync(source)).toEqual(original);
    await l.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, output);
    await dlg.getByRole('button', { name: 'Chọn nơi lưu và xuất' }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    expect(fs.readFileSync(output, 'utf8')).toContain('Công ty ABC');
    expect(fs.existsSync(source)).toBe(true);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('exporting over an existing file replaces it after the system save dialog confirmed', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-export-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/textedit_corpus.py');
  execFileSync('uv', ['run', '--project', core, 'python', fixture, folder], { cwd: repoRoot });
  const source = path.join(folder, 'contract.pdf');
  const output = path.join(folder, 'contract.txt');
  fs.writeFileSync(output, 'old');
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('tab', { name: 'Xuất', exact: true }).click();
    await l.page.getByRole('button', { name: 'Xuất tài liệu', exact: true }).click();
    const dlg = l.page.getByRole('dialog', { name: 'Xuất tài liệu' });
    await dlg.locator('#document-export-format').click();
    await l.page.getByRole('option', { name: 'TXT', exact: true }).click();
    await l.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, output);
    await dlg.getByRole('button', { name: 'Chọn nơi lưu và xuất' }).click();
    await expect(dlg).toBeHidden({ timeout: 60_000 });
    expect(fs.readFileSync(output, 'utf8')).toContain('Công ty ABC');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('batch export reports successes and errors separately', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-batch-export-'));
  const core = path.join(repoRoot, 'core');
  const fixture = path.join(repoRoot, 'tests/e2e/fixtures/textedit_corpus.py');
  execFileSync('uv', ['run', '--project', core, 'python', fixture, folder], { cwd: repoRoot });
  const source = path.join(folder, 'contract.pdf');
  const broken = path.join(folder, 'broken.pdf');
  const destination = path.join(folder, 'out');
  fs.writeFileSync(broken, 'not a PDF');
  fs.mkdirSync(destination);
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Xuất tài liệu hàng loạt');
    await l.page.getByText('Xuất tài liệu hàng loạt', { exact: true }).last().click();
    const dlg = l.page.getByRole('dialog', { name: 'Xuất tài liệu hàng loạt' });
    await l.app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      },
      [source, broken],
    );
    await dlg.getByRole('button', { name: 'Thêm PDF…' }).click();
    await l.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, destination);
    await dlg.getByRole('button', { name: 'Chọn…' }).click();
    await dlg.locator('#batch-export-format').click();
    await l.page.getByRole('option', { name: 'MD', exact: true }).click();
    await dlg.getByRole('button', { name: 'Xuất hàng loạt' }).click();
    const results = dlg.getByRole('region', { name: 'Kết quả từng file' });
    await expect(results.getByText('Đã xuất', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(results.getByText('Lỗi', { exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(destination, 'contract.md'), 'utf8')).toContain('Công ty ABC');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
