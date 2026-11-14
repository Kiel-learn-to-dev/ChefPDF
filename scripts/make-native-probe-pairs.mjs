#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function readIndex(indexPath, label) {
  const absolute = path.resolve(indexPath);
  let index;
  try {
    index = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} index ${absolute}: ${error.message}`);
  }
  if (!Array.isArray(index.captures) || index.captures.length === 0) {
    throw new Error(`${label} index must contain a non-empty captures array`);
  }
  const captures = new Map();
  for (const [i, capture] of index.captures.entries()) {
    const theme = capture.theme;
    const width = Number(capture.logicalWidth);
    const height = Number(capture.logicalHeight);
    const dpr = Number(capture.devicePixelRatio ?? capture.dpr);
    const pixelWidth = Number(capture.width ?? capture.widthPx);
    const pixelHeight = Number(capture.height ?? capture.heightPx);
    if (
      !['light', 'dark'].includes(theme) ||
      ![width, height, dpr, pixelWidth, pixelHeight].every(Number.isFinite)
    ) {
      throw new Error(`${label} captures[${i}] has invalid theme or dimensions`);
    }
    if (
      typeof capture.file !== 'string' ||
      !capture.file ||
      !/^[a-f0-9]{64}$/i.test(capture.sha256 ?? '')
    ) {
      throw new Error(`${label} captures[${i}] must include file and SHA-256`);
    }
    const key = `${theme}|${width}|${height}|${dpr.toFixed(2)}`;
    if (captures.has(key)) throw new Error(`${label} index has duplicate capture key ${key}`);
    const imagePath = path.resolve(path.dirname(absolute), capture.file);
    if (!fs.existsSync(imagePath)) throw new Error(`${label} image is missing: ${imagePath}`);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
    if (actualHash !== capture.sha256.toLowerCase())
      throw new Error(`${label} SHA-256 mismatch: ${imagePath}`);
    captures.set(key, { key, theme, width, height, dpr, pixelWidth, pixelHeight, imagePath });
  }
  return captures;
}

export function makePairs(electronIndex, rustIndex) {
  const references = readIndex(electronIndex, 'Electron');
  const candidates = readIndex(rustIndex, 'Rust');
  const jobs = [];
  for (const [key, candidate] of candidates) {
    const reference = references.get(key);
    if (!reference) throw new Error(`No Electron reference matches Rust capture ${key}`);
    if (
      reference.pixelWidth !== candidate.pixelWidth ||
      reference.pixelHeight !== candidate.pixelHeight
    ) {
      throw new Error(
        `Pixel dimensions differ for ${key}: Electron ${reference.pixelWidth}x${reference.pixelHeight}, Rust ${candidate.pixelWidth}x${candidate.pixelHeight}`,
      );
    }
    const dpr = String(candidate.dpr).replace('.', '_');
    jobs.push({
      name: `probe-${candidate.theme}-w${candidate.width}-dpr${dpr}`,
      reference: reference.imagePath,
      candidate: candidate.imagePath,
    });
  }
  if (!jobs.length) throw new Error('No matching visual capture pairs found');
  return { config: {}, jobs };
}

function main(args) {
  if (args.length !== 3) {
    throw new Error(
      'Usage: node scripts/make-native-probe-pairs.mjs <electron-capture-index.json> <rust-capture-index.json> <pairs.json>',
    );
  }
  const pairs = makePairs(args[0], args[1]);
  const output = path.resolve(args[2]);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(pairs, null, 2)}\n`);
  process.stdout.write(`Wrote ${pairs.jobs.length} visual pairs to ${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`make-native-probe-pairs: ${error.message}\n`);
    process.exitCode = 2;
  }
}
