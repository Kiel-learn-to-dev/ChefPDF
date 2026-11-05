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
  LibraryItem,
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
import { applyMockOverlay, mockBates, mockPages, type MockOverlay } from './mockOverlay';
import { seamPlan } from '../features/stamps/seamModel';
import { applyMockTextLinksOp, MOCK_TEXT_LINK_OPS } from './mockTextLinks';

/** DEV: the bookmark tree of each mock session (bookmarks.get / set / fromPages / clear). */
const mockBookmarks = new WeakMap<object, unknown[]>();

/** DEV: document Info (doc.setMetadata) and embedded files (doc.attachments.*) of each mock session. */
const mockMeta = new WeakMap<object, Record<string, string>>();
const mockAttachments = new WeakMap<
  object,
  { name: string; size: number; description: string; bytes: Uint8Array }[]
>();

/** DEV: last path segment of a file path (the mock has no path module). */
function mockBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

import {
  applyMockContentEdit,
  applyMockErase,
  applyMockLayerOp,
  mockLayersData,
  mockListObjects,
  mockViewByType,
} from './mockObjects';

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
  signTemplates: [],
  tsaUrls: [],
  overlayPresets: [],
  compressPresets: [],
  userName: '',
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
  /** security.encrypt / decrypt applied at the next save (core: pendingEncryption). */
  pendingEncryption?: boolean;
  /** inspect.removeHidden has run: the mock document has no metadata finding any more. */
  metadataCleaned?: boolean;
  /** Overlays added by Chef PDF (overlay.listOverlays / overlay.remove). */
  overlays?: MockOverlay[];
  /** Signature fields of the mock document (sign.addField, sign.pades). */
  fields?: { fieldName: string; page: number; rect: number[] | null; signed: boolean }[];
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

const OP_IDS: string[] = [
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
  'sign.verify',
  'sign.pades',
  'sign.padesToken',
  'sign.addField',
  'sign.listFields',
  'sign.findAnchors',
  'sign.placeFromAnchor',
  'sign.batch',
  'sign.extractRevision',
  'sign.trustList',
  'sign.trustAdd',
  'sign.trustRemove',
  'image.removeBackground',
  'image.cleanup',
  'image.fromStrokes',
  'image.textSignature',
  'overlay.addText',
  'overlay.addImage',
  'overlay.watermark',
  'overlay.headerFooter',
  'stamp.text',
  'stamp.image',
  'stamp.presets',
  'overlay.pageNumbers',
  'overlay.bates',
  'overlay.qrCode',
  'overlay.barcode',
  'overlay.letterhead',
  'overlay.listOverlays',
  'overlay.remove',
  'security.encrypt',
  'security.decrypt',
  'inspect.hiddenData',
  'inspect.removeHidden',
  'preflight.check',
  'compress.pdf',
  'compress.estimate',
  'compress.fitSize',
  'convert.pdfToImages',
  'convert.imagesToPdf',
  'color.convert',
  'page.replace',
  'page.crop',
  'page.resize',
  'page.findBlank',
  'page.removeBlank',
  'page.split',
  'file.splitSmart',
  'image.separateColors',
  'sign.verifyBatch',
  'doc.setMetadata',
  'doc.attachments.list',
  'doc.attachments.add',
  'doc.attachments.extract',
  'doc.attachments.remove',
  'doc.extractImages',
  'doc.extractText',
  'doc.optimizeWeb',
  'doc.repair',
  'watermark.detect',
  'watermark.remove',
  'content.hitTest',
  'content.removeSimilar',
  'background.detect',
  'background.remove',
  'redact.find',
  'redact.apply',
  'workflow.validate',
  'workflow.run',
  'workflow.samples',
];

/** Same data as core/chef_core/ops/scan_presets.py (scan.presets). */
/** Built-in stamp presets (core resources/stamps.json, first entries). */
const MOCK_STAMP_PRESETS = [
  {
    id: 'approved-vi',
    lang: 'vi',
    title: 'Đã duyệt',
    text: 'ĐÃ DUYỆT',
    color: '#C00000',
    borderWidth: 2,
    bold: true,
    fontSize: 26,
  },
  {
    id: 'checked-vi',
    lang: 'vi',
    title: 'Đã kiểm tra',
    text: 'ĐÃ KIỂM TRA',
    color: '#C00000',
    borderWidth: 2,
    bold: true,
    fontSize: 24,
  },
  {
    id: 'copy-vi',
    lang: 'vi',
    title: 'Bản sao',
    text: 'BẢN SAO',
    color: '#1F4E9A',
    borderWidth: 2,
    bold: true,
    fontSize: 26,
  },
];

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

/** Signing adds a signature to a signed document (several signers, I30). */
const SIGN_ON_SIGNED_OPS: ReadonlySet<OpId> = new Set<OpId>([
  'sign.pades',
  'sign.padesToken',
  'sign.addField',
]);

