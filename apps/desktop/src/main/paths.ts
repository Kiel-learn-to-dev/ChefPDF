import fs from 'node:fs';
import path from 'node:path';

export interface UiLocation {
  root: string;
  index: string;
  fallback: boolean;
}

/**
 * Where the built renderer lives:
 *  - packaged: `<app.asar>/ui/` (electron-builder copies apps/ui/dist there)
 *  - from source: `apps/ui/dist/` (or env CHEF_UI_DIR)
 * When no build exists, the built-in fallback page is served instead.
 */
export function resolveUi(appPath: string, isPackaged: boolean, envUiDir?: string): UiLocation {
  const candidates = isPackaged
    ? [path.join(appPath, 'ui')]
    : [envUiDir ? path.resolve(envUiDir) : '', path.resolve(appPath, '../ui/dist')].filter(Boolean);
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'index.html')))
      return { root, index: 'index.html', fallback: false };
  }
  return { root: path.join(appPath, 'static'), index: 'fallback.html', fallback: true };
}

/** Repository root when running from source (apps/desktop -> ../..). */
export function repoRootFrom(appPath: string): string {
  return path.resolve(appPath, '../..');
}
