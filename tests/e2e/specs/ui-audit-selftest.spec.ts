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
  // Luật theo quan hệ (A5): hàng lệch dọc, hàng khác chiều cao, khe không đều,
  // hai nút sát nhau, khe ngoài thang.
  const row = (css: string): HTMLElement => {
    const d = document.createElement('div');
    d.style.cssText = `display:flex;align-items:flex-start;${css}`;
    return d;
  };
  const rowA = row('gap:8px;');
  rowA.append(
    mk('button', 'Trên', 'height:32px;width:60px;', 'btn'),
    mk('button', 'Lệch', 'height:32px;width:60px;margin-top:6px;', 'btn'),
  );
  const rowB = row('gap:8px;');
  rowB.append(
    mk('button', 'Cao 28', 'height:28px;width:60px;', 'btn'),
    mk('button', 'Cao 32', 'height:32px;width:60px;', 'btn'),
  );
  const rowC = row('gap:8px;');
  rowC.append(
    mk('button', 'Một', 'height:32px;width:60px;', 'btn'),
    mk('button', 'Hai', 'height:32px;width:60px;margin-left:10px;', 'btn'),
    mk('button', 'Ba', 'height:32px;width:60px;', 'btn'),
  );
  const rowD = row('gap:0;');
  rowD.append(
    mk('button', 'Sát 1', 'height:32px;width:60px;', 'btn'),
    mk('button', 'Sát 2', 'height:32px;width:60px;', 'btn'),
  );
  const rowE = row('column-gap:7px;');
  rowE.append(
    mk('button', 'Thang 1', 'height:32px;width:60px;', 'btn'),
    mk('button', 'Thang 2', 'height:32px;width:60px;', 'btn'),
  );
  wrap.append(rowA, rowB, rowC, rowD, rowE);
  // content-off-center: đúng lỗi dấu tích checkbox (button giữ padding mặc định, svg trong span block)
  const cb = document.createElement('button');
  cb.className = 'btn';
  cb.style.cssText =
    'display:grid;place-items:center;width:16px;height:16px;border:1px solid #888;';
  const cbSpan = document.createElement('span');
  cbSpan.style.display = 'block';
  const cbSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cbSvg.setAttribute('width', '12');
  cbSvg.setAttribute('height', '12');
  cbSvg.setAttribute('viewBox', '0 0 24 24');
  cbSpan.append(cbSvg);
  cb.append(cbSpan);
  // content-off-center (chữ): padding hai bên lệch nên chữ không nằm giữa
  const off = mk(
    'button',
    'Lệch chữ',
    'padding:0 4px 0 24px;text-align:center;height:32px;',
    'btn',
  );
  wrap.append(cb, off);
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

/**
 * Hộp thoại đủ cấu trúc: đầu, thân, chân. Padding thân lệch đầu/chân; nút cuối chân cách mép
 * phải 30px; nút chính đứng đầu chân.
 */
function plantedFooterDialog(): void {
  const mk = (tag: string, text: string, css: string, cls = ''): HTMLElement => {
    const e = document.createElement(tag);
    e.textContent = text;
    e.style.cssText = css;
    if (cls) e.className = cls;
    return e;
  };
  const dlg = document.createElement('div');
  dlg.className = 'dlg';
  dlg.setAttribute('role', 'dialog');
  dlg.style.cssText =
    'position:fixed;left:400px;top:300px;width:400px;height:260px;background:#fff;display:flex;flex-direction:column;';
  dlg.append(
    mk('div', 'Đầu', 'padding:0 24px;height:40px;', 'dlg__header'),
    mk('div', 'Thân', 'padding:0 16px;height:100px;', 'dlg__body'),
  );
  const footer = mk(
    'div',
    '',
    'display:flex;justify-content:flex-end;gap:8px;padding:0 24px;height:48px;',
    'dlg__footer',
  );
  footer.append(
    mk('button', 'Chính', 'height:32px;width:60px;', 'btn btn--primary'),
    mk('button', 'Hủy', 'height:32px;width:60px;', 'btn'),
    mk('button', 'Cuối', 'height:32px;width:60px;margin-right:30px;', 'btn'),
  );
  dlg.append(footer);
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
      'row-misaligned',
      'row-mixed-height',
      'gap-uneven',
      'controls-touching',
      'gap-off-scale',
      'content-off-center',
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

  test('dialog padding, footer edge and primary button rules catch planted defects', async () => {
    await l.page.evaluate(() =>
      document.querySelectorAll('body > .dlg').forEach((e) => e.remove()),
    );
    await l.page.evaluate(plantedFooterDialog);
    await prepare(l.page);
    const res: AuditResult = await l.page.evaluate(auditInPage, AUDIT_CFG);
    const rules = new Set(res.groups.map((g) => g.rule));
    for (const rule of ['dialog-padding-mismatch', 'footer-right-edge', 'primary-not-last']) {
      expect(rules, `luật ${rule} phải bắt được lỗi cài sẵn`).toContain(rule);
    }
  });
});
