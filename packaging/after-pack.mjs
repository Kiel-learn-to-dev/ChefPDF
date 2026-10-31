// electron-builder afterPack hook.
// macOS: there is no Developer ID (personal use), so apply an ad-hoc signature to the .app.
// Without any signature Apple Silicon refuses to launch arm64 code; ad-hoc signing still shows
// the Gatekeeper "unidentified developer" prompt (right-click > Open, or `xattr -cr`).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
}
