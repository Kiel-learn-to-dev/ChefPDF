/**
 * Content Security Policy for the renderer (BLUEPRINT section 7). No remote content:
 * only the app origin, `chef-file:` (viewer files) and `blob:`/`data:` for images.
 * `wasm-unsafe-eval` lets pdf.js compile its WebAssembly decoders (no JS eval).
 */
import { FILE_SCHEME } from '../shared/ipc';

export function buildCsp(options: { devServerUrl?: string | undefined } = {}): string {
  const dev = options.devServerUrl ? new URL(options.devServerUrl) : null;
  const devHttp = dev ? dev.origin : '';
  const devWs = dev ? `${dev.protocol === 'https:' ? 'wss:' : 'ws:'}//${dev.host}` : '';
  // Vite's dev client and the React refresh preamble need inline scripts and a websocket.
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'", ...(dev ? [devHttp, "'unsafe-inline'"] : [])];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    'style-src': ["'self'", "'unsafe-inline'", ...(dev ? [devHttp] : [])],
    'img-src': ["'self'", `${FILE_SCHEME}:`, 'blob:', 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      `${FILE_SCHEME}:`,
      'blob:',
      'data:',
      ...(dev ? [devHttp, devWs] : []),
    ],
    'media-src': ["'self'", `${FILE_SCHEME}:`, 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'child-src': ["'self'", 'blob:'],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}
