import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

/** Serve (dev) and copy (build) pdf.js runtime assets under `pdfjs/`. */
function pdfjsAssets(): Plugin {
  return {
    name: 'chef-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0] ?? '')).replace(
          /^([/\\])+/,
          '',
        );
        const top = rel.split(/[/\\]/)[0] ?? '';
        const file = join(PDFJS_ROOT, rel);
        if (
          !PDFJS_DIRS.includes(top) ||
          !file.startsWith(PDFJS_ROOT) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          next();
          return;
        }
        res.setHeader(
          'Content-Type',
          file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        );
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of readdirSync(join(PDFJS_ROOT, dir))) {
          if (name.startsWith('LICENSE') || name.startsWith('quickjs')) continue; // quickjs: scripting sandbox, never enabled
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(PDFJS_ROOT, dir, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  // Relative base so the built renderer loads from file:// or a custom protocol in Electron.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