/** Session ops that do not rewrite the document (allowed on signed documents). */
const READ_ONLY_SESSION_OPS: ReadonlySet<OpId> = new Set<OpId>([
  'content.listObjects',
  'content.viewByType',
  'layers.list',
  'sign.verify',
  'page.extract',
  'file.split',
  'scan.preview',
  'scan.fitSize',
  'overlay.listOverlays',
  'inspect.hiddenData',
  'preflight.check',
  'compress.estimate',
  'compress.fitSize',
  'page.findBlank',
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

/** DEV: page indices of a page-tool scope (all / odd / even / a page list), 0-based. */
function scopeIndices(doc: PDFDocument, scope: string | undefined, pages: number[] | undefined) {
  const all = doc.getPageIndices();
  if (scope === 'pages') return pages ?? [];
  if (scope === 'odd') return all.filter((i) => i % 2 === 0);
  if (scope === 'even') return all.filter((i) => i % 2 === 1);
  return all;
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

/** PDFs of a folder for the mock file picker (batch signing). */
function mockFolderPdfs(absDir: string): string[] {
  return [`${absDir}/hopdong.pdf`, `${absDir}/bien-ban.pdf`, `${absDir}/khoa-mat-khau.pdf`];
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

const MOCK_WORK_DIR = '/mock/cache/sigwork';
/** 1x1 PNG used as the sample "photo" of the mock phone capture. */
const MOCK_PHOTO_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const MOCK_VERIFY_ITEM = {
  fieldName: 'Signature1',
  status: 'valid-with-warnings',
  reasons: ['CERT_UNTRUSTED'],
  summaryVi: 'Chữ ký hợp lệ nhưng có cảnh báo. Chứng thư không thuộc kho tin cậy.',
  summaryEn: 'The signature is valid with warnings. The certificate is not trusted.',
  revisionIndex: 1,
  subFilter: 'adbe.pkcs7.detached',
  level: 'B-B',
  digestAlgorithm: 'sha256',
  signerName: 'Nguyễn Văn An',
  signerCert: MOCK_CERT_INFO,
  signingTime: '2026-10-31T01:02:03+00:00',
  timestampTime: null,
  timestampOk: null,
  coversWholeDocument: true,
  modificationLevel: 'none',
  docMdp: null,
  chain: [
    {
      subject: 'CN=Nguyễn Văn An, O=Công ty Mẫu',
      issuer: 'CN=Viettel-CA',
      notBefore: '2026-01-15T03:00:00+00:00',
      notAfter: '2027-01-15T03:00:00+00:00',
      trusted: false,
    },
  ],
  revocation: [],
};

const MOCK_TRUST_BASE = {
  subject: 'CN=Mock Root',
  issuer: 'CN=Mock Root',
  notAfter: '2040-01-01T00:00:00+00:00',
  fingerprintSha256: '0',
  group: 'vn-public-ca' as const,
  source: 'user' as const,
};

let mockTrust: {
  subject: string;
  issuer: string;
  notAfter: string;
  fingerprintSha256: string;
  group: 'vn-public-ca' | 'vn-gov-ca' | 'user';
  source: 'bundled' | 'user';
}[] = [
  {
    subject: 'CN=Root CA quốc gia (NEAC) - mẫu',
    issuer: 'CN=Root CA quốc gia (NEAC) - mẫu',
    notAfter: '2040-01-01T00:00:00+00:00',
    fingerprintSha256: 'A1'.padEnd(64, '0'),
    group: 'vn-public-ca',
    source: 'bundled',
  },
  {
    subject: 'CN=Root CA chuyên dùng Chính phủ - mẫu',
    issuer: 'CN=Root CA chuyên dùng Chính phủ - mẫu',
    notAfter: '2040-01-01T00:00:00+00:00',
    fingerprintSha256: 'B2'.padEnd(64, '0'),
    group: 'vn-gov-ca',
    source: 'bundled',
  },
];

/** In-memory signature library of the mock (the real one is encrypted on disk). */
const mockLibrary = new Map<string, { item: LibraryItem; bytes: Uint8Array }>();

export function createMockBridge(): ChefBridge {
  const secretStore = new Map<string, string>();
  const files = new Map<string, Uint8Array>();
  const urls = new Map<string, string>();
  const sessions = new Map<string, MockSession>();
  const listeners = new Set<(e: ChefEvent) => void>();
  let counter = 0;
  let captureActive = false;
  let captureSessionId: string | null = null;

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
    ...(s.pendingEncryption ? { pendingEncryption: true } : {}),
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
    if (s.signed && !READ_ONLY_SESSION_OPS.has(opId) && !SIGN_ON_SIGNED_OPS.has(opId)) {
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
      case 'sign.verify': {
        // Mock: documents opened with ?signed report one valid signature (the core checks the real one).
        modified = false;
        r = {
          ...result([]),
          data: { signatures: s.signed ? [MOCK_VERIFY_ITEM] : [] },
        };
        break;
      }
      case 'sign.stampAndSign':
      case 'sign.stampAndSignToken': {
        // Mock: the stamps go on first (same as the core), then the signed field is added.
        const sp = params as {
          stamps: { op: OpId; params: unknown }[];
          sign: { page?: number; rect?: number[]; fieldName?: string; level?: string };
        };
        const changed = new Set<number>();
        for (const step of sp.stamps) {
          const res = await applyMockOverlay(
            step.op,
            step.params,
            doc,
            (path) => getFile(path),
            () => `ov${++counter}`,
          );
          if (res.overlay) s.overlays = [...(s.overlays ?? []), res.overlay];
          res.changed.forEach((i) => changed.add(i));
        }
        const p = sp.sign;
        const fields = s.fields ?? [];
        const fieldName = p.fieldName ?? `Signature${fields.length + 1}`;
        s.fields = [
          ...fields.filter((f) => f.fieldName !== fieldName),
          { fieldName, page: p.page ?? 0, rect: p.rect ?? null, signed: true },
        ];
        s.signed = true;
        r = {
          ...result([...changed]),
          data: { fieldName, level: p.level ?? 'B-B', tsaUrl: null, signer: MOCK_CERT_INFO },
        };
        break;
      }
      case 'sign.pades':
      case 'sign.padesToken': {
        // Mock: adds a signed field; the core writes the real signature.
        const p = params as { page?: number; rect?: number[]; fieldName?: string; level?: string };
        const fields = s.fields ?? [];
        const fieldName = p.fieldName ?? `Signature${fields.length + 1}`;
        s.fields = [
          ...fields.filter((f) => f.fieldName !== fieldName),
          { fieldName, page: p.page ?? 0, rect: p.rect ?? null, signed: true },
        ];
        s.signed = true;
        r = {
          ...result(p.page === undefined ? [] : [p.page]),
          data: { fieldName, level: p.level ?? 'B-B', tsaUrl: null, signer: MOCK_CERT_INFO },
        };
        break;
      }
      case 'sign.addField': {
        const p = params as { page: number; rect: number[]; fieldName?: string };
        const fields = s.fields ?? [];
        const fieldName = p.fieldName ?? `Signature${fields.length + 1}`;
        s.fields = [...fields, { fieldName, page: p.page, rect: p.rect, signed: false }];
        r = { ...result([p.page]), data: { fieldName } };
        break;
      }
      case 'sign.listFields': {
        modified = false;
        r = { ...result([]), data: { fields: s.fields ?? [] } };
        break;
      }
      case 'sign.findAnchors': {
        // Mock: one match near the bottom of the last page for any text.
        modified = false;
        const pages = doc.getPageIndices();
        const last = pages[pages.length - 1] ?? 0;
        r = {
          ...result([]),
          data: {
            matches: [
              { pageIndex: last, rect: [72, 120, 240, 136], contextBefore: '', contextAfter: '' },
            ],
            truncated: false,
          },
        };
        break;
      }
      case 'bookmarks.get': {
        modified = false;
        r = { ...result([]), data: { bookmarks: mockBookmarks.get(s) ?? [] } };
        break;
      }
      case 'bookmarks.set': {
        const list = (params as { bookmarks?: unknown[] }).bookmarks ?? [];
        mockBookmarks.set(s, list);
        r = { ...result([]), data: { count: list.length } };
        break;
      }
      case 'bookmarks.fromPages': {
        const p = params as OpParams['bookmarks.fromPages'];
        const made = mockPages(p, doc.getPageCount()).map((i) => ({
          title: `Trang ${i + 1}`,
          page: i,
        }));
        const kept = p.mode === 'append' ? (mockBookmarks.get(s) ?? []) : [];
        mockBookmarks.set(s, [...kept, ...made]);
        r = { ...result([]), data: { count: made.length } };
        break;
      }
      case 'bookmarks.clear': {
        mockBookmarks.set(s, []);
        r = { ...result([]), data: { count: 0 } };
        break;
      }
      case 'stamp.seam': {
        const res = await applyMockOverlay(
          opId,
          params,
          doc,
          (path) => getFile(path),
          () => `ov${++counter}`,
        );
        if (res.overlay) s.overlays = [...(s.overlays ?? []), res.overlay];
        const p = params as OpParams['stamp.seam'];
        const pages = mockPages(p, doc.getPageCount());
        const strips = seamPlan(pages, p.groupSize ?? 0, p.cutFirstPage ?? true).map((x) => ({
          page: x.page,
          strip: x.strip + 1,
          of: x.of,
        }));
        r = { ...result(res.changed), data: { strips } };
        break;
      }
      case 'overlay.addText':
      case 'overlay.addImage':
      case 'overlay.watermark':
      case 'overlay.headerFooter':
      case 'stamp.text':
      case 'stamp.image':
      case 'stamp.initials':
      case 'overlay.pageNumbers':
      case 'overlay.qrCode':
      case 'overlay.barcode':
      case 'overlay.letterhead': {
        const res = await applyMockOverlay(
          opId,
          params,
          doc,
          (path) => getFile(path),
          () => `ov${++counter}`,
        );
        if (res.overlay) s.overlays = [...(s.overlays ?? []), res.overlay];
        r = result(res.changed);
        break;
      }
      case 'overlay.listOverlays': {
        modified = false;
        r = {
          ...result([]),
          data: {
            overlays: (s.overlays ?? []).map((o) => ({
              id: o.id,
              kind: o.kind,
              group: o.group,
              pages: o.pages,
              label: o.label,
            })),
          },
        };
        break;
      }
      case 'overlay.remove': {
        // Mock: the drawn content stays in the file; the real core rewrites it.
        const p = params as OpParams['overlay.remove'];
        const before = s.overlays ?? [];
        const removed = before.filter(
          (o) =>
            (!p.ids || p.ids.includes(o.id)) &&
            (!p.group || o.group === p.group) &&
            (!p.kind || o.kind === p.kind),
        );
        s.overlays = before.filter((o) => !removed.includes(o));
        modified = false;
        r = {
          ...result([...new Set(removed.flatMap((o) => o.pages))]),
          data: { removedIds: removed.map((o) => o.id) },
        };
        break;
      }
      case 'sign.placeFromAnchor': {
        modified = false;
        const p = params as {
          anchors: { pageIndex: number; rect: number[] }[];
          width: number;
          height: number;
        };
        r = {
          ...result([]),
          data: {
            placements: p.anchors.map((a, i) => ({
              pageIndex: a.pageIndex,
              rect: [a.rect[0]!, a.rect[1]! - 4 - p.height, a.rect[0]! + p.width, a.rect[1]! - 4],
              anchorIndex: i,
            })),
            skipped: 0,
          },
        };
        break;
      }
      case 'inspect.hiddenData': {
        // Mock: one metadata finding until the metadata has been removed.
        modified = false;
        const items = s.metadataCleaned ? [] : [{ where: 'Info', key: 'Author', value: 'Mock' }];
        r = {
          ...result([]),
          data: {
            findings: [
              {
                category: 'metadata',
                severity: 'warn',
                count: items.length,
                items,
                fixAvailable: true,
              },
            ],
          },
        };
        break;
      }
      case 'compress.pdf': {
        // Mock: the bytes are not rewritten; the report has the shape of the core's.
        const before = 2_000_000;
        r = {
          ...result('all'),
          data: {
            bytesBefore: before,
            bytesAfter: Math.round(before * 0.4),
            ratio: 0.4,
            imagesProcessed: 2,
            imagesSkipped: 0,
            skippedReasons: {},
            fontsDropped: 0,
            resourcesDropped: 0,
            warnings: [],
          },
        };
        break;
      }
      case 'compress.estimate': {
        modified = false;
        r = {
          ...result([]),
          data: {
            bytesBefore: 2_000_000,
            bytesAfter: 800_000,
            ratio: 0.4,
            imagesProcessed: 2,
            imagesSkipped: 0,
            skippedReasons: {},
            warnings: [],
          },
        };
        break;
      }
      case 'compress.fitSize': {
        modified = false;
        const p = params as OpParams['compress.fitSize'];
        const reachable = p.targetBytes >= 800_000;
        r = {
          ...result([]),
          data: {
            params: { ...p, preset: 'custom', maxImageDpi: 96, jpegQuality: 55 },
            estimatedBytes: 800_000,
            reachable,
            steps: 3,
          },
        };
        break;
      }
      case 'color.convert': {
        // Mock: the colours are not rewritten; the report has the shape of the core's.
        const p = params as OpParams['color.convert'];
        const selected = p.pages ?? doc.getPageIndices();
        checkPages(doc, selected);
        r = {
          ...result(selected),
          data: { coloursChanged: 3, imagesChanged: 0, pagesChanged: selected.length, kept: {} },
        };
        break;
      }
      case 'page.replace': {
        const p = params as OpParams['page.replace'];
        checkPages(doc, p.pages);
        const src = await loadDoc(getFile(p.path));
        const sources = p.sourcePages ?? src.getPageIndices();
        const at = Math.min(...p.pages);
        for (const i of [...new Set(p.pages)].sort((a, b) => b - a)) doc.removePage(i);
        await copyInto(doc, src, sources, at);
        r = result('all');
        break;
      }
      case 'page.crop': {
        const p = params as OpParams['page.crop'];
        const selected = scopeIndices(doc, p.scope, p.pages);
        checkPages(doc, selected);
        const mm = (v: number) => (v * 72) / 25.4;
        for (const i of selected) {
          const page = doc.getPage(i);
          const { width, height } = page.getSize();
          let box = [0, 0, width, height];
          if (p.margins) {
            box = [
              mm(p.margins.left ?? 0),
              mm(p.margins.bottom ?? 0),
              width - mm(p.margins.right ?? 0),
              height - mm(p.margins.top ?? 0),
            ];
          } else if (p.box) {
            box = p.box;
          }
          page.setCropBox(box[0]!, box[1]!, box[2]! - box[0]!, box[3]! - box[1]!);
        }
        r = result(selected);
        break;
      }
      case 'page.resize': {
        const p = params as OpParams['page.resize'];
        const selected = scopeIndices(doc, p.scope, p.pages);
        checkPages(doc, selected);
        const mmPt = (v: number) => (v * 72) / 25.4;
        const size =
          p.size === 'A3'
            ? [841.89, 1190.55]
            : p.size === 'Letter'
              ? [612, 792]
              : p.size === 'custom'
                ? [mmPt(p.customWidthMm ?? 210), mmPt(p.customHeightMm ?? 297)]
                : [595.28, 841.89];
        for (const i of selected) doc.getPage(i).setSize(size[0]!, size[1]!);
        r = result(selected);
        break;
      }
      case 'page.findBlank': {
        // Mock: no page counts as blank, so the review lists nothing.
        modified = false;
        const p = params as OpParams['page.findBlank'];
        const rows = scopeIndices(doc, p.pages ? 'pages' : 'all', p.pages).map((index) => ({
          index,
          inkRatio: 0.5,
          hasText: true,
          hasAnnotations: false,
          blank: false,
        }));
        r = { ...result([]), data: { pages: rows, candidates: [] } };
        break;
      }
      case 'page.removeBlank': {
        modified = false;
        r = { ...result([]), data: { removed: [] } };
        break;
      }
      case 'page.split': {
        // Mock: the pieces are not built; the page list is only checked.
        const p = params as OpParams['page.split'];
        checkPages(doc, scopeIndices(doc, p.pages ? 'pages' : 'all', p.pages));
        modified = false;
        r = result([]);
        break;
      }
      case 'preflight.check': {
        // Mock: a size check (no limit in the mock) and one metadata warning until it is cleaned.
        modified = false;
        const p = params as OpParams['preflight.check'];
        const bytes = 4096;
        const over = p.maxBytes !== undefined && bytes > p.maxBytes;
        r = {
          ...result([]),
          data: [
            {
              id: 'fileSize',
              status: over ? 'fail' : 'ok',
              titleVi: 'Dung lượng file',
              titleEn: 'File size',
              detail: { bytes, limitBytes: p.maxBytes ?? null },
              fixOp: null,
            },
            {
              id: 'hidden.metadata',
              status: s.metadataCleaned ? 'ok' : 'warn',
              titleVi: 'Metadata còn sót',
              titleEn: 'Leftover metadata',
              detail: {},
              fixOp: s.metadataCleaned
                ? null
                : { op: 'inspect.removeHidden', params: { categories: ['metadata'] } },
            },
          ],
        };
        break;
      }
      case 'inspect.removeHidden': {
        const before = s.metadataCleaned ? 0 : 1;
        s.metadataCleaned = true;
        r = {
          ...result('all'),
          data: {
            removed: { metadata: before },
            before: { metadata: before },
            after: { metadata: 0 },
          },
        };
        break;
      }
      case 'security.encrypt':
      case 'security.decrypt': {
        // Mock: the protection is recorded and applied by the next save (the core rewrites the file).
        s.pendingEncryption = opId === 'security.encrypt';
        modified = false;
        r = result([]);
        break;
      }
      case 'doc.setMetadata': {
        // Mock: the Info values are kept per session, not written into the PDF.
        const p = params as OpParams['doc.setMetadata'];
        const meta: Record<string, string> = p.clear ? {} : { ...(mockMeta.get(s) ?? {}) };
        const std: Record<string, string | undefined> = {
          Title: p.title,
          Author: p.author,
          Subject: p.subject,
          Keywords: p.keywords,
          Creator: p.creator,
          Producer: p.producer,
          CreationDate: p.creationDate,
          ModDate: p.modDate,
        };
        for (const [k, v] of [...Object.entries(std), ...Object.entries(p.custom ?? {})]) {
          if (v === undefined) continue;
          if (v) meta[k] = v;
          else delete meta[k];
        }
        mockMeta.set(s, meta);
        r = { ...result([]), data: { metadata: meta } };
        break;
      }
      case 'doc.attachments.list': {
        modified = false;
        const items = (mockAttachments.get(s) ?? []).map(({ name, size, description }) => ({
          name,
          size,
          description,
        }));
        r = { ...result([]), data: items };
        break;
      }
      case 'doc.attachments.add': {
        const p = params as OpParams['doc.attachments.add'];
        const list = [...(mockAttachments.get(s) ?? [])];
        for (const path of p.paths) {
          const name = mockBaseName(path);
          const bytes = getFile(path);
          const item = { name, size: bytes.length, description: '', bytes };
          const i = list.findIndex((x) => x.name === name);
          if (i < 0) list.push(item);
          else if (p.replace) list[i] = item;
        }
        mockAttachments.set(s, list);
        r = result([]);
        break;
      }
      case 'doc.attachments.extract': {
        const p = params as OpParams['doc.attachments.extract'];
        const list = mockAttachments.get(s) ?? [];
        const names = p.names?.length ? p.names : list.map((x) => x.name);
        const outputs: string[] = [];
        for (const item of list.filter((x) => names.includes(x.name))) {
          const out = `${p.outputDir}/${item.name}`;
          putFile(out, item.bytes);
          outputs.push(out);
        }
        modified = false;
        r = result([], outputs);
        break;
      }
      case 'doc.attachments.remove': {
        const p = params as OpParams['doc.attachments.remove'];
        mockAttachments.set(
          s,
          (mockAttachments.get(s) ?? []).filter((x) => !p.names.includes(x.name)),
        );
        r = result([]);
        break;
      }
      case 'doc.extractImages': {
        const p = params as OpParams['doc.extractImages'];
        const template = p.nameTemplate ?? '{page}_{index}';
        const outputs: string[] = [];
        for (const i of p.pages ?? doc.getPageIndices()) {
          const name = template
            .replace('{name}', 'mock')
            .replace('{page}', String(i + 1))
            .replace('{index}', '1');
          const out = `${p.outputDir}/${name}.png`;
          putFile(out, await placeholderPng('Mock image', 320, 200));
          outputs.push(out);
        }
        modified = false;
        r = result([], outputs);
        break;
      }
      case 'doc.extractText': {
        const p = params as OpParams['doc.extractText'];
        const pages = doc.getPageIndices();
        const text = pages
          .map(
            (i) => (p.pageMarkers ? `--- Trang ${i + 1} ---\n` : '') + `Nội dung trang ${i + 1}\n`,
          )
          .join('');
        putFile(p.outputPath, new TextEncoder().encode(text));
        modified = false;
        r = { ...result([], [p.outputPath]), data: { pages: pages.length, chars: text.length } };
        break;
      }
      case 'watermark.detect': {
        // Mock: one tagged watermark on every page (the detect step changes nothing).
        modified = false;
        const pages = Array.from({ length: doc.getPageCount() }, (_, i) => i);
        const candidates = pages.length
          ? [
              {
                id: 'mock-wm-1',
                kind: 'Tagged watermark',
                tier: 1,
                confidence: 1,
                pages,
                count: pages.length,
                sample: { pageIndex: 0, bbox: [150, 300, 450, 420] },
                description: { vi: 'Watermark gắn nhãn chuẩn', en: 'Tagged watermark' },
                evidence: ['Artifact/Watermark'],
                objectRefs: [],
                annotRefs: [],
                layerIds: [],
                overlayIds: [],
                preview: pages.map((p) => ({ pageIndex: p, bboxes: [[150, 300, 450, 420]] })),
              },
            ]
          : [];
        r = { ...result([]), data: { pageCount: pages.length, candidates } };
        break;
      }
      case 'watermark.remove': {
        const p = params as OpParams['watermark.remove'];
        const ids = p.all ? ['mock-wm-1'] : (p.candidateIds ?? []);
        r = {
          ...result([]),
          data: {
            removedObjects: ids.length,
            removedAnnotations: 0,
            removedOverlays: 0,
            removedLayers: 0,
            candidates: ids,
          },
        };
        break;
      }
      case 'content.hitTest': {
        modified = false;
        const p = params as OpParams['content.hitTest'];
        r = {
          ...result([]),
          data: {
            pageIndex: p.pageIndex,
            object: {
              id: `mock-obj-${p.pageIndex}`,
              pageIndex: p.pageIndex,
              kind: 'image',
              bbox: [100, 100, 220, 220],
            },
            objects: [],
          },
        };
        break;
      }
      case 'content.removeSimilar': {
        const p = params as OpParams['content.removeSimilar'];
        const matches = [0, 1].map((pageIndex) => ({
          id: `mock-sim-${pageIndex}`,
          pageIndex,
          bbox: [100, 100, 220, 220],
        }));
        modified = !(p.dryRun ?? true);
        r = {
          ...result([]),
          data: {
            dryRun: p.dryRun ?? true,
            matches,
            removedObjects: modified ? matches.length : 0,
          },
        };
        break;
      }
      case 'background.detect': {
        modified = false;
        const pages = Array.from({ length: doc.getPageCount() }, (_, i) => i);
        r = {
          ...result([]),
          data: {
            backgrounds: pages.map((pageIndex) => ({
              pageIndex,
              id: `mock-bg-${pageIndex}`,
              kind: 'rectangle',
              bbox: [0, 0, 595, 842],
              coverage: 0.96,
              fill: '#F5F5F5',
            })),
          },
        };
        break;
      }
      case 'background.remove': {
        r = { ...result([]), data: { objects: doc.getPageCount(), mode: 'remove' } };
        break;
      }
      case 'redact.find': {
        // Mock: one CCCD-like number on page 1 for any pattern set that asks for CCCD or text.
        modified = false;
        const p = params as OpParams['redact.find'];
        const asks = p.patterns.some((x) => x.kind === 'cccd' || x.kind === 'literal');
        const matches = asks
          ? [
              {
                id: 'mock-match-1',
                pageIndex: 0,
                pattern: 'cccd',
                text: '012345678901',
                rects: [[72, 100, 220, 114]],
              },
            ]
          : [];
        r = { ...result([]), data: { matches, count: matches.length } };
        break;
      }
      case 'redact.apply': {
        const p = params as OpParams['redact.apply'];
        const rects = p.rects ?? [];
        const pages = [...new Set(rects.map((x) => x.pageIndex))].sort((a, b) => a - b);
        r = {
          ...result([]),
          data: {
            redacted: (p.matchIds?.length ?? 0) + rects.length,
            pages,
            removedAnnotations: 0,
            scrubbed: {},
            removedObjects: 0,
            splitObjects: 0,
            modifiedImages: 0,
            clippedObjects: 0,
            verification: { ok: true, leaks: [] },
          },
        };
        break;
      }
      case 'content.listObjects':
      case 'content.viewByType': {
        const p = params as { pageIndex: number };
        if (p.pageIndex >= doc.getPageCount()) {
          throw new MockRpcError('INVALID_PARAMS', 'PAGE_OUT_OF_RANGE', -32602);
        }
        modified = false;
        r = {
          ...result([]),
          data:
            opId === 'content.listObjects'
              ? mockListObjects(s, p.pageIndex, s.rev)
              : mockViewByType(s, p.pageIndex, s.rev),
        };
        break;
      }
      case 'layers.list': {
        modified = false;
        r = { ...result([]), data: mockLayersData(s) };
        break;
      }
      case 'layers.setVisibility':
      case 'layers.remove':
      case 'layers.flatten': {
        applyMockLayerOp(s, opId, params);
        r = result('all');
        break;
      }
      case 'content.move':
      case 'content.delete':
      case 'content.duplicate':
      case 'content.reorder':
      case 'content.setColor':
      case 'content.setOpacity': {
        r = result(applyMockContentEdit(s, opId, params, s.rev) ?? []);
        break;
      }
      case 'content.replaceImage':
      case 'content.adjustImage': {
        const p = params as { pageIndex: number };
        r = { ...result([p.pageIndex]), data: { pixelSize: [400, 240] } };
        break;
      }
      case 'content.extractImage': {
        const p = params as { outputPath: string };
        putFile(p.outputPath, await placeholderPng('Mock image', 400, 240));
        modified = false;
        r = { ...result([], [p.outputPath]), data: { pixelSize: [400, 240] } };
        break;
      }
      case 'content.eraseRegion': {
        const p = params as Parameters<typeof applyMockErase>[1];
        r = {
          ...result(p.pageIndex !== undefined ? [p.pageIndex] : []),
          data: applyMockErase(s, p),
        };
        break;
      }
      default: {
        if (!MOCK_TEXT_LINK_OPS.has(opId)) {
          throw new MockRpcError('OP_NOT_FOUND', `Unknown op ${opId}`, -32601);
        }
        const out = applyMockTextLinksOp(
          s,
          opId,
          params as Record<string, unknown>,
          doc.getPageCount(),
        );
        modified = out.changed;
        r = { ...result(out.changedPages), data: out.data };
        break;
      }
    }
    if (modified) pushRevision(s, await doc.save());
    return { state: stateOf(s), ...r };
  }

  async function runStandalone(opId: OpId, params: unknown): Promise<OpResult> {
    if (opId === 'workflow.samples') {
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [],
        warnings: [],
        data: {
          samples: [
            {
              id: 'mock-cleanup',
              name: 'Làm sạch tài liệu',
              description: 'Xoay trang rồi nén PDF.',
              workflow: {
                id: 'mock-cleanup',
                name: 'Làm sạch tài liệu',
                version: 1,
                steps: [
                  { op: 'page.rotate', params: { pages: [0], angle: 90 } },
                  { op: 'compress.pdf', params: {} },
                ],
              },
            },
          ],
        },
      };
    }
    if (opId === 'workflow.validate') {
      const workflow = (params as OpParams['workflow.validate']).workflow as {
        id?: string;
        steps?: { op?: string }[];
      };
      const errors = workflow.steps?.length
        ? []
        : [
            {
              kind: 'EMPTY',
              message: 'Quy trình cần có ít nhất một bước.',
              step: null,
              field: 'steps',
            },
          ];
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [],
        warnings: [],
        data: {
          valid: errors.length === 0,
          errors,
          warnings: [],
          steps: [],
          requiredSecrets: [],
          requiredVariables: [],
          workflowId: workflow.id ?? '',
          descriptions: [],
        },
      };
    }
    if (opId === 'workflow.run') {
      const p = params as OpParams['workflow.run'];
      const results = p.files.map((file) => ({
        path: file.path,
        outputPath: null,
        outputs: [],
        plannedOutputs: [],
        status: 'done' as const,
        failedStep: null,
        errorKind: null,
        message: null,
        warnings: [],
        stepResults: [],
        durationMs: 12,
      }));
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [],
        warnings: [],
        data: {
          results,
          summary: { total: results.length, done: results.length, failed: 0, skipped: 0 },
          dryRun: false,
        },
      };
    }
    if (opId === 'file.splitSmart') {
      // Mock: two halves of the document, written as files in the output folder.
      const p = params as OpParams['file.splitSmart'];
      const src = await loadDoc(getFile(p.path));
      const all = src.getPageIndices();
      const half = Math.max(1, Math.floor(all.length / 2));
      const groups = [all.slice(0, half), all.slice(half)].filter((g) => g.length > 0);
      const outputs: string[] = [];
      for (const [k, group] of groups.entries()) {
        const out = await PDFDocument.create();
        await copyInto(out, src, group, 0);
        const file = `${p.outputDir}/${stripExt(basename(p.path))}_${k + 1}.pdf`;
        putFile(file, await out.save());
        outputs.push(file);
      }
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs,
        warnings: [],
        data: { parts: groups.length },
      };
    }
    if (opId === 'stamp.presets') {
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [],
        warnings: [],
        data: { presets: MOCK_STAMP_PRESETS },
      };
    }
    if (opId === 'doc.optimizeWeb') {
      // Mock: the bytes are copied as they are; the size drop is only a placeholder figure.
      const p = params as OpParams['doc.optimizeWeb'];
      const bytes = getFile(p.inputPath);
      putFile(p.outputPath, bytes);
      const afterBytes = Math.floor(bytes.length * 0.8);
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [p.outputPath],
        warnings: [],
        data: { beforeBytes: bytes.length, afterBytes, linearized: true },
      };
    }
    if (opId === 'doc.repair') {
      const p = params as OpParams['doc.repair'];
      const bytes = getFile(p.inputPath);
      const pageCount = (await loadDoc(bytes)).getPageCount();
      putFile(p.outputPath, bytes);
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [p.outputPath],
        warnings: [],
        data: { recovered: true, pageCount, warnings: [] },
      };
    }
    if (opId === 'sign.verifyBatch') {
      // Mock: no signatures are read, so every file is reported as unsigned.
      const p = params as OpParams['sign.verifyBatch'];
      const paths = p.files?.map((f) => f.path) ?? mockFolderPdfs(p.folder ?? '');
      const rows = paths.map((path) => `${mockBaseName(path)},unsigned`);
      putFile(p.reportPath, new TextEncoder().encode(['file,status', ...rows].join('\n') + '\n'));
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [p.reportPath],
        warnings: [],
        data: {
          files: paths.length,
          signatures: 0,
          byStatus: { unsigned: paths.length },
          reportPath: p.reportPath,
        },
      };
    }
    if (opId === 'image.separateColors') {
      // Mock: one placeholder PNG per layer; the last layer matches no pixel.
      const p = params as OpParams['image.separateColors'];
      await sleep(120);
      const names =
        p.mode === 'layers' ? (p.layers ?? []).map((l) => l.name) : ['Con dấu', 'Chữ ký'];
      const layers: { name: string; path: string; pixels: number }[] = [];
      for (let i = 0; i < names.length; i++) {
        const path = `${p.outputDir}/${String(i + 1).padStart(2, '0')}-layer.png`;
        putFile(path, await placeholderPng(names[i]!, 360, 150));
        layers.push({ name: names[i]!, path, pixels: i === names.length - 1 ? 0 : 500 + i });
      }
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: layers.map((l) => l.path),
        warnings: [],
        data: { layers },
      };
    }
    if (opId.startsWith('sign.')) return runSignOp(opId, params);
    if (opId.startsWith('image.')) return runImageOp(opId, params);
    if (opId === 'overlay.bates') return runBatesOp(params as OpParams['overlay.bates']);
    if (opId === 'convert.pdfToImages') {
      // Mock: one placeholder image per run (the core writes one file per page).
      const p = params as OpParams['convert.pdfToImages'];
      const ext = p.format === 'jpeg' ? 'jpg' : p.format;
      const out = `${p.outputDir}/${p.nameTemplate ?? '{name}_{page}'}`
        .replace('{name}', 'mock')
        .replace('{page}', '1');
      const file = `${out}.${ext}`;
      putFile(file, await placeholderPng('Mock image', 612, 792));
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [file],
        warnings: [],
      };
    }
    if (opId === 'convert.imagesToPdf') {
      const p = params as OpParams['convert.imagesToPdf'];
      const out = await PDFDocument.create();
      for (let i = 0; i < p.images.length; i++) out.addPage([612, 792]);
      putFile(p.outputPath, await out.save());
      return {
        state: null as unknown as SessionState,
        changedPages: [],
        outputs: [p.outputPath],
        warnings: [],
      };
    }
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
  async function runSignOp(opId: string, params: unknown): Promise<OpResult> {
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
    if (opId === 'sign.extractRevision') {
      const p = params as OpParams['sign.extractRevision'];
      putFile(p.outputPath, getFile(p.path));
      return { ...done(null), outputs: [p.outputPath] };
    }
    if (opId === 'sign.batch') {
      // Mock: every file is signed except names containing "khoa" (encrypted: PASSWORD_REQUIRED).
      const p = params as {
        files: { path: string }[];
        output?: { mode?: string; suffix?: string; folder?: string };
      };
      const results = p.files.map((f) => {
        const name = f.path.split(/[\\/]/).pop() ?? f.path;
        if (/khoa/i.test(name)) {
          return {
            path: f.path,
            outputPath: null,
            status: 'failed',
            errorKind: 'PASSWORD_REQUIRED',
            message: 'Password required',
            fieldName: null,
            page: null,
            verification: null,
            warnings: [],
          };
        }
        const base = name.replace(/\.pdf$/i, '');
        const dir = p.output?.folder ?? f.path.replace(/[\\/][^\\/]*$/, '');
        const outputPath = `${dir}/${base}${p.output?.suffix ?? '_signed'}.pdf`;
        return {
          path: f.path,
          outputPath,
          status: 'signed',
          errorKind: null,
          message: null,
          fieldName: 'Signature1',
          page: 0,
          verification: { status: 'valid-with-warnings', reasons: ['CERT_UNTRUSTED'] },
          warnings: [],
        };
      });
      const signed = results.filter((x) => x.status === 'signed').length;
      return done({
        results,
        signed,
        failed: results.length - signed,
        skipped: 0,
        openFolder: p.output?.folder ?? null,
        stoppedBy: null,
      });
    }
    if (opId === 'sign.trustList') return done({ entries: mockTrust });
    if (opId === 'sign.trustAdd') {
      const p = params as { path: string; group: string };
      mockTrust.push({
        ...MOCK_TRUST_BASE,
        subject: `CN=${basename(p.path)}`,
        fingerprintSha256: `MOCK${mockTrust.length}`.padEnd(64, '0'),
        group: p.group as 'user',
        source: 'user',
      });
      return done(null);
    }
    if (opId === 'sign.trustRemove') {
      const p = params as { fingerprintSha256: string };
      const entry = mockTrust.find((e) => e.fingerprintSha256 === p.fingerprintSha256);
      if (entry?.source === 'bundled') {
        throw new MockRpcError('INVALID_PARAMS', 'bundled roots cannot be removed', -32602);
      }
      mockTrust = mockTrust.filter((e) => e.fingerprintSha256 !== p.fingerprintSha256);
      return done(null);
    }
    throw new MockRpcError('OP_NOT_FOUND', opId, -32601);
  }

  /** Mock of overlay.bates (standalone, many files). */
  async function runBatesOp(p: OpParams['overlay.bates']): Promise<OpResult> {
    const res = await mockBates(
      p,
      (path) => getFile(path),
      (path, bytes) => putFile(path, bytes),
    );
    return {
      state: null as unknown as SessionState,
      changedPages: [],
      outputs: res.outputs,
      warnings: [],
      data: { files: res.files, nextNumber: res.next },
    };
  }

  /** Mock of the image ops (I19-I21): each writes a placeholder PNG to the output path. */
  async function runImageOp(opId: OpId, params: unknown): Promise<OpResult> {
    const p = params as { inputPath?: string; outputPath: string };
    if (p.inputPath && !files.has(p.inputPath)) {
      throw new MockRpcError('FILE_NOT_FOUND', `File not found: ${p.inputPath}`);
    }
    await sleep(120);
    putFile(p.outputPath, await placeholderPng(opId.replace('image.', ''), 360, 150));
    return {
      state: null as unknown as SessionState,
      changedPages: [],
      outputs: [p.outputPath],
      warnings: [],
    };
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
        return { version: '1.2.0-mock', python: 'n/a' };
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
      case 'recovery.list':
        return [];
      case 'recovery.cleanup':
        return { removed: 0 };
      case 'recovery.discard':
        return null;
      case 'recovery.restore':
        throw new MockRpcError('SESSION_NOT_FOUND', 'No recoverable session in the mock.', -32001);
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
        s.pendingEncryption = false;
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
      async listPdfs(absDir) {
        return mockFolderPdfs(absDir);
      },
      async readText(absPath) {
        return new TextDecoder().decode(getFile(absPath));
      },
      async writeText(absPath, text) {
        putFile(absPath, new TextEncoder().encode(text));
      },
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
      version: '1.2.0-dev',
      platform: navigator.platform.toLowerCase().includes('mac')
        ? 'darwin'
        : navigator.platform.toLowerCase().includes('win')
          ? 'win32'
          : 'linux',
      versions: { electron: 'mock', chrome: 'mock', node: 'mock' },
      async openLogs() {},
      async openDataDir() {},
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
    library: {
      async status() {
        return { encrypted: !new URLSearchParams(location.search).has('nosafe') };
      },
      async list() {
        return [...mockLibrary.values()].map((m) => m.item);
      },
      async add(input) {
        if (mockLibrary.size >= 200) throw new MockRpcError('LIBRARY_FULL', 'full');
        const bytes = input.bytes ?? getFile(input.path!);
        const item = {
          id: `m${(++counter).toString(16).padStart(31, '0')}`,
          name: input.name.trim() || 'Chữ ký',
          kind: input.kind,
          createdAt: new Date().toISOString(),
        };
        mockLibrary.set(item.id, { item, bytes: new Uint8Array(bytes) });
        return item;
      },
      async get(id) {
        const m = mockLibrary.get(id);
        if (!m) throw new MockRpcError('LIBRARY_NOT_FOUND', 'library item not found');
        return m.bytes;
      },
      async rename(id, name) {
        const m = mockLibrary.get(id);
        if (!m) throw new MockRpcError('LIBRARY_NOT_FOUND', 'library item not found');
        m.item = { ...m.item, name: name.trim() };
        return m.item;
      },
      async remove(id) {
        mockLibrary.delete(id);
      },
      async materialize(id) {
        const m = mockLibrary.get(id);
        if (!m) throw new MockRpcError('LIBRARY_NOT_FOUND', 'library item not found');
        const path = `${MOCK_WORK_DIR}/lib-${id}-${++counter}.png`;
        putFile(path, m.bytes);
        return path;
      },
      async release(absPath) {
        files.delete(absPath);
        const old = urls.get(absPath);
        if (old) URL.revokeObjectURL(old);
        urls.delete(absPath);
      },
      async workDir() {
        return MOCK_WORK_DIR;
      },
    },
    // Phone capture (L5): a fake session that "receives" two sample photos (dev / screenshots).
    capture: {
      async start(input) {
        if (captureActive) throw new Error('capture already running');
        captureActive = true;
        captureSessionId = `mock-capture-${Date.now()}-${Math.random()}`;
        const expiresAt = Date.now() + 10 * 60_000;
        emit({ type: 'capture-status', state: 'active', count: 0, expiresAt });
        [0, 1].forEach((index) => {
          setTimeout(
            () => {
              if (!captureActive) return;
              const path = `/mock/cache/capture/mock/${String(index + 1).padStart(3, '0')}.png`;
              putFile(
                path,
                Uint8Array.from(atob(MOCK_PHOTO_PNG), (c) => c.charCodeAt(0)),
              );
              emit({ type: 'capture-image', index, path });
            },
            300 + index * 400,
          );
        });
        return {
          sessionId: captureSessionId,
          url: 'http://192.168.1.20:5000/c/mock',
          qrSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/><rect x="3" y="3" width="8" height="8" fill="#000"/><rect x="18" y="3" width="8" height="8" fill="#000"/><rect x="3" y="18" width="8" height="8" fill="#000"/><text x="2" y="28" font-size="2">${input.purpose}</text></svg>`,
          expiresAt,
          interfaces: [{ name: 'Wi-Fi', address: '192.168.1.20' }],
        };
      },
      async stop(sessionId) {
        if (!captureActive || (sessionId !== undefined && sessionId !== captureSessionId)) return;
        captureActive = false;
        captureSessionId = null;
        emit({ type: 'capture-status', state: 'stopped', count: 2, expiresAt: 0 });
      },
      async status() {
        return captureActive
          ? { state: 'active' as const, count: 2, expiresAt: Date.now() + 600_000 }
          : { state: 'idle' as const, count: 0 };
      },
    },
    convert: {
      async toPdf(request) {
        // Mock: no printing in the browser; reports the output as if it had been written.
        return { outputPath: request.outputPath, sizeBytes: 1024 };
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
      async readImage() {
        // Mock: the clipboard holds a placeholder PNG, kept in the mock file store.
        const path = `mock-clipboard-${++counter}.png`;
        putFile(path, await placeholderPng('Clipboard', 612, 400));
        return path;
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
