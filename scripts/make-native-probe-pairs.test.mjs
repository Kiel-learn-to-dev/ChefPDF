import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makePairs } from './make-native-probe-pairs.mjs';

function index(dir, source, extension, rust = false) {
  const bytes = Buffer.from(`${source}-image`);
  const file = `probe_${source}.${extension}`;
  fs.writeFileSync(path.join(dir, file), bytes);
  return {
    source,
    captures: [
      {
        file,
        theme: 'dark',
        logicalWidth: 800,
        logicalHeight: 1600,
        devicePixelRatio: 1,
        ...(rust ? { widthPx: 800, heightPx: 1600 } : { width: 800, height: 1600 }),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
}

test('pairs Electron and Rust images by theme, logical size, DPR, and pixel size', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-probe-pairs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const electron = index(dir, 'electron', 'png');
  const rust = index(dir, 'rust', 'bmp', true);
  const electronPath = path.join(dir, 'electron.json');
  const rustPath = path.join(dir, 'rust.json');
  fs.writeFileSync(electronPath, JSON.stringify(electron));
  fs.writeFileSync(rustPath, JSON.stringify(rust));
  const pairs = makePairs(electronPath, rustPath);
  assert.equal(pairs.jobs.length, 1);
  assert.equal(pairs.jobs[0].name, 'probe-dark-w800-dpr1');
  assert.equal(pairs.jobs[0].reference, path.join(dir, 'probe_electron.png'));
  assert.equal(pairs.jobs[0].candidate, path.join(dir, 'probe_rust.bmp'));
});

test('rejects tampered captures', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-probe-pairs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const electronPath = path.join(dir, 'electron.json');
  const rustPath = path.join(dir, 'rust.json');
  fs.writeFileSync(electronPath, JSON.stringify(index(dir, 'electron', 'png')));
  fs.writeFileSync(rustPath, JSON.stringify(index(dir, 'rust', 'bmp', true)));
  fs.appendFileSync(path.join(dir, 'probe_rust.bmp'), 'tampered');
  assert.throws(() => makePairs(electronPath, rustPath), /SHA-256 mismatch/);
});
