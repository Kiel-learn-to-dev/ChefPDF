/**
 * Báo cáo, baseline và biến thể của bộ đo giao diện (docs/UI_AUDIT.md mục 2, lượt A6).
 * - gắn file CSS định nghĩa class cho từng phát hiện, xếp file cần sửa trước (gộp trùng trước khi xếp);
 * - report.md cho người đọc; khung đỏ đánh số trên ảnh chụp (vẽ trước khi chụp, xóa sau);
 * - baseline theo số lượng (màn hình, luật): chỉ fail khi số tăng;
 * - biến thể: mỗi [role=tab] và mỗi .collapsible__trigger đang đóng trong hộp thoại.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { repoRoot } from './app';
import { OUT_DIR, SRC_DIR, type AuditReport, type ScreenResult } from './uiAudit';
import type { AuditGroup } from './uiAuditRules';

export const BASELINE_FILE = path.join(repoRoot, 'tests', 'e2e', 'ui-audit-baseline.json');

/** Hộp thoại thiết bị: có thể chạm USB token hoặc máy quét. Không tạo biến thể (kế hoạch rủi ro 4). */
export const DEVICE_DIALOGS = new Set(['certs', 'tokenWizard', 'scan', 'signDoc', 'batchSign']);

// ---------- CSS ----------

function walkCss(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkCss(p, out);
    else if (ent.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/** class -> các file CSS (đường dẫn trong apps/ui/src) có chọn class đó. */
export function buildCssIndex(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const file of walkCss(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const cls = m[1] ?? '';
      let set = idx.get(cls);
      if (!set) {
        set = new Set();
        idx.set(cls, set);
      }
      set.add(rel);
    }
  }
  return idx;
}

/** Gắn `cssHits` cho từng phần tử: file CSS của ba class đầu tiên. */
export function attachCssHits(screens: ScreenResult[], idx: Map<string, Set<string>>): void {
  for (const s of screens) {
    for (const g of s.findings) {
      for (const e of g.elements) {
        const files = new Set<string>();
        for (const cls of e.classes.split(/\s+/).filter(Boolean).slice(0, 3)) {
          for (const f of idx.get(cls) ?? []) files.add(f);
        }
        e.cssHits = [...files].slice(0, 4);
      }
    }
  }
}

export interface CssRank {
  file: string;
  issues: number;
  rules: string[];
}

/**
 * Xếp file CSS cần sửa trước. Mỗi vấn đề riêng (luật, giá trị đo, phần tử đầu tiên) chỉ tính một
 * lần trên mọi màn hình, nếu không thanh công cụ xuất hiện ở 16 màn hình sẽ chiếm đầu bảng.
 */
export function rankCssFiles(screens: ScreenResult[]): CssRank[] {
  const seen = new Set<string>();
  const agg = new Map<string, { issues: number; rules: Set<string> }>();
  for (const s of screens) {
    for (const g of s.findings) {
      const e = g.elements[0];
      if (!e) continue;
      const key = `${g.rule}|${g.measured}|${e.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const f of e.cssHits ?? []) {
        const a = agg.get(f) ?? { issues: 0, rules: new Set<string>() };
        a.issues += 1;
        a.rules.add(g.rule);
        agg.set(f, a);
      }
    }
  }
  return [...agg.entries()]
    .map(([file, a]) => ({ file, issues: a.issues, rules: [...a.rules] }))
    .sort((x, y) => y.issues - x.issues)
    .slice(0, 20);
}

/** Số vấn đề riêng theo luật (gộp trùng giữa các màn hình). */
function uniqueByRule(screens: ScreenResult[]): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const s of screens) {
    for (const g of s.findings) {
      const key = `${g.rule}|${g.measured}|${g.elements[0]?.path ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.set(g.rule, (out.get(g.rule) ?? 0) + 1);
    }
  }
  return out;
}

// ---------- Báo cáo ----------

export function writeMarkdown(report: AuditReport): void {
  const m = report.meta;
  const lines: string[] = [
    '# Báo cáo đo giao diện Chef PDF',
    '',
    `- Commit: ${m.commit}`,
    `- Thời điểm: ${m.generatedAt}`,
    `- Viewport ${m.viewport.width}×${m.viewport.height}, DPR ${m.dpr}, giao diện ${m.theme}`,
    `- Bản dựng (dist): ${m.staleDist ? '**CŨ, hãy build lại UI**' : 'khớp mã nguồn'}`,
    `- Trạng thái màn hình: ${JSON.stringify(report.summary)}`,
    '',
    '## Theo luật',
    '',
    '| Luật | Mức | Phát hiện | Vấn đề riêng |',
    '|---|---|---:|---:|',
  ];
  const byRule = new Map<string, { sev: Set<string>; count: number }>();
  for (const s of report.screens) {
    for (const g of s.findings) {
      const a = byRule.get(g.rule) ?? { sev: new Set<string>(), count: 0 };
      a.sev.add(g.severity);
      a.count += g.count;
      byRule.set(g.rule, a);
    }
  }
  const uniq = uniqueByRule(report.screens);
  for (const [rule, a] of [...byRule.entries()].sort((x, y) => y[1].count - x[1].count)) {
    lines.push(`| ${rule} | ${[...a.sev].join(', ')} | ${a.count} | ${uniq.get(rule) ?? 0} |`);
  }
  lines.push('', '## 20 file CSS cần sửa trước (vấn đề riêng, đã gộp trùng)', '');
  lines.push('| # | File | Vấn đề riêng | Luật |', '|---:|---|---:|---|');
  rankCssFiles(report.screens).forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.file} | ${r.issues} | ${r.rules.join(', ')} |`);
  });
  lines.push('', '## Theo màn hình', '');
  for (const s of report.screens) {
    lines.push(
      `### ${s.name}`,
      '',
      `${s.status}, quét ${s.scanned}, điều khiển ${s.controls}${s.shot ? `, ảnh ${s.shot}` : ''}`,
      '',
    );
    if (s.findings.length === 0) {
      lines.push('Không có phát hiện.', '');
      continue;
    }
    for (const g of s.findings) {
      const e = g.elements[0];
      const where = e ? `\`${e.path}\`${e.text ? ` "${e.text}"` : ''}` : '';
      const css = (e?.cssHits ?? []).join(', ') || 'không rõ CSS';
      lines.push(
        `- [${g.severity}] **${g.rule}** ×${g.count}: ${g.message} (đo ${g.measured}; mong ${g.expected}). Ví dụ ${where} → ${css}`,
      );
    }
    lines.push('');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'));
}

