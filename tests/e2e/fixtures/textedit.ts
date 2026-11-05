/**
 * Drivers of the text edit mode (D65): select the text on the page by a drag, then open it with the
 * Sửa button of the format bar. The line boxes (`tedit-box`) only place the text for the drivers.
 */
import { expect, type Page } from '@playwright/test';

/** Drags across the whole line that holds `phrase`: its text is selected on the page. */
export async function selectLine(page: Page, phrase: string): Promise<void> {
  const box = page.locator(`[data-testid="tedit-box"][data-text*="${phrase}"]`).first();
  await box.waitFor({ timeout: 30_000 });
  const b = await box.boundingBox();
  if (!b) throw new Error(`no box for "${phrase}"`);
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('tedit-selection').first()).toBeVisible({ timeout: 30_000 });
}

/** The Sửa button of the format bar: the selected text opens as a textbox (D65). */
export async function clickEdit(page: Page): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Định dạng chữ' })
    .getByRole('button', { name: 'Sửa', exact: true })
    .click();
  await expect(page.getByTestId('tedit-session')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('tedit-caret')).toBeVisible();
}
