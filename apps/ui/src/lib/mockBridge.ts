/**
 * DEV ONLY: in-browser stand-in for `window.chef` (preload + core) so the UI can
 * be developed and tested without Electron. Loaded dynamically by bridge.ts only
 * when `window.chef` is missing and the build is DEV or VITE_CHEF_MOCK=1.
 *
 * - Files picked with <input type=file> live in an in-memory virtual FS under /mock/.
 * - Sessions keep revisions in memory; v0.1 ops are simulated with pdf-lib
 *   (devDependency). Bookmarks (merge/split) are not supported by the mock.
 * - Settings are kept in localStorage.
 */
import type {
  ChefBridge,
  ChefEvent,
  DocumentInfo,
  OpDescriptor,
  OpResult,
  RpcError,
  RpcMethod,
  RpcParams,
  RpcResult,
  SessionState,
  Settings,
} from '@chef/contracts';
import { degrees, PDFDocument, PageSizes, EncryptedPDFError } from 'pdf-lib';
import type { OpId, OpParams } from './ops';
import { basename, join, stripExt } from './path';
import { parsePageRanges } from './pageRange';
import { renderName } from '../features/split/nameTemplate';

const SETTINGS_KEY = 'chef-mock-settings';

const defaultSettings: Settings = {
  version: 1,
  language: 'vi',
  theme: 'system',
  defaultSaveDir: null,
  recentFiles: [],
  prefs: {},
  scanPresets: [],
  knownPfxFiles: [],
  lastDriverPath: null,
};

interface MockSession {
  id: string;
  sourcePath: string | null;
  revisions: string[];
  rev: number;
  savedRev: number;
  password?: string;
  /** Simulated with ?signed in the URL (core: PDFs that already carry a signature). */
  signed?: boolean;
}

class MockRpcError extends Error {
  readonly code: number;
  readonly data: { kind: string; detail?: unknown };
  constructor(kind: string, message: string, code = -32000) {
    super(message);
    this.code = code;
    this.data = { kind };
  }
  toJSON(): RpcError {
    return { code: this.code, message: this.message, data: this.data };
  }
}

const OP_IDS: OpId[] = [
  'page.rotate',
  'page.delete',
  'page.duplicate',
  'page.reorder',
  'page.extract',
  'page.insertBlank',
  'page.insertFromFile',
  'page.insertImages',
  'file.merge',
  'file.split',
  'scan.rasterize',
  'scan.preview',
  'scan.fitSize',
  'sign.certInfo',
  'sign.driverScan',
  'sign.listTokens',
  'sign.diagnoseToken',
];

/** Same data as core/chef_core/ops/scan_presets.py (scan.presets). */
const MOCK_SCAN_PRESETS = [
  {
    name: 'email-light',
    labelVi: 'Nhẹ để gửi email',
    labelEn: 'Light for email',
    params: { dpi: 150, color: 'gray', jpegQuality: 60 },
  },
  {
    name: 'archive',
    labelVi: 'Lưu trữ',
    labelEn: 'Archive',
    params: { dpi: 300, color: 'color', jpegQuality: 80 },
  },
  {
    name: 'fax-bw',
    labelVi: 'Fax đen trắng',
    labelEn: 'Black and white fax',
    params: { dpi: 200, color: 'bw', dithering: false, threshold: 140 },
  },
  {
    name: 'photocopy',
    labelVi: 'Bản photocopy',
    labelEn: 'Photocopy',
    params: { dpi: 200, color: 'gray', effectsPreset: 'photocopy' },
  },
  {
    name: 'old-document',
    labelVi: 'Tài liệu cũ',
    labelEn: 'Old document',
    params: { dpi: 200, color: 'color', effectsPreset: 'old-paper' },
  },
];

/** Session ops that do not rewrite the document (allowed on signed documents). */
const READ_ONLY_SESSION_OPS: ReadonlySet<OpId> = new Set<OpId>([
  'page.extract',
  'file.split',
  'scan.preview',
  'scan.fitSize',
]);

/** A small grey PNG with a label, standing in for rendered page images in the mock. */
async function placeholderPng(label: string, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#555';
    ctx.font = '28px sans-serif';
    ctx.fillText(label, 24, 48);
  }
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [head, body = ''] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'application/octet-stream';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Mock PFX password accepted by the mock certInfo op. */
const MOCK_PFX_PASSWORD = 'demo';

