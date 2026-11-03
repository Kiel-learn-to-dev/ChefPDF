import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('detect headings and insert a linked contents page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-toc-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'report.pdf');
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
    await l.page.locator('.palette__input').fill('Tạo trang mục lục');
    await l.page.getByText('Tạo trang mục lục', { exact: true }).last().click();
    const dlg = l.page.getByRole('dialog', { name: 'Tạo trang mục lục' });
    await dlg.getByRole('button', { name: 'Dò tiêu đề' }).click();
    await expect(dlg.getByText(/Giới thiệu/)).toBeVisible({ timeout: 30_000 });
    await dlg.getByRole('button', { name: 'Chèn mục lục' }).click();
    await expect(dlg).toBeHidden({ timeout: 30_000 });
    await l.page.keyboard.press('Control+s');
    await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
      timeout: 30_000,
    });
    const result = execFileSync(
      'uv',
      [
        'run',
        '--project',
        core,
        'python',
        '-c',
        'import sys,json,pikepdf,pypdfium2 as p; f=sys.argv[1]; d=p.PdfDocument(f); t=d[0].get_textpage().get_text_range(); d.close(); q=pikepdf.open(f); print(json.dumps({"text":t,"pages":len(q.pages),"links":len(q.pages[0].obj.get("/Annots",[]))})); q.close()',
        source,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const data = JSON.parse(result) as { text: string; pages: number; links: number };
    expect(data.text).toContain('Mục lục');
    expect(data.pages).toBe(7);
    expect(data.links).toBeGreaterThan(0);
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
