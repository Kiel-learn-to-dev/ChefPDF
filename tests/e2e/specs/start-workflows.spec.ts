import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
test.skip(!uiBuilt, 'UI not built');

test('opens a workflow sample from Start with its steps and output rule', async () => {
  const core = path.join(repoRoot, 'core');
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    const section = l.page
      .locator('section')
      .filter({ has: l.page.getByRole('heading', { name: 'Quy trình mẫu' }) });
    await expect(section).toBeVisible({ timeout: 30000 });
    await section.getByRole('button', { name: /Rã tài liệu ra Word/ }).click();
    const dialog = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Mã thao tác', { exact: true }).first()).toHaveValue(
      'export.document',
    );
    await expect(dialog.locator('.workflow-step__fields input').nth(1)).toHaveValue(
      'Xuất Word dễ chỉnh sửa',
    );
  } finally {
    await l.app.close();
    removeTempDirs();
  }
});

test('dropping a PDF on the Word workflow produces an output without opening the input', async () => {
  const core = path.join(repoRoot, 'core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-start-workflow-'));
  execFileSync('uv', ['run', '--project', core, 'python', 'scripts/gen_corpus.py', '--out', dir], {
    cwd: repoRoot,
  });
  const source = path.join(dir, 'vietnamese_text.pdf');
  const output = path.join(dir, 'vietnamese_text_word.docx');
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    const button = l.page.getByRole('button', { name: /Rã tài liệu ra Word/ });
    await expect(button).toBeVisible({ timeout: 30000 });
    await l.page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'test-drop-input';
      document.body.append(input);
    });
    await l.page.locator('#test-drop-input').setInputFiles(source);
    await button.evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#test-drop-input')!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]!);
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect.poll(() => fs.existsSync(output), { timeout: 30000 }).toBe(true);
    await expect(l.page.locator('.doctab__name')).toHaveCount(0);
    await expect(l.page.getByText('Xem kết quả', { exact: true })).toBeVisible();
    const signButton = l.page.getByRole('button', { name: /Nộp hồ sơ online/ });
    await signButton.evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#test-drop-input')!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]!);
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    const dialog = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog).toContainText('vietnamese_text.pdf');
    await expect(dialog.locator('.workflow-step').last().getByLabel('Mã thao tác')).toHaveValue(
      'sign.pades',
    );
    expect(fs.existsSync(path.join(dir, 'vietnamese_text_da-ky.pdf'))).toBe(false);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dropping a low-confidence scan on the book workflow surfaces a review warning', async () => {
  const core = path.join(repoRoot, 'core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-start-book-review-'));
  const source = path.join(dir, 'low-confidence.pdf');
  const generator = [
    'from pathlib import Path',
    'import sys',
    "sys.path.insert(0, str(Path.cwd() / 'core' / 'tests'))",
    'from pageimg_support import photo_scene',
    'from test_pageimg_ops import _image_pdf',
    'scene = photo_scene(size=(1240, 1754), seed=81, background="plain", bg_colour=(192, 190, 182), paper_colour=(199, 197, 189), noise=1.0)',
    '_image_pdf(Path(sys.argv[1]), [scene.rgb])',
  ].join('\n');
  execFileSync('uv', ['run', '--project', core, 'python', '-c', generator, source], {
    cwd: repoRoot,
  });
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    const button = l.page.getByRole('button', { name: /Chụp sách/ });
    await expect(button).toBeVisible({ timeout: 30000 });
    await l.page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'test-book-drop-input';
      document.body.append(input);
    });
    await l.page.locator('#test-book-drop-input').setInputFiles(source);
    await button.evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#test-book-drop-input')!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]!);
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    const warning = l.page.locator('.toast--warning');
    await expect(warning).toBeVisible({ timeout: 30000 });
    await warning.getByRole('button', { name: 'Xem kết quả' }).click();
    await expect(l.page.getByRole('dialog', { name: 'Tạo quy trình' })).toContainText(
      'cần duyệt thủ công trang 1',
    );
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merge packet workflow follows the reordered PDFs through Electron and the real core', async () => {
  const core = path.join(repoRoot, 'core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-merge-packet-'));
  const generator = [
    'from pathlib import Path',
    'import sys',
    'from reportlab.pdfgen import canvas',
    'first, second = map(Path, sys.argv[1:3])',
    'for target, shade in ((first, 28), (second, 220)):',
    '    pdf = canvas.Canvas(str(target), pagesize=(200, 200))',
    '    pdf.setFillColorRGB(shade / 255, shade / 255, shade / 255)',
    '    pdf.rect(0, 0, 200, 200, fill=1, stroke=0)',
    '    pdf.showPage()',
    '    pdf.save()',
  ].join('\n');
  const first = path.join(dir, 'first-dark.pdf');
  const second = path.join(dir, 'second-light.pdf');
  const output = path.join(dir, 'second-light_da-ky.pdf');
  execFileSync('uv', ['run', '--project', core, 'python', '-c', generator, first, second], {
    cwd: repoRoot,
  });
  const before = [fs.readFileSync(first), fs.readFileSync(second)];
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    const section = l.page
      .locator('section')
      .filter({ has: l.page.getByRole('heading', { name: 'Quy trình mẫu' }) });
    await expect(section).toBeVisible({ timeout: 30000 });
    await section.getByRole('button', { name: /Nộp hồ sơ online/ }).click();
    const dialog = l.page.getByRole('dialog', { name: 'Tạo quy trình' });
    await expect(dialog).toContainText('Các PDF được ghép theo thứ tự bên dưới');
    for (let i = 0; i < 3; i += 1)
      await dialog.getByRole('button', { name: 'Xóa bước' }).first().click();
    await dialog.locator('input[aria-label="Mã thao tác"]').fill('scan.rasterize');
    await dialog.getByRole('button', { name: 'Thêm bước' }).click();
    await dialog
      .getByRole('textbox', { name: 'Tham số (đối tượng JSON) 1' })
      .fill('{"dpi":72,"color":"gray"}');
    await l.app.evaluate(
      ({ dialog: nativeDialog }, paths) => {
        nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      },
      [first, second],
    );
    await dialog.getByRole('button', { name: 'Chọn PDF' }).click();
    const rows = dialog.locator('.workflow-files li');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).getByRole('button', { name: 'Đưa PDF xuống sau' }).click();
    await expect(rows.nth(0)).toContainText('second-light.pdf');
    await expect(rows.nth(1)).toContainText('first-dark.pdf');
    await dialog.getByRole('button', { name: 'Chạy quy trình' }).click();
    await expect(dialog.getByText('1 hoàn tất · 0 lỗi · 0 bỏ qua')).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog).toContainText('Đã ghép 2 PDF theo thứ tự đã chọn');
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.readFileSync(first)).toEqual(before[0]);
    expect(fs.readFileSync(second)).toEqual(before[1]);
    const inspected = execFileSync(
      'uv',
      [
        'run',
        '--project',
        core,
        'python',
        '-c',
        [
          'import json, sys',
          'import pypdfium2 as pdfium',
          'doc = pdfium.PdfDocument(sys.argv[1])',
          'means = []',
          'for page in doc:',
          '    image = page.render(scale=0.2).to_numpy()',
          '    h, w = image.shape[:2]',
          '    means.append(float(image[h // 2, w // 2, :3].mean()))',
          'print(json.dumps({"pages": len(doc), "means": means}))',
        ].join('\n'),
        output,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const report = JSON.parse(inspected) as { pages: number; means: number[] };
    expect(report.pages).toBe(2);
    expect(report.means[0]!).toBeGreaterThan(report.means[1]!);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
