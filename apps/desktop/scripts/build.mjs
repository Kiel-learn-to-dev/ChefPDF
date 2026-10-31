// Bundles the Electron main process and preload with esbuild.
// Usage: node scripts/build.mjs [--watch]
import { context, build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
  absWorkingDir: root,
};

/** @type {import('esbuild').BuildOptions[]} */
export const targets = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    platform: 'node',
    target: 'node22',
  },
  {
    // Sandboxed preload: browser-like environment where only `electron` can be required.
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
    platform: 'browser',
    target: 'chrome130',
  },
];

export async function buildAll() {
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  await Promise.all(targets.map((t) => build(t)));
}

/** Starts esbuild watchers; `onRebuild` runs after every successful rebuild. */
export async function watchAll(onRebuild) {
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  // Notify once every target has built, debounced so main + preload rebuilds coalesce.
  const built = new Set();
  let timer = null;
  const notify = (name) => ({
    name: 'notify',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length > 0) return;
        built.add(name);
        if (built.size < targets.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => onRebuild?.(), 150);
      });
    },
  });
  const contexts = await Promise.all(
    targets.map((t) => context({ ...t, plugins: [notify(t.outfile)] })),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  return contexts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--watch')) {
    await watchAll();
  } else {
    await buildAll();
  }
}
