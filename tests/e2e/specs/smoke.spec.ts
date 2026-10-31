import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  appEnv,
  desktopDir,
  electronBin,
  events,
  launchApp,
  makeUserDataDir,
  recordEvents,
  removeTempDirs,
  sandboxArgs,
  type Launched,
} from '../fixtures/app';

let launched: Launched | null = null;

test.afterEach(async () => {
  await launched?.app.close();
  launched = null;
  removeTempDirs();
});

function writePdf(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '%PDF-1.4\n%mock\n' + 'x'.repeat(1000) + '\n%%EOF\n');
}

test('launches securely and exposes the full window.chef bridge', async () => {
  launched = await launchApp();
  const { page } = launched;
  const info = await page.evaluate(() => ({
    keys: Object.keys(window.chef).sort(),
    files: Object.keys(window.chef.files).sort(),
    settings: Object.keys(window.chef.settings).sort(),
    secrets: Object.keys(window.chef.secrets).sort(),
    clipboard: Object.keys(window.chef.clipboard).sort(),
    version: window.chef.app.version,
    platform: window.chef.app.platform,
    hasRequire: typeof (window as unknown as { require?: unknown }).require,
    hasProcess: typeof (window as unknown as { process?: unknown }).process,
    url: location.href,
  }));
  expect(info.keys).toEqual([
    'app',
    'clipboard',
    'files',
    'library',
    'onEvent',
    'rpc',
    'secrets',
    'settings',
  ]);
  expect(info.files).toEqual([
    'listPdfs',
    'openDialog',
    'pathForFile',
    'readText',
    'saveDialog',
    'showInFolder',
    'toUrl',
    'writeText',
  ]);
  expect(info.settings).toEqual(['addRecent', 'get', 'set']);
  expect(info.secrets).toEqual(['available', 'delete', 'get', 'set']);
  expect(await page.evaluate(() => Object.keys(window.chef.library).sort())).toEqual([
    'add',
    'get',
    'list',
    'materialize',
    'release',
    'remove',
    'rename',
    'status',
    'workDir',
  ]);
  expect(info.clipboard).toEqual(['readImagePng', 'writeImagePng', 'writeText']);
  expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.platform).toBe(process.platform);
  expect(info.hasRequire).toBe('undefined');
  expect(info.hasProcess).toBe('undefined');
  expect(info.url.startsWith('chef-app://ui/')).toBe(true);

  const prefs = await launched.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    };
    return wc.getLastWebPreferences();
  });
  expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
});

test('chef.rpc("system.ping") resolves through the mock core', async () => {
  launched = await launchApp();
  const res = await launched.page.evaluate(() => window.chef.rpc('system.ping', {}));
  expect(res).toEqual({ version: '0.0.0-mock', python: 'mock' });
});

test('rpc errors keep code and data.kind; main-only methods are refused', async () => {
  launched = await launchApp();
  const { page } = launched;
  const err = await page.evaluate(() =>
    window.chef.rpc('ops.run', {} as never).then(
      () => null,
      (e: unknown) => e,
    ),
  );
  expect(err).toMatchObject({ code: -32602, data: { kind: 'INVALID_PARAMS' } });
  const shutdown = await page.evaluate(() =>
    window.chef.rpc('system.shutdown', {}).then(
      () => null,
      (e: unknown) => e,
    ),
  );
  expect(shutdown).toMatchObject({ code: -32602 });
  // The core is still alive.
  await expect(page.evaluate(() => window.chef.rpc('system.ping', {}))).resolves.toBeTruthy();
});

test('ops.run progress and result arrive as rpc events', async () => {
  launched = await launchApp();
  const { page } = launched;
  await recordEvents(page);
  const { jobId } = await page.evaluate(() =>
    window.chef.rpc('ops.run', { sessionId: 's1', opId: 'page.rotate', params: { pages: [0] } }),
  );
  await expect
    .poll(async () =>
      (await events<{ name?: string }>(page)).some((e) => e.name === 'job.finished'),
    )
    .toBe(true);
  const rpcEvents = (
    await events<{ type: string; name: string; payload: { jobId: string } }>(page)
  ).filter((e) => e.type === 'rpc');
  expect(rpcEvents.map((e) => e.name)).toEqual([
    'job.progress',
    'job.progress',
    'job.progress',
    'job.finished',
  ]);
  expect(rpcEvents.every((e) => e.payload.jobId === jobId)).toBe(true);
});

