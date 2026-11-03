import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('review the actual page image, adjust a corner and crop the PDF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-crop-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'scan.pdf');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      core,
      'python',
      path.join(repoRoot, 'tests/e2e/fixtures/dewarp_corpus.py'),
      source,
    ],
    { cwd: repoRoot },
  );
  const before = fs.readFileSync(source);
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Cắt và nắn ảnh trang');
    await l.page.getByText('Cắt và nắn ảnh trang', { exact: true }).last().click();
    const dlg = l.page.getByRole('dialog', { name: 'Cắt và nắn ảnh trang' });
    await dlg.getByRole('button', { name: 'Dò viền và xem trước' }).click();
    await expect(dlg.getByRole('img', { name: 'Ảnh trang gốc' })).toBeVisible({ timeout: 30_000 });
    const detectedRight = await dlg.locator('.crop-review__image polygon').evaluate((polygon) =>
      Math.max(
        ...polygon
          .getAttribute('points')!
          .split(' ')
          .map((pair) => Number(pair.split(',')[0])),
      ),
    );
    const corrected = dlg.getByRole('img', { name: 'Xem trước sau khi nắn' });
    await expect(corrected).toBeVisible({ timeout: 30_000 });
    const cropButton = dlg.getByRole('button', { name: 'Cắt trang', exact: true });
    await dlg.getByLabel('Rộng đầu ra (mm)').fill('20');
    await expect(cropButton).toBeDisabled();
    await dlg.getByLabel('Cao đầu ra (mm)').fill('30');
    await expect(dlg.getByText(/Ảnh xem trước dùng đúng tỉ lệ đầu ra/)).toBeVisible();
    await expect(cropButton).toBeEnabled();
    await dlg.getByLabel('Cao đầu ra (mm)').fill('100000');
    await expect(cropButton).toBeDisabled();
    await dlg.getByLabel('Cao đầu ra (mm)').fill('30');
    await dlg.getByLabel('Tỉ lệ khung (giữ khi kéo)').selectOption('210/297');
    await expect(dlg.locator('.crop-review__handle')).toHaveCount(8);
    const edge = dlg.getByRole('button', { name: 'Cạnh phải' });
    await expect(edge).toBeVisible();
    const previousX = await edge.evaluate((element) => element.style.left);
    await edge.focus();
    await edge.press('Shift+ArrowLeft');
    await expect.poll(() => edge.evaluate((element) => element.style.left)).not.toBe(previousX);
    const geometry = await dlg.locator('.crop-review__image').evaluate((image) => {
      const handles = [
        ...image.querySelectorAll<HTMLButtonElement>(
          '.crop-review__handle:not(.crop-review__handle--edge)',
        ),
      ];
      const x0 = parseFloat(handles[0]!.style.left),
        x1 = parseFloat(handles[1]!.style.left);
      const y0 = parseFloat(handles[0]!.style.top),
        y1 = parseFloat(handles[3]!.style.top);
      const bounds = image.getBoundingClientRect();
      return ((x1 - x0) * bounds.width) / ((y1 - y0) * bounds.height);
    });
    expect(geometry).toBeCloseTo(210 / 297, 3);
    await dlg.getByLabel('Tỉ lệ khung (giữ khi kéo)').selectOption('free');
    const bounds = await dlg.locator('.crop-review__image').boundingBox();
    const handleBounds = await edge.boundingBox();
    expect(bounds).not.toBeNull();
    expect(handleBounds).not.toBeNull();
    await l.page.mouse.move(
      handleBounds!.x + handleBounds!.width / 2,
      handleBounds!.y + handleBounds!.height / 2,
    );
    await l.page.mouse.down();
    await l.page.mouse.move(
      bounds!.x + (bounds!.width * detectedRight) / 100 - 3,
      handleBounds!.y + handleBounds!.height / 2,
    );
    await l.page.mouse.up();
    expect(parseFloat(await edge.evaluate((element) => element.style.left))).toBeCloseTo(
      detectedRight,
      3,
    );
    await dlg.getByLabel('Kiểu khung').selectOption('quad');
    await expect(dlg.locator('.crop-review__handle')).toHaveCount(4);
    await dlg.getByLabel('Tỉ lệ khung (giữ khi kéo)').selectOption('free');
    await dlg.getByLabel('Trang').fill('2');
    await dlg.getByRole('button', { name: 'Dò viền và xem trước' }).click();
    await expect(dlg.getByLabel('Rộng đầu ra (mm)')).toHaveValue('');
    await expect(dlg.getByLabel('Cao đầu ra (mm)')).toHaveValue('');
    await dlg.getByLabel('Trang').fill('1');
    await dlg.getByRole('button', { name: 'Dò viền và xem trước' }).click();
    await expect(dlg.getByRole('img', { name: 'Ảnh trang gốc' })).toBeVisible({ timeout: 30_000 });
    await dlg.getByLabel('Rộng đầu ra (mm)').fill('20');
    await dlg.getByLabel('Cao đầu ra (mm)').fill('30');
    const oldPreview = await corrected.getAttribute('src');
    expect(fs.readFileSync(source)).toEqual(before);
    const corner = dlg.getByRole('button', { name: 'Góc 1' });
    await corner.focus();
    const magnifier = dlg.locator('.crop-review__magnifier');
    await expect(magnifier).toBeVisible();
    const beforeMove = await magnifier.evaluate(
      (element) => getComputedStyle(element).backgroundPosition,
    );
    await corner.press('Shift+ArrowRight');
    await expect
      .poll(() => magnifier.evaluate((element) => getComputedStyle(element).backgroundPosition))
      .not.toBe(beforeMove);
    await expect(corrected).toBeVisible({ timeout: 30_000 });
    await expect(corrected).not.toHaveAttribute('src', oldPreview!);
    const beforeRotation = await corrected.getAttribute('src');
    const angle = dlg.getByLabel('Xoay tinh (độ)');
    await angle.fill('16');
    await expect(cropButton).toBeDisabled();
    await angle.fill('2.5');
    await expect(cropButton).toBeEnabled();
    await expect(corrected).not.toHaveAttribute('src', beforeRotation!, { timeout: 30_000 });
    await cropButton.click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await expect(l.page.locator('.doctab__dirty')).toBeVisible();
    await l.page.keyboard.press('Control+s');
    await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
      timeout: 30_000,
    });
    expect(fs.readFileSync(source).equals(before)).toBe(false);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batch crop leaves low-confidence pages unchanged for manual review', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-batch-crop-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'batch.pdf');
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
  const imageHash = () =>
    execFileSync(
      'uv',
      [
        'run',
        '--project',
        core,
        'python',
        '-c',
        'import hashlib,pikepdf,sys; p=pikepdf.open(sys.argv[1]); s=next(iter(p.pages[1].Resources.XObject.values())); print(hashlib.sha256(s.read_raw_bytes()).hexdigest()); p.close()',
        source,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
  const originalHash = imageHash();
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Dò viền và cắt hàng loạt');
    await l.page.getByText('Dò viền và cắt hàng loạt', { exact: true }).last().click();
    const dlg = l.page.getByRole('dialog', { name: 'Dò viền và cắt hàng loạt' });
    await dlg.getByRole('button', { name: 'Dò các trang' }).click();
    const rows = dlg.locator('.batch-crop__list li');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.nth(0)).toContainText('Có thể cắt');
    await expect(rows.nth(1)).toContainText('Cần xem lại');
    await dlg.getByRole('button', { name: 'Cắt các trang đã chọn' }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await l.page.keyboard.press('Control+s');
    await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
      timeout: 30_000,
    });
    expect(imageHash()).toBe(originalHash);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
