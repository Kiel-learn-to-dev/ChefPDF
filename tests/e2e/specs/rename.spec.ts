import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('preview, rename and undo selected files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-rename-'));
  const first = path.join(dir, 'a.txt');
  const second = path.join(dir, 'b.txt');
  fs.writeFileSync(first, 'A');
  fs.writeFileSync(second, 'B');
  const core = path.join(repoRoot, 'core');
  const l = await launchApp({
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
    await l.page.locator('.palette__input').fill('Đổi tên file hàng loạt');
    await l.page.getByText('Đổi tên file hàng loạt', { exact: true }).last().click();
    const dialog = l.page.getByRole('dialog', { name: 'Đổi tên file hàng loạt' });
    await l.app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      },
      [first, second],
    );
    await dialog.getByRole('button', { name: 'Thêm file…' }).click();
    await dialog.getByRole('button', { name: 'Xem trước' }).click();
    await expect(dialog.getByText(/a_01\.txt/)).toBeVisible({ timeout: 30_000 });
    expect(fs.existsSync(first)).toBe(true);
    await dialog.getByRole('button', { name: 'Đổi tên', exact: true }).click();
    await expect.poll(() => fs.existsSync(path.join(dir, 'a_01.txt'))).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Hoàn tác lần đổi tên' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Hoàn tác lần đổi tên' }).click();
    await expect.poll(() => fs.existsSync(first) && fs.existsSync(second)).toBe(true);
    expect(fs.readFileSync(first, 'utf8')).toBe('A');
    expect(fs.readFileSync(second, 'utf8')).toBe('B');
  } finally {
    await l.app.close();
    removeTempDirs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