test('chef-file serves session files (with ranges) and 403s everything else', async () => {
  const userDataDir = makeUserDataDir();
  const rev = path.join(userDataDir, 'sessions', 'abc', 'rev-0000.pdf');
  writePdf(rev);
  const secret = path.join(userDataDir, 'settings-secret.txt');
  fs.writeFileSync(secret, 'secret');
  launched = await launchApp({ userDataDir });
  const res = await launched.page.evaluate(
    async ({ rev, secret }) => {
      const ok = await fetch(window.chef.files.toUrl(rev));
      const range = await fetch(window.chef.files.toUrl(rev), { headers: { Range: 'bytes=0-7' } });
      const denied = await fetch(window.chef.files.toUrl(secret));
      const passwd = await fetch(window.chef.files.toUrl('/etc/passwd'));
      return {
        ok: ok.status,
        type: ok.headers.get('content-type'),
        head: (await ok.text()).slice(0, 8),
        range: range.status,
        rangeBody: await range.text(),
        contentRange: range.headers.get('content-range'),
        denied: denied.status,
        passwd: passwd.status,
      };
    },
    { rev, secret },
  );
  expect(res).toMatchObject({
    ok: 200,
    type: 'application/pdf',
    head: '%PDF-1.4',
    range: 206,
    rangeBody: '%PDF-1.4',
    denied: 403,
    passwd: 403,
  });
  expect(res.contentRange).toMatch(/^bytes 0-7\/\d+$/);
});

test('files passed on the command line are initialFiles and readable via chef-file', async () => {
  const userDataDir = makeUserDataDir();
  const doc = path.join(makeUserDataDir(), 'Tài liệu mở.pdf');
  writePdf(doc);
  launched = await launchApp({ userDataDir, args: [doc] });
  const res = await launched.page.evaluate(async () => {
    const files = await window.chef.app.initialFiles();
    const status = files[0] ? (await fetch(window.chef.files.toUrl(files[0]))).status : 0;
    return { files, status };
  });
  expect(res.files).toEqual([doc]);
  expect(res.status).toBe(200);
});

test('a second instance forwards its files as an open-files event and exits', async () => {
  launched = await launchApp();
  const { page, userDataDir } = launched;
  await recordEvents(page);
  const doc = path.join(makeUserDataDir(), 'second.pdf');
  writePdf(doc);
  const second = spawn(electronBin, [desktopDir, ...sandboxArgs, doc], {
    env: appEnv(userDataDir),
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve) => second.on('exit', resolve));
  expect(code).toBe(0);
  await expect
    .poll(async () =>
      (await events<{ type: string; paths?: string[] }>(page)).find((e) => e.type === 'open-files'),
    )
    .toEqual({ type: 'open-files', paths: [doc] });
  const status = await page.evaluate(
    (p) => fetch(window.chef.files.toUrl(p)).then((r) => r.status),
    doc,
  );
  expect(status).toBe(200);
});

test('settings persist to settings.json with defaults and recent files', async () => {
  launched = await launchApp();
  const { page, userDataDir } = launched;
  const res = await page.evaluate(async () => {
    const initial = await window.chef.settings.get();
    const updated = await window.chef.settings.set({ theme: 'dark' });
    const recent = await window.chef.settings.addRecent('/tmp/x/a.pdf');
    const bad = await window.chef.settings.set({ language: 'xx' as never }).then(
      () => 'accepted',
      () => 'rejected',
    );
    return { initial, updated: updated.theme, recent: recent.recentFiles, bad };
  });
  expect(res.initial).toMatchObject({
    version: 1,
    language: 'vi',
    theme: 'system',
    recentFiles: [],
  });
  expect(res.updated).toBe('dark');
  // main normalises the path for the current OS (backslashes on Windows)
  expect(res.recent[0]).toMatchObject({ path: path.normalize('/tmp/x/a.pdf'), name: 'a.pdf' });
  expect(res.bad).toBe('rejected');
  const disk = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'));
  expect(disk).toMatchObject({ version: 1, theme: 'dark' });
});

test('the core is restarted after a crash with core-status events', async () => {
  launched = await launchApp();
  const { page, userDataDir } = launched;
  await page.evaluate(() => window.chef.rpc('system.ping', {}));
  // main re-sends the current core status when the window finishes loading; let that settle first
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  await recordEvents(page);
  await page.evaluate(() => window.chef.rpc('mock.crash' as never, {} as never));
  await expect
    .poll(async () =>
      (await events<{ type: string; status?: string }>(page))
        .filter((e) => e.type === 'core-status')
        .map((e) => e.status),
    )
    .toEqual(['ready', 'crashed', 'restarting', 'starting', 'ready']);
  await expect(page.evaluate(() => window.chef.rpc('system.ping', {}))).resolves.toMatchObject({
    version: '0.0.0-mock',
  });
  const log = fs.readFileSync(path.join(userDataDir, 'logs', 'core.log'), 'utf8');
  expect(log).toContain('mock-core: crashing on request');
});

test('navigation away from the app and new windows are blocked', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  // file: URLs exercise the same guards as remote URLs without opening an external browser.
  await page.evaluate(() => {
    window.open('file:///', '_blank');
    location.href = 'file:///';
  });
  await page.waitForTimeout(500);
  expect(page.url().startsWith('chef-app://ui/')).toBe(true);
  expect(app.windows()).toHaveLength(1);
});