// ---------- Baseline ----------

export type Counts = Record<string, Record<string, number>>;

/** Số phát hiện theo (màn hình, luật). Màn hình sạch vẫn có mục rỗng. */
export function countsOf(screens: ScreenResult[]): Counts {
  const out: Counts = {};
  for (const s of screens) {
    const m: Record<string, number> = {};
    for (const g of s.findings) m[g.rule] = (m[g.rule] ?? 0) + g.count;
    out[s.name] = m;
  }
  return out;
}

export function readBaseline(): { meta: Record<string, unknown>; counts: Counts } | null {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as {
    meta: Record<string, unknown>;
    counts: Counts;
  };
}

export function writeBaseline(report: AuditReport, screens: ScreenResult[]): void {
  const body = {
    meta: {
      commit: report.meta.commit,
      generatedAt: report.meta.generatedAt,
      dpr: report.meta.dpr,
      platform: process.platform,
      viewport: report.meta.viewport,
      screens: screens.length,
    },
    counts: countsOf(screens),
  };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(body, null, 2)}\n`);
}

// ---------- Khung đỏ trên ảnh ----------

/** Vẽ khung đỏ đánh số cho mọi phần tử bị báo (tối đa 5 mỗi nhóm). Gọi trước khi chụp. */
export async function drawMarks(page: Page, groups: AuditGroup[]): Promise<void> {
  await page.evaluate((gs) => {
    document.getElementById('ui-audit-marks')?.remove();
    const host = document.createElement('div');
    host.id = 'ui-audit-marks';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    let n = 0;
    for (const g of gs) {
      for (const e of g.elements) {
        n += 1;
        const box = document.createElement('div');
        box.style.cssText = `position:fixed;left:${e.rect.x}px;top:${e.rect.y}px;width:${e.rect.w}px;height:${e.rect.h}px;outline:2px solid #e11d48;`;
        const tag = document.createElement('span');
        tag.textContent = String(n);
        tag.style.cssText = `position:fixed;left:${e.rect.x}px;top:${Math.max(0, e.rect.y - 13)}px;background:#e11d48;color:#fff;font:11px/13px sans-serif;padding:0 3px;border-radius:2px;`;
        host.append(box, tag);
      }
    }
    document.body.append(host);
  }, groups);
}

export async function clearMarks(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('ui-audit-marks')?.remove());
}

// ---------- Biến thể ----------

export interface VariantTarget {
  kind: 'tab' | 'adv';
  /** Chỉ số trong danh sách [role=tab] hoặc .collapsible__trigger của hộp thoại. */
  index: number;
  label: string;
}

/** Liệt kê tab, và các mục "nâng cao" đang đóng, trong hộp thoại đang mở. */
export async function listVariants(page: Page): Promise<VariantTarget[]> {
  return page.evaluate(() => {
    const dlg = document.querySelector('.dlg[role=dialog]');
    const out: { kind: 'tab' | 'adv'; index: number; label: string }[] = [];
    if (!dlg) return out;
    Array.from(dlg.querySelectorAll('[role=tab]')).forEach((el, index) => {
      out.push({ kind: 'tab', index, label: (el.textContent ?? '').trim().slice(0, 30) });
    });
    Array.from(dlg.querySelectorAll('.collapsible__trigger')).forEach((el, index) => {
      if (el.getAttribute('aria-expanded') === 'true') return;
      out.push({ kind: 'adv', index, label: (el.textContent ?? '').trim().slice(0, 30) });
    });
    return out;
  });
}
