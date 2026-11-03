import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot } from '../fixtures/app';

test('list, fill, create and flatten form fields with the real core', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-forms-'));
  const core = path.join(repoRoot, 'core');
  const source = path.join(dir, 'form.pdf');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      core,
      'python',
      '-c',
      'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from forms_support import pikepdf_form; pikepdf_form(Path(sys.argv[2]))',
      path.join(core, 'tests'),
      source,
    ],
    { cwd: repoRoot },
  );
  const launched = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: `uv run --project "${core}" python -m chef_core` },
  });
  try {
    const page = launched.page;
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    await page.keyboard.press('Control+k');
    await page.locator('.palette__input').fill('Biểu mẫu PDF');
    await page.locator('[id="cmd-forms.open"]').click();
    const dialog = page.getByRole('dialog', { name: 'Biểu mẫu PDF' });
    await expect(dialog.getByText('hoten', { exact: true })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('textbox', { name: 'hoten', exact: true }).fill('Le Thi B');
    await dialog.getByRole('checkbox', { name: 'dongy', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'tinh', exact: true }).selectOption('HCM');
    await dialog.getByRole('radio', { name: /nu/i }).click();
    await dialog.getByRole('button', { name: 'Áp dụng giá trị' }).click();
    await expect(page.locator('.doctab__dirty')).toHaveCount(1, { timeout: 30_000 });
    await expect(dialog.getByRole('checkbox', { name: 'dongy', exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('combobox', { name: 'tinh', exact: true })).toHaveValue('HCM');
    await expect(dialog.getByRole('radio', { name: /nu/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press('Control+s');
    await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
    const savedValues = execFileSync(
      'uv',
      [
        'run',
        '--project',
        core,
        'python',
        '-c',
        'import json, sys, pikepdf; from chef_core.forms.model import FormDoc; from chef_core.forms.data import export_values; pdf=pikepdf.Pdf.open(sys.argv[1]); print(json.dumps(export_values(FormDoc(pdf))))',
        source,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(JSON.parse(savedValues)).toMatchObject({
      hoten: 'Le Thi B',
      dongy: false,
      tinh: 'HCM',
      gioitinh: 'nu',
    });

    await page.keyboard.press('Control+k');
    await page.locator('.palette__input').fill('Biểu mẫu PDF');
    await page.locator('[id="cmd-forms.open"]').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Thêm trường' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.form-draw__hint')).toBeVisible({ timeout: 5_000 });
    const canvas = page.locator('.pdfViewer .page canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('PDF page canvas is not visible');
    await page.mouse.move(box.x + 110, box.y + 110);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 145, { steps: 4 });
    await page.mouse.up();
    const createDialog = page.getByRole('dialog', { name: 'Biểu mẫu PDF' });
    await expect(createDialog.getByLabel('Tên trường')).toBeVisible({ timeout: 10_000 });
    await createDialog.getByLabel('Tên trường').fill('created_field');
    await createDialog.getByRole('button', { name: 'Tạo trường' }).click();
    await expect(createDialog.getByText('created_field', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await createDialog
      .getByRole('textbox', { name: 'hoten', exact: true })
      .fill('Unsaved before flatten');
    await createDialog.getByRole('button', { name: 'Làm phẳng biểu mẫu' }).click();
    const flattenConfirm = page.getByRole('dialog', { name: 'Làm phẳng biểu mẫu này?' });
    await expect(flattenConfirm).toContainText('không thể chỉnh sửa');
    await flattenConfirm.getByRole('button', { name: 'Hủy' }).click();
    await expect(createDialog.getByRole('textbox', { name: 'hoten', exact: true })).toHaveValue(
      'Unsaved before flatten',
    );
    await expect(createDialog.getByText('created_field', { exact: true })).toBeVisible();
    await createDialog.getByRole('button', { name: 'Làm phẳng biểu mẫu' }).click();
    await page
      .getByRole('dialog', { name: 'Làm phẳng biểu mẫu này?' })
      .getByRole('button', { name: 'Áp dụng giá trị và làm phẳng' })
      .click();
    await expect(page.locator('.doctab__dirty')).toHaveCount(1, { timeout: 30_000 });
    await expect(createDialog.getByText('Tài liệu chưa có trường biểu mẫu.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 30_000 });

    // Signature fields are delegated to the core's signing operation and survive flattening.
    await createDialog.getByRole('button', { name: 'Thêm trường' }).click();
    await expect(createDialog).toHaveCount(0);
    await expect(page.locator('.form-draw__hint')).toBeVisible({ timeout: 5_000 });
    const sigCanvas = page.locator('.pdfViewer .page canvas').first();
    await expect(sigCanvas).toBeVisible({ timeout: 30_000 });
    // The viewer repaints after the dialog closes; wait for a stable box.
    await expect.poll(() => sigCanvas.boundingBox()).not.toBeNull();
    const sigBox = await sigCanvas.boundingBox();
    if (!sigBox) throw new Error('PDF page canvas is not visible');
    await page.mouse.move(sigBox.x + 280, sigBox.y + 210);
    await page.mouse.down();
    await page.mouse.move(sigBox.x + 390, sigBox.y + 250, { steps: 4 });
    await page.mouse.up();
    const signatureDialog = page.getByRole('dialog', { name: 'Biểu mẫu PDF' });
    await expect(signatureDialog.getByLabel('Tên trường')).toBeVisible({ timeout: 10_000 });
    await signatureDialog.locator('.forms-create .select-trigger').click();
    await page.getByRole('option', { name: 'Chữ ký', exact: true }).click();
    await signatureDialog.getByLabel('Tên trường').fill('signature_field');
    await signatureDialog.getByRole('button', { name: 'Tạo trường' }).click();
    await expect(signatureDialog.getByText('signature_field', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(signatureDialog.getByRole('button', { name: 'Ký trường' })).toBeVisible();
  } finally {
    await launched.app.evaluate(({ app }) => app.exit(0));
    await Promise.race([
      launched.app.waitForEvent('close'),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      removeTempDirs();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
