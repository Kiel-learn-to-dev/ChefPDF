/**
 * Pure model of crash recovery (A9, T5.10): reads the list the core returns (recovery.list),
 * drops malformed entries, keeps one entry per session, newest change first.
 */
import type { RecoverableSession } from '@chef/contracts';
import { basename } from '../../lib/path';

function isSession(v: unknown): v is RecoverableSession {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sessionId === 'string' &&
    o.sessionId !== '' &&
    (typeof o.sourcePath === 'string' || o.sourcePath === null) &&
    typeof o.openedAt === 'string' &&
    typeof o.lastModified === 'string' &&
    typeof o.revision === 'number' &&
    typeof o.dirty === 'boolean' &&
    typeof o.pages === 'number' &&
    typeof o.hasUnsavedChanges === 'boolean'
  );
}

/** The sessions of a recovery.list result that have the expected shape. */
export function readRecoverable(data: unknown): RecoverableSession[] {
  return Array.isArray(data) ? data.filter(isSession) : [];
}

/** Newest change first; one entry per session id (the first one wins after sorting). */
export function sortRecoverable(list: RecoverableSession[]): RecoverableSession[] {
  const sorted = [...list].sort((a, b) => {
    const byChange = Date.parse(b.lastModified) - Date.parse(a.lastModified);
    if (Number.isFinite(byChange) && byChange !== 0) return byChange;
    return a.sessionId.localeCompare(b.sessionId);
  });
  const seen = new Set<string>();
  return sorted.filter((s) => {
    if (seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** File name of the session's document, or null for an untitled one. */
export function recoveryName(s: RecoverableSession): string | null {
  return s.sourcePath ? basename(s.sourcePath) : null;
}
