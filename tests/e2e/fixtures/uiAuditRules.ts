/**
 * Luật đo theo từng phần tử (kế hoạch docs/UI_AUDIT.md mục 2, lượt A4).
 *
 * `auditInPage` chạy trong trang qua page.evaluate: Playwright chỉ gửi phần thân hàm, nên
 * MỌI helper nằm bên trong hàm, và mọi ngưỡng/danh sách đi vào qua tham số `cfg` (JSON).
 * Kết quả đã gộp nhóm theo (luật, tag.class, giá trị đo) để số lượng không tăng theo số trang.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface AllowEntry {
  /** Tên luật, hoặc '*' để bỏ qua cả phần tử và con cháu của nó. */
  rule: string;
  /** Selector cho phần tử chứa (dùng el.closest). */
  within: string;
  /** Chỉ bỏ qua khi giá trị đo nằm trong danh sách này (ví dụ chiều cao 20 hoặc 22). */
  values?: number[];
  /** Bắt buộc: lý do, ghi sau khi đã xem ảnh chụp. */
  reason: string;
}

export interface AuditCfg {
  /** Chiều cao điều khiển hợp lệ theo thang (26, 32, 38). */
  heights: number[];
  /** Chỉ kiểm chiều cao trong khoảng này (ngoài khoảng là thẻ, ô chọn... không phải điều khiển). */
  heightMin: number;
  heightMax: number;
  radii: number[];
  fonts: number[];
  controlSelector: string;
  notControlSelector: string;
  allow: AllowEntry[];
}

export interface ElementInfo {
  path: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  classes: string;
}

export interface AuditGroup {
  rule: string;
  severity: Severity;
  message: string;
  measured: string;
  expected: string;
  hint: string;
  count: number;
  elements: ElementInfo[];
}

export interface AuditResult {
  groups: AuditGroup[];
  /** Số phần tử hiện và đo được (sau khi lọc ẩn, ignore, scale). */
  scanned: number;
  /** Số điều khiển trong số đó. */
  controls: number;
}

/** Thang và danh sách phần tử cố ý bỏ qua. Ngưỡng theo docs/UI_AUDIT.md và tokens.css. */
export const AUDIT_CFG: AuditCfg = {
  heights: [26, 32, 38],
  heightMin: 12,
  heightMax: 48,
  radii: [0, 3, 5, 7, 10, 14],
  fonts: [11, 12, 13, 15, 18, 24, 30],
  controlSelector:
    'button, [role=button], input:not([type=checkbox],[type=radio],[type=range],[type=hidden],[type=file]), [role=combobox], .select-trigger, .segmented',
  notControlSelector:
    '.checkbox, .radio-dot, .switch, .segmented__item, .menu__item, .select-item, .ftab, [role=tab]',
  allow: [
    { rule: '*', within: '.pdfViewer', reason: 'trang PDF do pdf.js vẽ, không đo' },
    { rule: '*', within: '.textLayer', reason: 'lớp chữ của pdf.js' },
    { rule: '*', within: '.annotationLayer', reason: 'lớp chú thích của pdf.js' },
    { rule: '*', within: 'canvas', reason: 'ảnh vẽ, không có CSS điều khiển' },
    { rule: '*', within: 'svg', reason: 'icon SVG và hình vẽ' },
    { rule: '*', within: '.tip', reason: 'tooltip Radix, bật khi hover' },
    { rule: '*', within: '.menu', reason: 'menu ngữ cảnh, hiện khi mở' },
    { rule: '*', within: '.select-content', reason: 'danh sách chọn, hiện khi mở' },
    { rule: '*', within: '[data-audit="ignore"]', reason: 'đánh dấu bỏ qua trong mã' },
    { rule: '*', within: '.capture__tools', reason: 'kế hoạch mục 2: bỏ qua' },
    { rule: '*', within: '.merge__grip', reason: 'tay kéo (drag handle), kích thước theo cử chỉ' },
  ],
};

/**
 * Chạy trong trang. Trả về các nhóm phát hiện của màn hình đang mở (phạm vi `.dlg` nếu có,
 * ngược lại `#root`). Luật A4: control-height, radius-off-scale, font-off-scale, text-overflow,
 * label-overflow, control-clipped, unexpected-hscroll, outside-dialog/offscreen.
 */
