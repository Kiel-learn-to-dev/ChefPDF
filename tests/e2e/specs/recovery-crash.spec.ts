import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('restores unsaved edits after the real core crashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-crash-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'before.pdf');
  const marker = path.join(dir, 'crash');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      core,
      'python',
      '-c',
      'from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.drawString(20,700,"first"); c.showPage(); c.save()',
      source,
    ],
    { cwd: repoRoot },
  );
  const before = fs.readFileSync(source);
  const l = await launchApp({
    args: [source],
    env: {
      CHEF_CORE_CMD: `uv run --project "${core}" python "${path.join(repoRoot, 'tests/e2e/fixtures/crashable_core.py')}"`,
      CHEF_TEST_CRASH_MARKER: marker,
    },
  });
  try {
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await l.page.click('.ftab >> text=Trang');
    await l.page.waitForSelector('.page-card img', { timeout: 30_000 });
    await l.page.click('.page-card[data-index="0"]');
    await l.page.keyboard.press('Control+d');
    await expect(l.page.locator('.page-card')).toHaveCount(2, { timeout: 30_000 });
    await expect(l.page.locator('.doctab__dirty')).toBeVisible();
    fs.writeFileSync(marker, 'crash');
    const restore = l.page.getByRole('button', { name: 'Khôi phục phiên' });
    await expect(restore).toBeVisible({ timeout: 30_000 });
    await restore.click();
    await expect(restore).toBeHidden({ timeout: 30_000 });
    await expect(l.page.locator('.page-card')).toHaveCount(2);
    await expect(l.page.locator('.doctab__dirty')).toBeVisible();
    expect(fs.readFileSync(source)).toEqual(before);
    await l.page.keyboard.press('Control+s');
    await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
    const pages = execFileSync(
      'uv',
      [
        'run',
        '--project',
        core,
        'python',
        '-c',
        'import pikepdf,sys; p=pikepdf.open(sys.argv[1]); print(len(p.pages))',
        source,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    expect(pages).toBe('2');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