const MOCK_CERT_INFO = {
  subjectCommonName: 'Nguyễn Văn An',
  issuerCommonName: 'Viettel-CA',
  subject: 'CN=Nguyễn Văn An, O=Công ty Mẫu, UID=MST:0101234567',
  issuer: 'CN=Viettel-CA, O=Viettel',
  serial: '4F2A9C01',
  notBefore: '2026-01-15T03:00:00+00:00',
  notAfter: '2027-01-15T03:00:00+00:00',
  daysUntilExpiry: 76,
  expired: false,
  expiringSoon: true,
  keyUsage: ['digitalSignature', 'nonRepudiation'],
  keyAlgorithm: 'RSA',
  keySize: 2048,
  fingerprintSha256: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
  identity: {
    taxCode: '0101234567',
    citizenId: null,
    budgetCode: null,
    organization: 'Công ty Mẫu',
    personName: 'Nguyễn Văn An',
  },
};

const MOCK_DRIVERS = [
  {
    ca: 'Viettel-CA',
    caId: 'viettel-ca',
    model: 'V6',
    modelId: 'viettel-v6',
    path: 'C:\\Windows\\System32\\viettel-ca_v6.dll',
    exists: true,
    confidence: 'documented',
    bitness: '64',
  },
  {
    ca: 'VNPT-CA',
    caId: 'vnpt-ca',
    model: 'Driver token v8',
    modelId: 'vnpt-v8',
    path: 'C:\\Windows\\System32\\vnpt-ca_v8.dll',
    exists: false,
    confidence: 'unverified',
    bitness: '64',
  },
];

const MOCK_TOKEN = {
  slotId: 1,
  slotDescription: 'Mock slot',
  label: 'MOCK TOKEN',
  manufacturer: 'Feitian',
  model: 'ePass2003',
  serial: '00112233',
  initialized: true,
  pinState: 'final_try',
  flags: ['CKF_USER_PIN_FINAL_TRY'],
  protectedAuthPath: false,
  unreadableObjects: 0,
  certificates: [{ ckaId: '01', label: 'signer', isCa: false, cert: MOCK_CERT_INFO }],
};

const MOCK_DIAG_STEPS = [
  {
    id: 'driver_found',
    status: 'ok',
    titleVi: 'Tìm thấy driver của token',
    titleEn: 'Token driver found',
    detail: 'viettel-ca_v6.dll',
    fixVi: null,
    fixEn: null,
  },
  {
    id: 'driver_loads',
    status: 'ok',
    titleVi: 'Nạp được driver',
    titleEn: 'Driver loads',
    detail: 'loaded',
    fixVi: null,
    fixEn: null,
  },
  {
    id: 'token_present',
    status: 'ok',
    titleVi: 'Phát hiện token đang cắm',
    titleEn: 'Token detected',
    detail: 'MOCK TOKEN',
    fixVi: null,
    fixEn: null,
  },
  {
    id: 'token_initialized',
    status: 'ok',
    titleVi: 'Token đã được khởi tạo',
    titleEn: 'Token is initialised',
    detail: 'initialised',
    fixVi: null,
    fixEn: null,
  },
  {
    id: 'certificate_readable',
    status: 'ok',
    titleVi: 'Đọc được chứng thư ký',
    titleEn: 'Signing certificate readable',
    detail: '1 signer certificate(s)',
    fixVi: null,
    fixEn: null,
  },
  {
    id: 'certificate_validity',
    status: 'warn',
    titleVi: 'Chứng thư sắp hết hạn',
    titleEn: 'Certificate expires soon',
    detail: 'expires in 76 day(s)',
    fixVi: 'Nên liên hệ CA gia hạn sớm.',
    fixEn: 'Contact the CA to renew it soon.',
  },
  {
    id: 'pin_state',
    status: 'warn',
    titleVi: 'Token chỉ còn 1 lần thử',
    titleEn: 'PIN status: only 1 try left',
    detail: 'flags: CKF_USER_PIN_FINAL_TRY',
    fixVi:
      'Chỉ còn 1 lần thử. Nhập sai có thể khóa token. Nhập đúng PIN ngay, hoặc liên hệ CA trước nếu chưa chắc.',
    fixEn: 'Only 1 try left. A wrong PIN may lock the token.',
  },
  {
    id: 'signing_self_test',
    status: 'skipped',
    titleVi: 'Thử ký',
    titleEn: 'Signing test',
    detail: 'skipped: no PIN',
    fixVi: null,
    fixEn: null,
  },
];

