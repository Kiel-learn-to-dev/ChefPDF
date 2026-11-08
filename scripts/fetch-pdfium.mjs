// Tải pdfium.dll cho bản native vào apps/native/third_party/pdfium/ (TASKS_RUST R1.28).
// Chạy: node scripts/fetch-pdfium.mjs
// Phiên bản khớp feature pdfium_8125 của pdfium-render 0.9.5. Không dùng DLL của pypdfium2 (build 8076):
// thiếu symbol nên bind thất bại. Thư mục third_party đã nằm trong .gitignore: không commit binary.
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const TAG = 'chromium/8125';
export const ASSET = 'pdfium-win-x64.tgz';
export const OUT_DIR = resolve(here, '../apps/native/third_party/pdfium');

export function assetUrl() {
  return `https://github.com/bblanchon/pdfium-binaries/releases/download/${TAG}/${ASSET}`;
}

export async function main() {
  const dll = join(OUT_DIR, 'pdfium.dll');
  const stamp = join(OUT_DIR, 'VERSION.txt');
  if (existsSync(dll) && existsSync(stamp) && readFileSync(stamp, 'utf8').includes(TAG)) {
    console.log(`đã có ${dll} (${TAG})`);
    return;
  }
  const work = join(tmpdir(), `chef-pdfium-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const tgz = join(work, ASSET);
  const res = await fetch(assetUrl(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`tải ${assetUrl()} lỗi ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  // tar của Windows (bsdtar) nếu có; tar của Git (GNU) hiểu "C:" là host từ xa nên cần --force-local.
  const winTar = 'C:\\Windows\\System32\\tar.exe';
  if (existsSync(winTar)) {
    execFileSync(winTar, ['-xzf', tgz, '-C', work]);
  } else {
    execFileSync('tar', ['--force-local', '-xzf', tgz, '-C', work]);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(dll, readFileSync(join(work, 'bin', 'pdfium.dll')));
  const version = readFileSync(join(work, 'VERSION'), 'utf8');
  writeFileSync(join(OUT_DIR, 'VERSION.txt'), `${TAG}\n${version}`);
  rmSync(work, { recursive: true, force: true });
  console.log(`đã tải pdfium ${TAG} vào ${dll}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
