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
  /** File CSS định nghĩa các class của phần tử (gắn sau khi chạy, xem uiAudit.ts). */
  cssHits?: string[];
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
    // Chữ thu nhỏ trong ảnh xem trước: cỡ tỉ lệ theo trang, không phải chữ giao diện.
    {
      rule: 'font-off-scale',
      within: '.ov-band',
      reason: 'chữ thu nhỏ theo tỉ lệ trang trong ảnh xem trước',
    },
    {
      rule: 'font-off-scale',
      within: '.ov-page',
      reason: 'chữ thu nhỏ theo tỉ lệ trang trong ảnh xem trước',
    },
    {
      rule: 'font-off-scale',
      within: '.ov-number',
      reason: 'số trang trong ảnh xem trước theo tỉ lệ trang',
    },
    // Chân hộp và thanh công cụ: nhóm trái và nhóm phải cách nhau bằng khoảng đẩy (spacer) có chủ ý.
    {
      rule: 'gap-uneven',
      within: '.dlg__footer',
      reason: 'chân hộp: nhóm trái và nhóm phải cách nhau bằng khoảng đẩy',
    },
    {
      rule: 'gap-uneven',
      within: '.workflow-toolbar',
      reason: 'thanh công cụ: nhóm nút bên trái, chọn mẫu bên phải',
    },
    // Nhóm zoom là một điều khiển (khung 32px): nút bên trong 26px và khe nhỏ là có chủ ý.
    { rule: 'row-mixed-height', within: '.zoom', reason: 'nhóm zoom: nút trong 26px, khung 32px' },
    { rule: 'controls-touching', within: '.zoom', reason: 'nhóm zoom: các nút dính nhau có chủ ý' },
    // Kích thước đã chốt trong kế hoạch mục 1.7 (thanh trạng thái, tab tài liệu, tab bên, chip).
    // Các mục khác là quyết định thẩm mỹ, ghi vào danh sách D trong UI_AUDIT.md, không đưa vào đây.
    {
      rule: 'control-height',
      within: '.status',
      values: [20, 22],
      reason: 'thanh trạng thái 22px (20px ở ô số trang), kế hoạch mục 1.7',
    },
    {
      rule: 'control-height',
      within: '.doctabs',
      values: [20],
      reason: 'nút đóng tab tài liệu 20px, mục 1.7',
    },
    {
      rule: 'control-height',
      within: '.sidenav__tab',
      values: [24],
      reason: 'tab bên 24px, mục 1.7',
    },
    {
      rule: 'control-height',
      within: '.split__var',
      values: [20, 24],
      reason: 'chip biến 20/24px, mục 1.7 (chờ duyệt chip-h)',
    },
    {
      rule: 'control-height',
      within: '.scan-preview__page',
      values: [20, 24],
      reason: 'chip trang 20/24px, mục 1.7 (chờ duyệt chip-h)',
    },
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
  type Ctl = {
    el: Element;
    r: { x: number; y: number; w: number; h: number };
    top: number;
    bottom: number;
    left: number;
    right: number;
    h: number;
    cy: number;
  };
  const ctrls: Ctl[] = [];

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
  // Ẩn kiểu clip (sr-only, nhãn icon ở cửa sổ hẹp): chữ không hiển thị, không đo tràn.
  const isClipped = (el: Element | null): boolean => {
    if (!el) return false;
    const c = cs(el);
    return c.clip !== 'auto' && c.clip !== '' && c.position === 'absolute';
  };
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
    // ALLOW có values: so với số đầu tiên trong giá trị đo (ví dụ "28px" -> 28).
    const num = parseFloat((measured.match(/-?\d+(?:\.\d+)?/) ?? ['NaN'])[0] ?? 'NaN');
    if (
      cfg.allow.some(
        (a) =>
          a.rule === rule &&
          el.closest(a.within) !== null &&
          (!a.values || a.values.some((v) => Math.abs(v - num) <= 0.5)),
      )
    ) {
      return;
    }
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
      // Điều khiển định vị tuyệt đối (ví dụ nút đóng tab) nằm ngoài layout: không xét quan hệ hàng/khe.
      const positioned = ['absolute', 'fixed'].includes(s.position);
      if (!positioned) {
        ctrls.push({
          el,
          r,
          top: r.y,
          bottom: r.y + r.h,
          left: r.x,
          right: r.x + r.w,
          h: r.h,
          cy: r.y + r.h / 2,
        });
      }
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
    if (
      hasOwnText(el) &&
      !isField &&
      s.display !== 'inline' &&
      el.clientWidth > 0 &&
      !isClipped(el)
    ) {
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
          if (!(node.textContent ?? '').trim() || isClipped(node.parentElement)) continue;
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

    // content-off-center: nội dung trong nút không nằm giữa khung (lỗi dấu tích checkbox).
    // Nút icon: tâm svg so với tâm nút (svg, không đo path, vì Lucide lệch có chủ ý vài phần nghìn).
    // Nút chữ canh giữa: tâm vùng chữ + icon so với tâm vùng nội dung (sai số 1px).
    if (isControl && r.h <= 48) {
      const hasText = (el.textContent ?? '').trim() !== '';
      // Icon Lucide có aria-hidden: không dùng shown() ở đây, chỉ cần có kích thước.
      const kids = Array.from(el.children).filter((k) => {
        const kr = rectOf(k);
        return kr.w > 0 && kr.h > 0 && cs(k).display !== 'none' && cs(k).visibility !== 'hidden';
      });
      // Select và combobox có chevron ở mép phải có chủ ý: không đo nhánh icon cho chúng.
      const isSelect = el.matches('[role=combobox],.select-trigger,.segmented');
      if (!hasText && kids.length === 1 && !isSelect) {
        const child = kids[0];
        if (child) {
          const svgChild =
            child.tagName.toLowerCase() === 'svg' ? child : child.querySelector(':scope > svg');
          const inner = svgChild ?? child;
          const ir = rectOf(inner);
          const dx = ir.x + ir.w / 2 - (r.x + r.w / 2);
          const dy = ir.y + ir.h / 2 - (r.y + r.h / 2);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            add(
              'content-off-center',
              'error',
              el,
              r,
              `lệch ${r1(dx)}×${r1(dy)}px`,
              'tâm icon trùng tâm nút (±0.5px)',
              'icon hoặc dấu trong nút không nằm giữa',
              'bỏ padding mặc định của button; icon là flex, svg display:block',
            );
          }
        }
      } else if (
        hasText &&
        s.textAlign === 'center' &&
        // Chỉ khi nội dung được canh giữa: không flex, hoặc flex có justify-content: center.
        (!/flex|grid/.test(s.display) || s.justifyContent === 'center') &&
        (tag === 'button' || el.getAttribute('role') === 'button') &&
        s.textOverflow !== 'ellipsis' &&
        !Array.from(el.querySelectorAll('*')).some((d) => cs(d).textOverflow === 'ellipsis')
      ) {
        let minL = Infinity;
        let maxR = -Infinity;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!(node.textContent ?? '').trim() || isClipped(node.parentElement)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rc of Array.from(range.getClientRects())) {
            minL = Math.min(minL, rc.left);
            maxR = Math.max(maxR, rc.right);
          }
        }
        for (const k of kids) {
          if (k.tagName.toLowerCase() !== 'svg') continue;
          const kr = rectOf(k);
          minL = Math.min(minL, kr.x);
          maxR = Math.max(maxR, kr.x + kr.w);
        }
        if (maxR > -Infinity) {
          const cLeft = r.x + px(s.borderLeftWidth) + px(s.paddingLeft);
          const cRight = r.x + r.w - px(s.borderRightWidth) - px(s.paddingRight);
          const d = (minL + maxR) / 2 - (cLeft + cRight) / 2;
          if (Math.abs(d) > 1 && maxR <= cRight + 1 && minL >= cLeft - 1) {
            add(
              'content-off-center',
              'warn',
              el,
              r,
              `lệch ${r1(d)}px [nội dung ${r1(minL)}–${r1(maxR)}, vùng ${r1(cLeft)}–${r1(cRight)}]`,
              'chữ và icon canh giữa vùng nội dung (±1px)',
              'nội dung nút lệch khỏi giữa',
              'kiểm padding hai bên có bằng nhau',
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

  // ---------- Luật theo quan hệ (A5): hàng, khe, chân hộp thoại ----------
  const half = (v: number): number => Math.round(v * 2) / 2;
  const median = (vals: number[]): number => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  // Giá trị xuất hiện nhiều nhất. Hòa: ưu tiên giá trị nằm trong `prefer` (thang), rồi giá trị nhỏ hơn.
  const mode = (vals: number[], prefer: number[] = []): number => {
    const count = new Map<number, number>();
    for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1);
    const inPrefer = (v: number): boolean => prefer.some((p) => Math.abs(p - v) <= 0.5);
    let best = vals[0] ?? 0;
    let bestN = 0;
    for (const [v, n] of count) {
      const tieWins = n === bestN && inPrefer(v) && !inPrefer(best);
      const tieSmaller = n === bestN && inPrefer(v) === inPrefer(best) && v < best;
      if (n > bestN || tieWins || tieSmaller) {
        best = v;
        bestN = n;
      }
    }
    return best;
  };
  // Hai điều khiển cùng hàng: chồng dọc ≥ 50% chiều cao nhỏ hơn.
  const sameRow = (a: Ctl, b: Ctl): boolean =>
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= 0.5 * Math.min(a.h, b.h);
  // Hai phần tử chung cha trong 4 cấp (gần nhau trong cây DOM).
  const shareAncestor = (a: Element, b: Element): boolean => {
    const up = (start: Element | null): Element[] => {
      const out: Element[] = [];
      let e = start;
      for (let k = 0; e && k <= 4; k += 1) {
        out.push(e);
        e = e.parentElement;
      }
      return out;
    };
    const B = up(b);
    return up(a).some((x) => B.includes(x));
  };

  // Gộp điều khiển thành hàng (union-find). Khe ngang 0..64px, cùng hàng, chung cha gần.
  const parentOf = ctrls.map((_, i) => i);
  const rootOf = (i: number): number => {
    let x = i;
    while (parentOf[x] !== x) x = parentOf[x] ?? x;
    return x;
  };
  for (let i = 0; i < ctrls.length; i += 1) {
    for (let j = i + 1; j < ctrls.length; j += 1) {
      const a = ctrls[i];
      const b = ctrls[j];
      if (!a || !b || !sameRow(a, b) || !shareAncestor(a.el, b.el)) continue;
      const gap = a.right <= b.left ? b.left - a.right : b.right <= a.left ? a.left - b.right : -1;
      if (gap < 0 || gap > 64) continue;
      parentOf[rootOf(i)] = rootOf(j);
      // controls-touching: sát nhau (khe < 4px), trừ trong nhóm segmented (dính liền có chủ ý).
      if (gap < 4 && a.el.closest('.segmented') === null) {
        add(
          'controls-touching',
          'warn',
          a.el,
          a.r,
          `khe ${r1(gap)}px`,
          '≥ 4px',
          'hai điều khiển sát nhau',
          'đặt gap trên khung cha thay vì để sát',
        );
      }
    }
  }

  const rows = new Map<number, Ctl[]>();
  ctrls.forEach((c, i) => {
    const k = rootOf(i);
    rows.set(k, [...(rows.get(k) ?? []), c]);
  });
  for (const row of rows.values()) {
    if (row.length < 2) continue;
    const modeH = mode(
      row.map((c) => half(c.h)),
      cfg.heights,
    );
    const hs = [...new Set(row.map((c) => half(c.h)))];
    // row-mixed-height: điều khiển có chiều cao khác mức chung của hàng.
    if (hs.length > 1) {
      for (const c of row) {
        if (Math.abs(half(c.h) - modeH) > 0.5) {
          add(
            'row-mixed-height',
            'warn',
            c.el,
            c.r,
            `${r1(c.h)}px (hàng ${r1(modeH)}px)`,
            'cùng chiều cao trong hàng',
            'điều khiển cùng hàng khác chiều cao',
            'dùng cùng size (sm/md/lg) cho cả hàng',
          );
        }
      }
    }
    // row-misaligned: cùng chiều cao thì so top/bottom với giá trị phổ biến; khác chiều cao thì so tâm dọc.
    if (hs.length === 1) {
      const mt = mode(row.map((c) => half(c.top)));
      const mb = mode(row.map((c) => half(c.bottom)));
      for (const c of row) {
        const dt = c.top - mt;
        const db = c.bottom - mb;
        if (Math.abs(dt) > 0.5 || Math.abs(db) > 0.5) {
          add(
            'row-misaligned',
            'error',
            c.el,
            c.r,
            `lệch ${r1(dt)}px (top), ${r1(db)}px (bottom)`,
            'top và bottom bằng hàng',
            'điều khiển cùng hàng lệch dọc',
            'align-items: center trên khung cha; bỏ margin tay',
          );
        }
      }
    } else {
      const mc = median(row.map((c) => c.cy));
      for (const c of row) {
        const d = c.cy - mc;
        if (Math.abs(d) > 1) {
          add(
            'row-misaligned',
            'error',
            c.el,
            c.r,
            `tâm lệch ${r1(d)}px`,
            'tâm dọc bằng hàng (±1px)',
            'điều khiển khác chiều cao lệch tâm',
            'align-items: center trên khung cha',
          );
        }
      }
    }
  }

  // gap-uneven, gap-off-scale: theo khung cha có điều khiển.
  const GAP_SCALE = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56];
  const parents = new Set<Element>();
  for (const c of ctrls) if (c.el.parentElement) parents.add(c.el.parentElement);
  for (const P of parents) {
    const kids = Array.from(P.children).filter((k) => shown(k, rectOf(k)));
    const ps = cs(P);
    // gap-off-scale: column-gap/row-gap của flex hoặc grid ngoài thang.
    // Chỉ báo khi khoảng cách thật sự có tác dụng: column-gap ở grid hoặc flex hàng;
    // row-gap ở grid, flex có xuống dòng, hoặc flex cột.
    const isGrid = ps.display.includes('grid');
    const isFlex = ps.display.includes('flex');
    const rowDir = ps.flexDirection.startsWith('row');
    const wraps = ps.flexWrap !== 'nowrap';
    if ((isGrid || isFlex) && kids.length >= 2) {
      const active: [string, string, boolean][] = [
        ['column-gap', ps.columnGap, isGrid || (isFlex && rowDir)],
        ['row-gap', ps.rowGap, isGrid || (isFlex && (!rowDir || wraps))],
      ];
      for (const [name, value, on] of active) {
        const g = parseFloat(value);
        if (on && Number.isFinite(g) && !GAP_SCALE.some((v) => Math.abs(v - g) <= 0.1)) {
          add(
            'gap-off-scale',
            'warn',
            P,
            rectOf(P),
            `${name} ${r1(g)}px`,
            GAP_SCALE.join(', ') + 'px',
            'khoảng cách cha ngoài thang',
            'dùng --space-* thay vì số lẻ',
          );
        }
      }
    }
    // gap-uneven: ≥3 con cùng hàng, toàn điều khiển (bỏ qua nếu có phần tử lạ xen vào).
    const controlish = (k: Element): boolean =>
      k.matches(cfg.controlSelector) || k.querySelector(cfg.controlSelector) !== null;
    if (kids.length < 3 || !kids.every(controlish)) continue;
    const rects = kids.map((k) => ({ el: k, r: rectOf(k) })).sort((a, b) => a.r.x - b.r.x);
    const first = rects[0];
    if (!first) continue;
    const sameLine = rects.every(
      (x) =>
        Math.min(x.r.y + x.r.h, first.r.y + first.r.h) - Math.max(x.r.y, first.r.y) >=
        0.5 * Math.min(x.r.h, first.r.h),
    );
    if (!sameLine) continue;
    const gaps: number[] = [];
    for (let i = 1; i < rects.length; i += 1) {
      const prev = rects[i - 1];
      const cur = rects[i];
      if (!prev || !cur) continue;
      gaps.push(cur.r.x - (prev.r.x + prev.r.w));
    }
    if (gaps.some((g) => g < -0.5)) continue;
    const lo = Math.min(...gaps);
    const hi = Math.max(...gaps);
    if (hi - lo > 1) {
      add(
        'gap-uneven',
        'warn',
        P,
        rectOf(P),
        `khe ${r1(lo)}–${r1(hi)}px`,
        'khe đều (chênh ≤ 1px)',
        'các điều khiển cùng hàng có khe không đều',
        'dùng gap trên khung cha, bỏ margin ở con',
      );
    }
  }

  // Hộp thoại: padding header/body/footer, chân hộp, nút chính.
  if (inDialog) {
    const parts: { name: string; el: Element }[] = [];
    for (const name of ['dlg__header', 'dlg__body', 'dlg__footer']) {
      const el = rootEl.querySelector(`.${name}`);
      if (el) parts.push({ name, el });
    }
    const pads = parts.map((p) => {
      const s = cs(p.el);
      return { name: p.name, l: px(s.paddingLeft), r: px(s.paddingRight) };
    });
    const lefts = new Set(pads.map((p) => p.l));
    const rights = new Set(pads.map((p) => p.r));
    if (pads.length > 1 && (lefts.size > 1 || rights.size > 1)) {
      add(
        'dialog-padding-mismatch',
        'warn',
        rootEl,
        rectOf(rootEl),
        pads.map((p) => `${p.name.replace('dlg__', '')} ${r1(p.l)}/${r1(p.r)}`).join(', '),
        'padding trái/phải như nhau',
        'lề trái/phải của đầu, thân và chân hộp không đều',
        'bỏ ghi đè padding của .dlg__body',
      );
    }
    const footer = rootEl.querySelector<HTMLElement>('.dlg__footer');
    if (footer) {
      const fr = rectOf(footer);
      const fs = cs(footer);
      const fc = ctrls.filter((c) => footer.contains(c.el));
      const lastCtl = fc.reduce<Ctl | null>(
        (a, c) => (a === null || c.right > a.right ? c : a),
        null,
      );
      if (lastCtl) {
        const expectRight = fr.x + fr.w - px(fs.borderRightWidth) - px(fs.paddingRight);
        const off = lastCtl.right - expectRight;
        if (Math.abs(off) > 0.5) {
          add(
            'footer-right-edge',
            'error',
            lastCtl.el,
            lastCtl.r,
            `lệch ${r1(off)}px`,
            'mép phải khớp lề chân',
            'nút cuối của chân không sát mép phải',
            'chân chỉ chứa DialogSpacer và Button',
          );
        }
        const rowsInFooter = new Set(fc.map((c) => half(c.top)));
        if (rowsInFooter.size > 1) {
          add(
            'footer-wrapped',
            'warn',
            footer,
            fr,
            `${rowsInFooter.size} hàng`,
            '1 hàng',
            'chân hộp thoại xuống dòng',
            'thêm flex-wrap và row-gap, hoặc rút gọn nhãn',
          );
        }
        for (const p of fc.filter((c) => c.el.matches('.btn--primary'))) {
          if (p.right < lastCtl.right - 0.5) {
            add(
              'primary-not-last',
              'info',
              p.el,
              p.r,
              'không ngoài cùng',
              'ngoài cùng bên phải',
              'nút chính không ở ngoài cùng bên phải',
              'đưa nút chính ra cuối chân',
            );
          }
        }
      }
      if (footer.scrollWidth > footer.clientWidth + 1) {
        add(
          'footer-overflow',
          'error',
          footer,
          fr,
          `tràn ${Math.round(footer.scrollWidth - footer.clientWidth)}px`,
          'không tràn',
          'chân hộp thoại tràn ngang',
          'rút gọn nhãn nút hoặc cho chân xuống dòng',
        );
      }
    }
  }

  return { groups: Array.from(groups.values()), scanned, controls };
}
