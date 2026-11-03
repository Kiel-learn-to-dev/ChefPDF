/**
 * Đối chứng dương cho các luật của bộ đo giao diện (docs/UI_AUDIT.md mục 2, lượt A4).
 *
 * Chèn DOM có lỗi có chủ đích rồi kiểm từng luật có bắt được không. Nếu một luật ngừng hoạt
 * động (selector đổi, phạm vi sai, transform bỏ nhầm), bộ đo vẫn báo "sạch" nên cần test này.
 * Không dùng lõi PDF: chỉ mở app ở màn hình start.
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';
import { prepare, stubNativeDialogs } from '../fixtures/uiAudit';
import { AUDIT_CFG, auditInPage, type AuditResult } from '../fixtures/uiAuditRules';

const realCoreCmd = `uv run --project "${path.join(repoRoot, 'core')}" python -m chef_core`;

/** Tạo phần tử với chữ và style (CSSOM, không dùng style attribute để không vướng CSP). */
function planted(): void {
  const mk = (tag: string, text: string, css: string, cls = ''): HTMLElement => {
    const e = document.createElement(tag);
    e.textContent = text;
    e.style.cssText = css;
    if (cls) e.className = cls;
    return e;
  };
  const wrap = document.createElement('div');
  wrap.id = 'selftest';
  wrap.style.cssText =
    'position:fixed;left:300px;top:200px;width:600px;z-index:9999;background:#fff;padding:8px';
  // label-overflow: nút 40px, chữ dài không xuống dòng
  wrap.append(
    mk(
      'button',
      'Chữ rất dài không rút gọn được',
      'width:40px;height:32px;white-space:nowrap;padding:0 4px;',
      'btn',
    ),
  );
  // text-overflow: chữ tràn, overflow visible (không phải nút, nên không trùng với label-overflow)
  wrap.append(
    mk('div', 'Chữ tràn ra ngoài khung hẹp', 'width:60px;white-space:nowrap;overflow:visible;'),
  );
  // text-truncated: có ellipsis
  wrap.append(
    mk(
      'div',
      'Chữ bị rút gọn bằng dấu ba chấm',
      'width:60px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    ),
  );
  // control-clipped: nút nằm trong khung overflow hidden, bị cắt
  const clip = mk('div', '', 'width:120px;height:40px;overflow:hidden;position:relative;');
  clip.append(mk('button', 'Bị cắt', 'position:absolute;left:100px;top:4px;height:32px;', 'btn'));
  wrap.append(clip);
  // unexpected-hscroll: vùng cuộn ngang có nội dung rộng hơn
  const sc = mk('div', '', 'width:120px;overflow-x:auto;white-space:nowrap;');
  sc.append(mk('span', 'nội dung rất rộng nội dung rất rộng', 'display:inline-block;width:400px;'));
  wrap.append(sc);
  // control-height (28px), radius-off-scale (9px), font-off-scale (14px)
  wrap.append(
    mk(
      'button',
      'Lệch thang',
      'height:28px;border-radius:9px;font-size:14px;background:#ddd;',
      'btn',
    ),
  );
  // offscreen: nút nằm ngoài viewport bên trái
  wrap.append(
    mk('button', 'Ngoài màn hình', 'position:fixed;left:-300px;top:600px;height:32px;', 'btn'),
  );
  document.getElementById('root')!.append(wrap);
}

/** Hộp thoại giả có một nút nằm ngoài khung. */
function plantedDialog(): void {
  const dlg = document.createElement('div');
  dlg.className = 'dlg';
  dlg.setAttribute('role', 'dialog');
  dlg.style.cssText =
    'position:fixed;left:400px;top:300px;width:300px;height:200px;background:#fff;';
  const out = document.createElement('button');
  out.className = 'btn';
  out.textContent = 'Ra khỏi hộp';
  out.style.cssText = 'position:absolute;left:280px;top:20px;height:32px;';
  dlg.append(out);
  document.body.append(dlg);
}

test.describe('UI audit rules (selftest)', () => {
  test.setTimeout(120_000);
  let l: Launched;

  test.beforeAll(async () => {
    l = await launchApp({
      args: ['--force-device-scale-factor=1'],
      env: { CHEF_CORE_CMD: realCoreCmd },
    });
    await stubNativeDialogs(l.app);
    await l.page.setViewportSize({ width: 1280, height: 820 });
    await l.page.getByRole('heading', { name: 'Quy trình mẫu' }).waitFor({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await l?.app.close().catch(() => undefined);
    removeTempDirs();
  });

  test('each planted defect is caught by its rule', async () => {
    await l.page.evaluate(planted);
    const res: AuditResult = await l.page.evaluate(auditInPage, AUDIT_CFG);
    const rules = new Set(res.groups.map((g) => g.rule));
    for (const rule of [
      'label-overflow',
      'text-overflow',
      'text-truncated',
      'control-clipped',
      'unexpected-hscroll',
      'control-height',
      'radius-off-scale',
      'font-off-scale',
      'offscreen',
    ]) {
      expect(rules, `luật ${rule} phải bắt được lỗi cài sẵn`).toContain(rule);
    }
    // Nút tràn chữ chỉ báo một lần (label-overflow), không báo thêm text-overflow.
    const btnTexts = res.groups
      .filter((g) => g.rule === 'text-overflow' && g.elements[0]?.path.endsWith('button.btn'))
      .map((g) => g.count);
    expect(btnTexts, 'nút không báo trùng text-overflow').toEqual([]);
  });

  test('a button outside the dialog is caught by outside-dialog', async () => {
    await l.page.evaluate(() => document.getElementById('selftest')?.remove());
    await l.page.evaluate(plantedDialog);
    // Hoạt ảnh dialog-in làm hộp thoại scale 0.985: prepare() tắt nó như trong bộ đo thật.
    await prepare(l.page);
    const res: AuditResult = await l.page.evaluate(auditInPage, AUDIT_CFG);
    expect(res.groups.map((g) => g.rule)).toContain('outside-dialog');
    expect(res.groups.find((g) => g.rule === 'outside-dialog')?.elements[0]?.text).toBe(
      'Ra khỏi hộp',
    );
  });
});