export function createMockBridge(): ChefBridge {
  const secretStore = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const urls = new Map<string, string>();
  const sessions = new Map<string, MockSession>();
  const listeners = new Set<(e: ChefEvent) => void>();
  let counter = 0;

  const emit = (e: ChefEvent) => listeners.forEach((l) => l(e));

  const putFile = (path: string, bytes: Uint8Array) => {
    files.set(path, bytes);
    const old = urls.get(path);
    if (old) URL.revokeObjectURL(old);
    urls.delete(path);
  };

  const getFile = (path: string): Uint8Array => {
    const f = files.get(path);
    if (!f) throw new MockRpcError('FILE_NOT_FOUND', `File not found: ${path}`);
    return f;
  };

  const uniquePath = (dir: string, name: string) => {
    let p = join(dir, name);
    let n = 2;
    while (files.has(p))
      p = join(dir, `${stripExt(name)} (${n++})${name.slice(stripExt(name).length)}`);
    return p;
  };

  const loadSettings = (): Settings => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw
        ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) }
        : { ...defaultSettings };
    } catch {
      return { ...defaultSettings };
    }
  };
  const saveSettings = (s: Settings) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    return s;
  };

  const loadDoc = async (bytes: Uint8Array) => {
    try {
      return await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if (e instanceof EncryptedPDFError) {
        throw new MockRpcError('INVALID_PARAMS', 'The mock bridge cannot edit encrypted PDFs');
      }
      throw new MockRpcError('INVALID_PDF', e instanceof Error ? e.message : String(e));
    }
  };

  const stateOf = (s: MockSession): SessionState => ({
    sessionId: s.id,
    sourcePath: s.sourcePath,
    revisionPath: s.revisions[s.rev]!,
    revision: s.rev,
    canUndo: s.rev > 0,
    canRedo: s.rev < s.revisions.length - 1,
    dirty: s.rev !== s.savedRev,
    signed: !!s.signed,
  });

  const infoOf = async (bytes: Uint8Array, encrypted: boolean): Promise<DocumentInfo> => {
    const header = new TextDecoder().decode(bytes.slice(0, 16));
    const pdfVersion = /%PDF-(\d\.\d)/.exec(header)?.[1] ?? '1.7';
    const doc: PDFDocument | null = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
    }).catch(() => null);
    const metadata: Record<string, string> = {};
    if (doc && !encrypted) {
      const entries: [string, string | undefined][] = [
        ['Title', doc.getTitle()],
        ['Author', doc.getAuthor()],
        ['Subject', doc.getSubject()],
        ['Keywords', doc.getKeywords()],
        ['Creator', doc.getCreator()],
        ['Producer', doc.getProducer()],
        ['CreationDate', doc.getCreationDate()?.toISOString()],
        ['ModDate', doc.getModificationDate()?.toISOString()],
      ];
      for (const [k, v] of entries) if (v) metadata[k] = v;
    }
    const pages =
      doc?.getPages().map((p) => {
        const rotation = p.getRotation().angle % 360;
        const { width, height } = p.getSize();
        return rotation % 180 === 0
          ? { width, height, rotation }
          : { width: height, height: width, rotation };
      }) ?? [];
    return {
      pageCount: pages.length,
      pdfVersion,
      encrypted,
      fileSize: bytes.byteLength,
      metadata,
      pages,
      fonts: [],
      hasSignatures: false,
    };
  };

  const newSessionId = () => `mock-${Date.now().toString(36)}-${++counter}`;

  const pushRevision = (s: MockSession, bytes: Uint8Array) => {
    s.revisions = s.revisions.slice(0, s.rev + 1);
    const path = `/mock/sessions/${s.id}/rev-${String(s.revisions.length).padStart(4, '0')}.pdf`;
    putFile(path, bytes);
    s.revisions.push(path);
    s.rev = s.revisions.length - 1;
    if (s.savedRev > s.rev) s.savedRev = -1;
  };

  const session = (id: string | undefined) => {
    const s = id ? sessions.get(id) : undefined;
    if (!s) throw new MockRpcError('SESSION_NOT_FOUND', `Session not found: ${id}`);
    return s;
  };

  const checkPages = (doc: PDFDocument, pages: number[]) => {
    const n = doc.getPageCount();
    if (pages.length === 0 || pages.some((p) => !Number.isInteger(p) || p < 0 || p >= n)) {
      throw new MockRpcError('INVALID_PARAMS', 'Invalid page indices', -32602);
    }
  };

  const copyInto = async (target: PDFDocument, src: PDFDocument, indices: number[], at: number) => {
    const copied = await target.copyPages(src, indices);
    copied.forEach((p, i) => target.insertPage(at + i, p));
  };

  async function runSessionOp(opId: OpId, params: unknown, s: MockSession): Promise<OpResult> {
    if (s.signed && !READ_ONLY_SESSION_OPS.has(opId)) {
      throw new MockRpcError('BLOCKED_BY_SIGNATURE', 'Document is signed');
    }
    const doc = await loadDoc(getFile(s.revisions[s.rev]!));
    const result = (
      changedPages: OpResult['changedPages'],
      outputs: string[] = [],
      warnings: string[] = [],
    ) => ({
      changedPages,
      outputs,
      warnings,
    });
    let r: Pick<OpResult, 'changedPages' | 'outputs' | 'warnings' | 'data'>;
    let modified = true;
    switch (opId) {
      case 'scan.rasterize': {
        // Mock: the pages keep their vector content; only the warnings of the real conversion.
        const p = params as OpParams['scan.rasterize'];
        const selected = p.pages ?? doc.getPageIndices();
        r = result(
          selected,
          [],
          ['Text will be lost: converted pages become images without text.'],
        );
        break;
      }
      case 'scan.preview': {
        const p = params as OpParams['scan.preview'];
        const selected = p.pages ?? doc.getPageIndices();
        const picks = p.samplePages ?? [selected[0]!, selected[Math.floor(selected.length / 2)]!];
        const samples = [];
        for (const index of [...new Set(picks)].slice(0, 3)) {
          const originalPath = `/mock/sessions/${s.id}/preview/mock-p${index}-original.png`;
          const resultPath = `/mock/sessions/${s.id}/preview/mock-p${index}-result.png`;
          putFile(originalPath, await placeholderPng(`Original ${index + 1}`, 612, 792));
          putFile(resultPath, await placeholderPng(`Scan ${index + 1}`, 612, 792));
          samples.push({
            pageIndex: index,
            originalPath,
            resultPath,
            widthPx: 612,
            heightPx: 792,
            encodedBytes: 120_000,
          });
        }
        modified = false;
        r = {
          ...result([]),
          data: {
            samples,
            estimate: {
              estimatedBytes: selected.length * 120_000,
              estimatedSeconds: Math.round(selected.length * 0.4 * 100) / 100,
              lossWarnings: ['Text will be lost: converted pages become images without text.'],
            },
          },
        };
        break;
      }
      case 'scan.fitSize': {
        const p = params as OpParams['scan.fitSize'];
        const targetBytes = p.targetBytes;
        const base: Record<string, unknown> = { ...p };
        delete base.targetBytes;
        delete base.minDpi;
        delete base.minJpegQuality;
        const dpi = Math.min(p.dpi ?? 200, 150);
        const quality = Math.min(p.jpegQuality ?? 75, 50);
        const estimatedBytes = doc.getPageCount() * 120_000 * (dpi / 200) ** 2;
        modified = false;
        r = {
          ...result([]),
          data: {
            params: { ...base, dpi, jpegQuality: quality },
            estimatedBytes,
            reachable: estimatedBytes <= targetBytes,
            steps: 3,
          },
        };
        break;
      }
      case 'page.rotate': {
        const p = params as OpParams['page.rotate'];
        checkPages(doc, p.pages);
        for (const i of p.pages) {
          const page = doc.getPage(i);
          page.setRotation(degrees((page.getRotation().angle + p.angle) % 360));
        }
        r = result([...p.pages]);
        break;
      }
      case 'page.delete': {
        const p = params as OpParams['page.delete'];
        checkPages(doc, p.pages);
        const unique = [...new Set(p.pages)].sort((a, b) => b - a);
        if (unique.length >= doc.getPageCount()) {
          throw new MockRpcError('INVALID_PARAMS', 'Cannot delete all pages', -32602);
        }
        unique.forEach((i) => doc.removePage(i));
        r = result('all');
        break;
      }
      case 'page.duplicate': {
        const p = params as OpParams['page.duplicate'];
        checkPages(doc, p.pages);
        for (const i of [...p.pages].sort((a, b) => b - a)) await copyInto(doc, doc, [i], i + 1);
        r = result('all');
        break;
      }
      case 'page.reorder': {
        const p = params as OpParams['page.reorder'];
        const n = doc.getPageCount();
        if (
          p.order.length !== n ||
          new Set(p.order).size !== n ||
          p.order.some((v) => v < 0 || v >= n)
        ) {
          throw new MockRpcError('INVALID_PARAMS', 'order must be a permutation', -32602);
        }
        const out = await PDFDocument.create();
        await copyInto(out, doc, p.order, 0);
        pushRevision(s, await out.save());
        return { state: stateOf(s), ...result('all') };
      }
      case 'page.extract': {
        const p = params as OpParams['page.extract'];
        checkPages(doc, p.pages);
        const out = await PDFDocument.create();
        await copyInto(out, doc, p.pages, 0);
        putFile(p.outputPath, await out.save());
        modified = false;
        r = result([], [p.outputPath]);
        break;
      }
      case 'page.insertBlank': {
        const p = params as OpParams['page.insertBlank'];
        const before =
          p.at > 0 ? doc.getPage(Math.min(p.at, doc.getPageCount()) - 1).getSize() : null;
        const size: [number, number] = [
          p.width ?? before?.width ?? PageSizes.A4[0],
          p.height ?? before?.height ?? PageSizes.A4[1],
        ];
        for (let i = 0; i < p.count; i++) doc.insertPage(p.at + i, size);
        r = result('all');
        break;
      }
      case 'page.insertFromFile': {
        const p = params as OpParams['page.insertFromFile'];
        const src = await loadDoc(getFile(p.path));
        const indices = p.pages ?? src.getPageIndices();
        await copyInto(doc, src, indices, p.at);
        r = result('all');
        break;
      }
      case 'page.insertImages': {
        const p = params as OpParams['page.insertImages'];
        let at = p.at;
        for (const img of p.images) {
          const { bytes, mime } =
            'dataUrl' in img
              ? dataUrlToBytes(img.dataUrl)
              : {
                  bytes: getFile(img.path),
                  mime: img.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
                };
          const embedded =
            mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const m = p.margin;
          let pw: number;
          let ph: number;
          if (p.pageSize === 'image') {
            pw = embedded.width + 2 * m;
            ph = embedded.height + 2 * m;
          } else {
            [pw, ph] = p.pageSize === 'a4' ? PageSizes.A4 : PageSizes.Letter;
            if (embedded.width > embedded.height) [pw, ph] = [ph, pw];
          }
          const scale = Math.min((pw - 2 * m) / embedded.width, (ph - 2 * m) / embedded.height);
          const w = embedded.width * scale;
          const h = embedded.height * scale;
          const page = doc.insertPage(at++, [pw, ph]);
          page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
        r = result('all');
        break;
      }
      case 'file.split': {
        const p = params as OpParams['file.split'];
        const n = doc.getPageCount();
        let groups: number[][] = [];
        const warnings: string[] = [];
        if (p.mode === 'ranges') {
          const parsed = parsePageRanges(p.ranges ?? '', n);
          if (!parsed.ok) throw new MockRpcError('INVALID_PARAMS', 'Invalid ranges', -32602);
          groups = parsed.groups.map((g) =>
            Array.from({ length: g.end - g.start + 1 }, (_, i) => g.start - 1 + i),
          );
        } else if (p.mode === 'everyN') {
          const step = Math.max(1, p.n ?? 1);
          for (let i = 0; i < n; i += step)
            groups.push(Array.from({ length: Math.min(step, n - i) }, (_, k) => i + k));
        } else if (p.mode === 'oddEven') {
          groups = [
            doc.getPageIndices().filter((i) => i % 2 === 0),
            doc.getPageIndices().filter((i) => i % 2 === 1),
          ];
          groups = groups.filter((g) => g.length > 0);
        } else if (p.mode === 'maxSize') {
          const avg = getFile(s.revisions[s.rev]!).byteLength / Math.max(1, n);
          const per = Math.max(1, Math.floor((p.maxBytes ?? avg) / avg));
          for (let i = 0; i < n; i += per)
            groups.push(Array.from({ length: Math.min(per, n - i) }, (_, k) => i + k));
          warnings.push('Mock: sizes are estimated.');
        } else {
          groups = [doc.getPageIndices()];
          warnings.push('Mock: bookmarks are not supported; wrote one file.');
        }
        const name = stripExt(basename(s.sourcePath ?? 'document.pdf'));
        const outputs: string[] = [];
        for (const [i, g] of groups.entries()) {
          const out = await PDFDocument.create();
          await copyInto(out, doc, g, 0);
          const fileName = renderName(p.nameTemplate, {
            name,
            index: i + 1,
            total: groups.length,
            start: g[0]! + 1,
            end: g[g.length - 1]! + 1,
          });
          const path = join(p.outputDir, fileName);
          putFile(path, await out.save());
          outputs.push(path);
        }
        modified = false;
        r = result([], outputs, warnings);
        break;
      }
      default:
        throw new MockRpcError('OP_NOT_FOUND', `Unknown op ${opId}`, -32601);
    }
    if (modified) pushRevision(s, await doc.save());
    return { state: stateOf(s), ...r };
  }

  async function runStandalone(opId: OpId, params: unknown): Promise<OpResult> {
    if (opId.startsWith('sign.')) return runSignOp(opId, params);
    if (opId !== 'file.merge')
      throw new MockRpcError('INVALID_PARAMS', 'sessionId is required', -32602);
    const p = params as OpParams['file.merge'];
    const out = await PDFDocument.create();
    for (const input of p.inputs) {
      const src = await loadDoc(getFile(input.path));
      await copyInto(out, src, input.pages ?? src.getPageIndices(), out.getPageCount());
    }
    putFile(p.outputPath, await out.save());
    return {
      // Real core: standalone ops return state: null (contract update pending in this worktree).
      state: null as unknown as SessionState,
      changedPages: [],
      outputs: [p.outputPath],
      warnings: p.bookmarksFromFilenames ? ['Mock: bookmarks are not created.'] : [],
    };
  }

  /** Mock of the certificate and token ops: same data shapes as the core, no real token. */
  async function runSignOp(opId: OpId, params: unknown): Promise<OpResult> {
    const done = (data: unknown, warnings: string[] = []): OpResult => ({
      state: null as unknown as SessionState,
      changedPages: [],
      outputs: [],
      warnings,
      data,
    });
    if (opId === 'sign.certInfo') {
      const p = params as OpParams['sign.certInfo'];
      if (!p.password) throw new MockRpcError('PASSWORD_REQUIRED', 'Password required');
      if (p.password !== MOCK_PFX_PASSWORD)
        throw new MockRpcError('SIGN_BAD_PASSWORD', 'Wrong password of the certificate file');
      return done(MOCK_CERT_INFO);
    }
    if (opId === 'sign.driverScan') {
      const p = params as OpParams['sign.driverScan'];
      const drivers = MOCK_DRIVERS.map((row) => {
        if (!p.probe || !row.exists) return row;
        return {
          ...row,
          probe: { status: 'ok', errorKind: null, reason: null, tokenLabels: ['MOCK TOKEN'] },
        };
      });
      return done({ os: 'windows', drivers });
    }
    if (opId === 'sign.listTokens') {
      return done({
        modulePath: (params as OpParams['sign.listTokens']).modulePath,
        tokens: [MOCK_TOKEN],
      });
    }
    if (opId === 'sign.diagnoseToken') {
      return done({ overall: 'warn', steps: MOCK_DIAG_STEPS });
    }
    throw new MockRpcError('OP_NOT_FOUND', opId, -32601);
  }

  function startJob(opId: OpId, params: unknown, sessionId?: string): { jobId: string } {
    const jobId = `job-${++counter}`;
    void (async () => {
      const total = 3;
      try {
        await sleep(30);
        emit({ type: 'rpc', name: 'job.progress', payload: { jobId, done: 1, total } });
        await sleep(250);
        emit({ type: 'rpc', name: 'job.progress', payload: { jobId, done: 2, total } });
        const result = sessionId
          ? await runSessionOp(opId, params, session(sessionId))
          : await runStandalone(opId, params);
        await sleep(150);
        emit({ type: 'rpc', name: 'job.finished', payload: { jobId, result } });
      } catch (e) {
        const err =
          e instanceof MockRpcError
            ? e.toJSON()
            : { code: -32000, message: String(e), data: { kind: 'INTERNAL' } };
        emit({ type: 'rpc', name: 'job.failed', payload: { jobId, error: err } });
      }
    })();
    return { jobId };
  }

  async function openSession(path: string, password?: string) {
    const bytes = getFile(path);
    let encrypted = false;
    try {
      await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if (!(e instanceof EncryptedPDFError))
        throw new MockRpcError('INVALID_PDF', 'Not a valid PDF');
      encrypted = true;
    }
    if (encrypted) {
      if (!password) throw new MockRpcError('PASSWORD_REQUIRED', 'Password required');
      const { loadPdfData, destroyPdf } = await import('../features/viewer/pdfjs');
      try {
        const d = await loadPdfData(bytes.slice(), { password });
        await destroyPdf(d);
      } catch {
        throw new MockRpcError('PASSWORD_INVALID', 'Wrong password');
      }
    }
    const s: MockSession = {
      id: newSessionId(),
      sourcePath: path,
      revisions: [],
      rev: -1,
      savedRev: 0,
      password,
      signed: new URLSearchParams(location.search).has('signed'),
    };
    // The real core stores an unencrypted working copy; the mock keeps the bytes as is.
    pushRevision(s, bytes);
    s.savedRev = 0;
    sessions.set(s.id, s);
    return { state: stateOf(s), info: await infoOf(bytes, encrypted) };
  }

  async function handle(method: RpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'system.ping':
        return { version: '0.1.0-mock', python: 'n/a' };
      case 'system.shutdown':
        return null;
      case 'ops.list':
        return OP_IDS.map<OpDescriptor>((id) => ({
          id,
          title: id,
          group: id.split('.')[0]!,
          paramsSchema: {},
          destructive: id === 'page.delete' || id === 'scan.rasterize',
          finalizing: false,
          batchable: true,
          standalone: id === 'file.merge',
        }));
      case 'scan.presets':
        return MOCK_SCAN_PRESETS;
      case 'ops.run': {
        const p = params as RpcParams<'ops.run'>;
        if (!OP_IDS.includes(p.opId as OpId))
          throw new MockRpcError('OP_NOT_FOUND', p.opId, -32601);
        if (p.sessionId) session(p.sessionId);
        return startJob(p.opId as OpId, p.params, p.sessionId);
      }
      case 'jobs.cancel':
        return null;
      case 'session.open': {
        const p = params as RpcParams<'session.open'>;
        return openSession(p.path, p.password);
      }
      case 'session.create': {
        const s: MockSession = {
          id: newSessionId(),
          sourcePath: null,
          revisions: [],
          rev: -1,
          savedRev: -1,
        };
        const doc = await PDFDocument.create();
        pushRevision(s, await doc.save());
        sessions.set(s.id, s);
        return { state: stateOf(s), info: await infoOf(getFile(s.revisions[0]!), false) };
      }
      case 'session.close':
        sessions.delete((params as { sessionId: string }).sessionId);
        return null;
      case 'session.state':
        return stateOf(session((params as { sessionId: string }).sessionId));
      case 'session.info': {
        const s = session((params as { sessionId: string }).sessionId);
        return infoOf(getFile(s.revisions[s.rev]!), !!s.password);
      }
      case 'session.undo':
      case 'session.redo': {
        const s = session((params as { sessionId: string }).sessionId);
        if (method === 'session.undo' && s.rev > 0) s.rev--;
        if (method === 'session.redo' && s.rev < s.revisions.length - 1) s.rev++;
        return {
          state: stateOf(s),
          changedPages: 'all',
          warnings: [],
          outputs: [],
        } satisfies OpResult;
      }
      case 'session.save': {
        const p = params as RpcParams<'session.save'>;
        const s = session(p.sessionId);
        const target = p.path ?? s.sourcePath;
        if (!target) throw new MockRpcError('INVALID_PARAMS', 'path is required', -32602);
        putFile(target, getFile(s.revisions[s.rev]!));
        s.sourcePath = target;
        s.savedRev = s.rev;
        return { ...stateOf(s), warnings: [] };
      }
    }
    throw new MockRpcError('OP_NOT_FOUND', `Unknown method ${String(method)}`, -32601);
  }

  const pickFiles = (options?: { multiple?: boolean; filters?: { extensions: string[] }[] }) =>
    new Promise<string[]>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!options?.multiple;
      const exts = options?.filters?.flatMap((f) => f.extensions).filter((e) => e !== '*');
      if (exts?.length) input.accept = exts.map((e) => `.${e}`).join(',');
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('cancel', () => {
        input.remove();
        resolve([]);
      });
      input.addEventListener('change', async () => {
        const picked = [...(input.files ?? [])];
        input.remove();
        const paths: string[] = [];
        for (const f of picked) paths.push(await registerFile(f));
        resolve(paths);
      });
      input.click();
    });

  const bridge: ChefBridge = {
    rpc<M extends RpcMethod>(method: M, params: RpcParams<M>) {
      return handle(method, params) as Promise<RpcResult<M>>;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    files: {
      openDialog: (options) =>
        options?.directory ? Promise.resolve(['/mock/out']) : pickFiles(options),
      pathForFile: () => '',
      async saveDialog(options) {
        const name = basename(options?.defaultPath ?? 'document.pdf') || 'document.pdf';
        return uniquePath('/mock/out', name);
      },
      toUrl(absPath) {
        let url = urls.get(absPath);
        if (!url) {
          const bytes = files.get(absPath);
          if (!bytes) return `chef-file://f/${encodeURIComponent(absPath)}`;
          url = URL.createObjectURL(
            new Blob([bytes.slice().buffer as ArrayBuffer], {
              type: absPath.toLowerCase().endsWith('.png') ? 'image/png' : 'application/pdf',
            }),
          );
          urls.set(absPath, url);
        }
        return url;
      },
      async showInFolder(absPath) {
        // No folders in the browser: download the file instead.
        const a = document.createElement('a');
        a.href = bridge.files.toUrl(absPath);
        a.download = basename(absPath);
        a.click();
      },
    },
    settings: {
      async get() {
        return loadSettings();
      },
      async set(patch) {
        return saveSettings({ ...loadSettings(), ...patch, version: 1 });
      },
      async addRecent(path) {
        const s = loadSettings();
        const recentFiles = [
          { path, name: basename(path), openedAt: new Date().toISOString() },
          ...s.recentFiles.filter((r) => r.path !== path),
        ].slice(0, 20);
        return saveSettings({ ...s, recentFiles });
      },
    },
    app: {
      version: '0.1.0-dev',
      platform: navigator.platform.toLowerCase().includes('mac')
        ? 'darwin'
        : navigator.platform.toLowerCase().includes('win')
          ? 'win32'
          : 'linux',
      async initialFiles() {
        const demo = new URLSearchParams(location.search).get('demo');
        if (demo === null) return [];
        const res = await fetch(new URL('dev/sample.pdf', document.baseURI));
        if (!res.ok) return [];
        const path = '/mock/files/mau-tieng-viet.pdf';
        putFile(path, new Uint8Array(await res.arrayBuffer()));
        return [path];
      },
    },
    secrets: {
      async available() {
        return true;
      },
      async set(key, value) {
        secretStore.set(key, value);
      },
      async get(key) {
        return secretStore.get(key) ?? null;
      },
      async delete(key) {
        secretStore.delete(key);
      },
    },
    clipboard: {
      async writeText(text) {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
      },
      async writeImagePng(dataUrl) {
        try {
          const blob = new Blob([dataUrlToBytes(dataUrl).bytes.slice().buffer as ArrayBuffer], {
            type: 'image/png',
          });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        } catch {
          /* clipboard unavailable in this browser context */
        }
      },
      async readImagePng() {
        try {
          for (const item of await navigator.clipboard.read()) {
            if (item.types.includes('image/png'))
              return blobToDataUrl(await item.getType('image/png'));
          }
        } catch {
          /* permission denied */
        }
        return null;
      },
    },
  };

  // Dev helpers: window.__chefMock.emit({ type: 'core-status', status: 'restarting' })
  const registerFile = async (f: File) => {
    const path = `/mock/files/${f.name}`;
    putFile(path, new Uint8Array(await f.arrayBuffer()));
    return path;
  };
  (window as unknown as { __chefMock: unknown }).__chefMock = { emit, files, registerFile };
  return bridge;
}
