// Tải PDFium 8125 cho bản native vào apps/native/third_party/pdfium/ (TASKS_RUST R1.28).
// Chạy: node scripts/fetch-pdfium.mjs
// Windows và macOS arm64 được hỗ trợ. Không dùng DLL của pypdfium2 (build 8076): thiếu symbol.
// Thư mục third_party đã nằm trong .gitignore: không commit binary.
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const TAG = 'chromium/8125';
export const OUT_DIR = resolve(here, '../apps/native/third_party/pdfium');

export function platformAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') {
    return { asset: 'pdfium-win-x64.tgz', binary: 'bin/pdfium.dll', output: 'pdfium.dll' };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { asset: 'pdfium-mac-arm64.tgz', binary: 'lib/libpdfium.dylib', output: 'libpdfium.dylib' };
  }
  throw new Error(`nền tảng PDFium native chưa hỗ trợ: ${platform}/${arch}`);
}

export function assetUrl(platform = process.platform, arch = process.arch) {
  const { asset } = platformAsset(platform, arch);
  return `https://github.com/bblanchon/pdfium-binaries/releases/download/${TAG}/${asset}`;
}

export async function main(platform = process.platform, arch = process.arch) {
  const config = platformAsset(platform, arch);
  const output = join(OUT_DIR, config.output);
  const stamp = join(OUT_DIR, 'VERSION.txt');
  if (
    existsSync(output) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').includes(`${TAG}\n${config.asset}`)
  ) {
    console.log(`đã có ${output} (${TAG})`);
    return;
  }
  const work = join(tmpdir(), `chef-pdfium-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const tgz = join(work, config.asset);
  const url = assetUrl(platform, arch);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`tải ${url} lỗi ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  // tar của Windows (bsdtar) nếu có; tar của Git (GNU) hiểu "C:" là host từ xa nên cần --force-local.
  const winTar = 'C:\\Windows\\System32\\tar.exe';
  if (existsSync(winTar)) {
    execFileSync(winTar, ['-xzf', tgz, '-C', work]);
  } else {
    execFileSync('tar', ['--force-local', '-xzf', tgz, '-C', work]);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(output, readFileSync(join(work, config.binary)));
  const version = readFileSync(join(work, 'VERSION'), 'utf8');
  writeFileSync(stamp, `${TAG}\n${config.asset}\n${version}`);
  rmSync(work, { recursive: true, force: true });
  console.log(`đã tải pdfium ${TAG} vào ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
