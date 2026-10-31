/**
 * Launch helpers for the Electron app under test (mock core via CHEF_CORE_CMD).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import type {} from '@chef/contracts'; // declares window.chef

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
export const desktopDir = path.join(repoRoot, 'apps', 'desktop');
export const mockCore = path.join(desktopDir, 'test', 'mock-core.mjs');

/** Path of the Electron binary installed for apps/desktop. */
export const electronBin = createRequire(path.join(desktopDir, 'package.json'))(
  'electron',
) as unknown as string;

/** Chromium's OS sandbox needs unprivileged user namespaces, unavailable on CI Linux / as root. */
export const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];

export function mockCoreCmd(): string {
  return `"${process.execPath}" "${mockCore}"`;
}

const tempDirs: string[] = [];

export function makeUserDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-e2e-'));
  tempDirs.push(dir);
  return dir;
}

/** Removes every directory created by makeUserDataDir (call after the app has exited). */
export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface LaunchOptions {
  userDataDir?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

export function appEnv(
  userDataDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CHEF_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    CHEF_CORE_CMD: mockCoreCmd(),
    CHEF_USER_DATA_DIR: userDataDir,
    ...extra,
  };
}

export async function launchApp(o: LaunchOptions = {}): Promise<Launched> {
  const userDataDir = o.userDataDir ?? makeUserDataDir();
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [desktopDir, ...sandboxArgs, ...(o.args ?? [])],
    env: appEnv(userDataDir, o.env),
    cwd: repoRoot,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.chef === 'object');
  return { app, page, userDataDir };
}

declare global {
  interface Window {
    __chefEvents?: unknown[];
  }
}

/** Starts recording `window.chef.onEvent` events into `window.__chefEvents`. */
export async function recordEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__chefEvents = [];
    window.chef.onEvent((e) => window.__chefEvents!.push(e));
  });
}

export async function events<T = Record<string, unknown>>(page: Page): Promise<T[]> {
  return page.evaluate(() => (window.__chefEvents ?? []) as never);
}