export function auditInPage(cfg: AuditCfg): AuditResult {
  type Rect = { x: number; y: number; w: number; h: number };
  // Phạm vi đo: hộp thoại, bảng lệnh (portal ra ngoài #root), hoặc cả #root.
  const rootEl = (document.querySelector('.dlg[role=dialog], .palette') ??
    document.getElementById('root') ??
    document.body) as HTMLElement;
  const inDialog = rootEl.matches('.dlg[role=dialog]');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const groups = new Map<string, AuditGroup>();
  let scanned = 0;
  let controls = 0;

  const cs = (el: Element): CSSStyleDeclaration => getComputedStyle(el);
  const px = (v: string): number => parseFloat(v) || 0;
  const r1 = (v: number): string => (Math.round(v * 10) / 10).toString();
  const rectOf = (el: Element): Rect => {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  };
  const hasOwnText = (el: Element): boolean =>
    Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
  const textOf = (el: Element): string => {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Nút toolbar có chữ nằm trong <span> con: lấy cả chữ con khi không có chữ trực tiếp.
    const deep = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const alt =
      el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
    return (own || deep || alt || '').slice(0, 40);
  };
  const classesOf = (el: Element): string => (el.getAttribute('class') ?? '').slice(0, 120);
  const sigOf = (el: Element): string => {
    const first = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
    return el.tagName.toLowerCase() + (first ? `.${first}` : '');
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    for (let i = 0; e && i < 4; i += 1) {
      const cls = (e.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 2).filter(Boolean);
      parts.unshift(e.tagName.toLowerCase() + (cls.length ? `.${cls.join('.')}` : ''));
      if (e === rootEl) break;
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const alphaOf = (c: string): number => {
    if (!c || c === 'transparent') return 0;
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return 1;
    const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3] ?? '1') : 1;
  };

  // Phần tử bị bỏ qua (luật '*') hoặc có ALLOW cho luật cụ thể.
  const ignored = (el: Element): boolean =>
    cfg.allow.some((a) => a.rule === '*' && el.closest(a.within) !== null);
  const allowed = (rule: string, el: Element, measured: number): boolean =>
    cfg.allow.some(
      (a) =>
        a.rule === rule &&
        el.closest(a.within) !== null &&
        (!a.values || a.values.some((v) => Math.abs(v - measured) <= 0.5)),
    );

  // Transform không phải tịnh tiến (scale, rotate, skew) làm số đo sai: bỏ qua cả con cháu.
  const scaledMemo = new Map<Element, boolean>();
  const isScaled = (el: Element): boolean => {
    const memo = scaledMemo.get(el);
    if (memo !== undefined) return memo;
    let res = false;
    const t = cs(el).transform;
    if (t && t !== 'none') {
      const m = /^matrix\(([^)]+)\)$/.exec(t);
      if (!m) {
        res = true;
      } else {
        const [a = 1, b = 0, c = 0, d = 1] = (m[1] ?? '').split(',').map(Number);
        res =
          Math.abs(a - 1) > 1e-3 ||
          Math.abs(d - 1) > 1e-3 ||
          Math.abs(b) > 1e-3 ||
          Math.abs(c) > 1e-3;
      }
    }
    if (!res && el.parentElement) res = isScaled(el.parentElement);
    scaledMemo.set(el, res);
    return res;
  };

  const shown = (el: Element, r: Rect): boolean => {
    if (r.w < 1 || r.h < 1) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return el.closest('[aria-hidden=true],[inert],[hidden],.sr-only') === null;
  };

  // Ô cuộn gần nhất đang thật sự cuộn: phần tử bên trong nó không đo theo khung cha.
  const scrollAncestor = (el: Element): Element | null => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = cs(e);
      if (
        /auto|scroll/.test(s.overflowX + s.overflowY) &&
        (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
      ) {
        return e;
      }
      if (e === document.body) break;
    }
    return null;
  };

  const add = (
    rule: string,
    severity: Severity,
    el: Element,
    r: Rect,
    measured: string,
    expected: string,
    message: string,
    hint: string,
  ): void => {
    const key = `${rule}|${sigOf(el)}|${measured}`;
    let g = groups.get(key);
    if (!g) {
      g = { rule, severity, message, measured, expected, hint, count: 0, elements: [] };
      groups.set(key, g);
    }
    g.count += 1;
    if (g.elements.length < 5) {
      g.elements.push({
        path: pathOf(el),
        text: textOf(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        classes: classesOf(el),
      });
    }
  };

  const kindOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return 'input';
    if (el.matches('[role=combobox],.select-trigger,.segmented')) return 'select';
    if (el.classList.contains('btn')) return 'btn';
    if (el.classList.contains('icon-btn')) return 'icon-btn';
    return 'raw-button';
  };

  const all = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];
  const dlgRect = inDialog ? rectOf(rootEl) : null;

  for (const el of all) {
    if (ignored(el)) continue;
    const r = rectOf(el);
    if (!shown(el, r) || isScaled(el)) continue;
    scanned += 1;
    const s = cs(el);
    const tag = el.tagName.toLowerCase();
    const isField = tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
    const isControl = el.matches(cfg.controlSelector) && !el.matches(cfg.notControlSelector);

    // control-height: điều khiển cao 12–48px mà không thuộc thang 26/32/38.
    if (isControl) {
      controls += 1;
      const h = Math.round(r.h * 10) / 10;
      if (
        h >= cfg.heightMin &&
        h <= cfg.heightMax &&
        !cfg.heights.some((v) => Math.abs(v - h) <= 0.5)
      ) {
        if (!allowed('control-height', el, h)) {
          const kind = kindOf(el);
          const sev: Severity = kind === 'btn' || kind === 'input' ? 'error' : 'warn';
          add(
            'control-height',
            sev,
            el,
            r,
            `${r1(h)}px`,
            `${cfg.heights.join(', ')}px`,
            `điều khiển ${kind} cao ${r1(h)}px, ngoài thang`,
            'dùng Button/IconButton/TextInput với size, không đặt chiều cao tay',
          );
        }
      }
      // icon-btn không chữ phải vuông.
      if (
        kindOf(el) === 'icon-btn' &&
        (el.textContent ?? '').trim() === '' &&
        Math.abs(r.w - r.h) > 0.5
      ) {
        add(
          'control-height',
          'error',
          el,
          r,
          `${r1(r.w)}×${r1(r.h)}px`,
          'vuông (w = h)',
          'nút chỉ có icon nhưng không vuông',
          'bỏ width/height tay, để IconButton quyết định kích thước',
        );
      }
    }

    // radius-off-scale: chỉ với phần tử có nền, viền hoặc bóng đổ nhìn thấy.
    const hasBox =
      alphaOf(s.backgroundColor) > 0 ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          px(s[`border${side}Width` as 'borderTopWidth']) > 0 &&
          s[`border${side}Style` as 'borderTopStyle'] !== 'none' &&
          alphaOf(s[`border${side}Color` as 'borderTopColor']) > 0,
      ) ||
      s.boxShadow !== 'none';
    if (hasBox) {
      const corners = [
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomRightRadius,
        s.borderBottomLeftRadius,
      ];
      const half = Math.min(r.w, r.h) / 2;
      const bad = new Set<string>();
      for (const v of corners) {
        if (v.endsWith('%')) continue; // ellipse, không phải lỗi thang
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n === 0 || n >= 999) continue;
        if (n >= half - 0.5) continue; // gần như bo tròn hết cạnh (pill, tròn)
        if (cfg.radii.some((rv) => Math.abs(rv - n) <= 0.1)) continue;
        bad.add(`${r1(n)}px`);
      }
      if (bad.size > 0 && !allowed('radius-off-scale', el, 0)) {
        add(
          'radius-off-scale',
          'warn',
          el,
          r,
          [...bad].join(', '),
          `${cfg.radii.join(', ')}px`,
          'bo góc ngoài thang',
          'dùng --radius-xs/sm/md/lg/xl',
        );
      }
    }

    // font-off-scale: chỉ phần tử có chữ riêng (không đo khung bao).
    if (hasOwnText(el) && !isField) {
      const fs = px(s.fontSize);
      if (!cfg.fonts.some((f) => Math.abs(f - fs) <= 0.1) && !allowed('font-off-scale', el, fs)) {
        add(
          'font-off-scale',
          'warn',
          el,
          r,
          `${r1(fs)}px`,
          `${cfg.fonts.join(', ')}px`,
          `cỡ chữ ${r1(fs)}px ngoài thang`,
          'dùng --text-xs … --text-3xl',
        );
      }
    }

    // text-overflow / text-truncated: chữ tràn hoặc bị rút gọn.
    if (hasOwnText(el) && !isField && s.display !== 'inline' && el.clientWidth > 0) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const over = Math.round(el.scrollWidth - el.clientWidth);
        const clipping = /hidden|clip/.test(s.overflowX);
        const ellipsis = s.textOverflow === 'ellipsis';
        if (!clipping) {
          // Nút tràn chữ do label-overflow đo (khỏi báo trùng).
          if (!isControl)
            add(
              'text-overflow',
              'error',
              el,
              r,
              `tràn ${over}px`,
              'không tràn',
              'chữ tràn ra ngoài khung',
              'rút gọn chuỗi i18n hoặc min-width:0 + ellipsis + title',
            );
        } else if (ellipsis) {
          const important =
            tag === 'button' || el.matches('[role=button],label,h1,h2,h3,[class*=title]');
          add(
            'text-truncated',
            important ? 'warn' : 'info',
            el,
            r,
            `rút gọn ${over}px`,
            'không rút gọn',
            'chữ bị rút gọn bằng …',
            'nút, nhãn và tiêu đề nên hiện đủ chữ',
          );
        } else {
          add(
            'text-overflow',
            'error',
            el,
            r,
            `cắt ${over}px`,
            'không cắt',
            'chữ bị cắt mất, không có …',
            'bỏ overflow hidden hoặc thêm ellipsis + title',
          );
        }
      }
    }

    // label-overflow: chữ của nút rộng hơn vùng nội dung (rect trừ viền và padding).
    if (isControl && (tag === 'button' || el.getAttribute('role') === 'button')) {
      const hasEllipsis = Array.from(el.querySelectorAll('*')).some(
        (d) => cs(d).textOverflow === 'ellipsis',
      );
      if (!hasEllipsis && s.textOverflow !== 'ellipsis') {
        let minL = Infinity;
        let maxR = -Infinity;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!(node.textContent ?? '').trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rc of Array.from(range.getClientRects())) {
            minL = Math.min(minL, rc.left);
            maxR = Math.max(maxR, rc.right);
          }
        }
        if (maxR > -Infinity) {
          const cLeft = r.x + px(s.borderLeftWidth) + px(s.paddingLeft);
          const cRight = r.x + r.w - px(s.borderRightWidth) - px(s.paddingRight);
          if (maxR > cRight + 1 || minL < cLeft - 1) {
            add(
              'label-overflow',
              'error',
              el,
              r,
              `chữ ${r1(maxR - minL)}px, vùng ${r1(cRight - cLeft)}px`,
              'chữ nằm gọn trong vùng nội dung',
              'chữ nút tràn ra ngoài vùng nội dung',
              'rộng nút theo nội dung (không đặt width tay) hoặc rút gọn chữ',
            );
          }
        }
      }
    }

    // control-clipped: một tổ tiên overflow hidden/clip cắt điều khiển.
    if (isControl) {
      for (let anc = el.parentElement; anc; anc = anc.parentElement) {
        const as = cs(anc);
        if (/hidden|clip/.test(as.overflowX + as.overflowY)) {
          const b = anc.getBoundingClientRect();
          const cx = b.left + anc.clientLeft;
          const cy = b.top + anc.clientTop;
          const cw = anc.clientWidth;
          const ch = anc.clientHeight;
          if (
            r.x < cx - 0.5 ||
            r.y < cy - 0.5 ||
            r.x + r.w > cx + cw + 0.5 ||
            r.y + r.h > cy + ch + 0.5
          ) {
            add(
              'control-clipped',
              'error',
              el,
              r,
              `cắt bởi ${sigOf(anc)}`,
              'nằm gọn trong khung cha',
              'điều khiển bị khung cha overflow hidden cắt',
              'bỏ overflow hidden hoặc chừa thêm padding cho khung',
            );
            break;
          }
        }
        if (anc === rootEl || anc === document.body) break;
      }
    }

    // unexpected-hscroll: vùng cuộn ngang không mong muốn.
    if (
      /auto|scroll/.test(s.overflowX) &&
      el.scrollWidth > el.clientWidth + 1 &&
      el.clientWidth > 0
    ) {
      add(
        'unexpected-hscroll',
        'error',
        el,
        r,
        `cuộn ngang ${Math.round(el.scrollWidth - el.clientWidth)}px`,
        'không cuộn ngang',
        'vùng cuộn có thanh cuộn ngang ngoài ý muốn',
        'thu hẹp nội dung hoặc cho phép xuống dòng',
      );
    }

    // outside-dialog / offscreen: điều khiển vượt khung hộp thoại hoặc màn hình (trừ trong ô cuộn).
    if (isControl && scrollAncestor(el) === null) {
      if (
        dlgRect &&
        (r.x < dlgRect.x - 0.5 ||
          r.y < dlgRect.y - 0.5 ||
          r.x + r.w > dlgRect.x + dlgRect.w + 0.5 ||
          r.y + r.h > dlgRect.y + dlgRect.h + 0.5)
      ) {
        add(
          'outside-dialog',
          'error',
          el,
          r,
          'vượt khung hộp thoại',
          'nằm trong khung hộp thoại',
          'điều khiển nằm ngoài khung hộp thoại',
          'kiểm tra padding hoặc chiều rộng của nội dung',
        );
      } else if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > vw + 0.5 || r.y + r.h > vh + 0.5) {
        add(
          'offscreen',
          'error',
          el,
          r,
          'ngoài màn hình',
          'trong viewport',
          'điều khiển nằm ngoài màn hình',
          'kiểm tra vị trí tuyệt đối hoặc cuộn',
        );
      }
    }
  }

  return { groups: Array.from(groups.values()), scanned, controls };
}
