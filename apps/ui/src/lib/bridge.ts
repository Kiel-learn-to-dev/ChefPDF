import type { ChefBridge } from '@chef/contracts';

let current: ChefBridge | null = null;
let mock = false;

/**
 * Resolve the system bridge once at startup. In Electron the preload exposes
 * `window.chef`. In browser dev (and builds with VITE_CHEF_MOCK=1) a mock
 * bridge is loaded instead; it is tree-shaken out of normal production builds.
 */
export async function initBridge(): Promise<ChefBridge> {
  const real = (window as Partial<Window>).chef;
  if (real) {
    current = real;
    return real;
  }
  if (import.meta.env.DEV || import.meta.env.VITE_CHEF_MOCK === '1') {
    const { createMockBridge } = await import('./mockBridge');
    current = createMockBridge();
    mock = true;
    return current;
  }
  throw new Error('window.chef is not available');
}

/** The active bridge (after initBridge). */
export function chef(): ChefBridge {
  if (!current) throw new Error('bridge not initialised');
  return current;
}

export function isMockBridge(): boolean {
  return mock;
}

/**
 * Absolute paths of files dropped on the window, via `chef.files.pathForFile`
 * (Electron webUtils), falling back to the dev mock in the browser.
 */
export async function pathsForDroppedFiles(files: File[]): Promise<string[]> {
  const b = current as (Partial<ChefBridge> & { files?: Partial<ChefBridge['files']> }) | null;
  const out: string[] = [];
  for (const f of files) {
    const viaBridge = b?.files?.pathForFile?.(f);
    const legacy = (f as File & { path?: string }).path;
    if (viaBridge) out.push(viaBridge);
    else if (legacy) out.push(legacy);
    else if (mock) {
      const m = (window as unknown as { __chefMock?: { registerFile(f: File): Promise<string> } })
        .__chefMock;
      if (m) out.push(await m.registerFile(f));
    }
  }
  return out;
}

/** For tests. */
export function setBridgeForTests(b: ChefBridge | null) {
  current = b;
}
