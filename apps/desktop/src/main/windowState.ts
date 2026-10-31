/**
 * Persisted window geometry (`<userData>/window-state.json`). Pure Node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './fsutil';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect | null;
  isMaximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 820 };
export const MIN_SIZE = { width: 800, height: 560 };

function isRect(v: unknown): v is Rect {
  return (
    isPlainObject(v) &&
    ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]))
  );
}

export function sanitizeWindowState(raw: unknown): WindowState {
  if (!isPlainObject(raw)) return { bounds: null, isMaximized: false };
  return {
    bounds: isRect(raw.bounds) ? raw.bounds : null,
    isMaximized: raw.isMaximized === true,
  };
}

/**
 * Returns `bounds` if enough of it lies on one of the displays' work areas, otherwise null
 * (e.g. the monitor it was on has been unplugged). Size is clamped to the minimum.
 */
export function fitToDisplays(bounds: Rect | null, workAreas: Rect[]): Rect | null {
  if (!bounds) return null;
  const b = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_SIZE.width, Math.round(bounds.width)),
    height: Math.max(MIN_SIZE.height, Math.round(bounds.height)),
  };
  const visible = workAreas.some((a) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    // Require the title-bar region to be reachable: at least 100x50 px visible.
    return w >= 100 && h >= 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 20;
  });
  return visible ? b : null;
}

export function loadWindowState(file: string): WindowState {
  try {
    return sanitizeWindowState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { bounds: null, isMaximized: false };
  }
}

/** Synchronous atomic save: called from `close`, when async work may not finish. */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    // Losing the window position is not worth crashing for.
  }
}
