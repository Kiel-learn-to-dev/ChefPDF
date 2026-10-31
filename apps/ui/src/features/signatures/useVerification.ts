import { useEffect } from 'react';
import type { DocTab } from '../../app/state/documents';
import { disposeVerify, scheduleVerify, useVerifyStore } from './verifyStore';

/**
 * Keeps the verification result of the active document current: runs the check when a document
 * with signatures is shown or its revision changes, and clears it when there are none.
 */
export function useVerification(doc: DocTab | undefined): void {
  const docId = doc?.id;
  const hasSignatures = doc?.info.hasSignatures ?? false;
  const revision = doc ? `${doc.state.revisionPath}#${doc.state.revision}` : null;

  useEffect(() => {
    if (!docId) return;
    if (!hasSignatures) {
      useVerifyStore.getState().patch(docId, { phase: 'idle', items: [], error: null });
      return;
    }
    scheduleVerify(docId, revision!);
  }, [docId, hasSignatures, revision]);

  useEffect(() => {
    if (!docId) return;
    return () => disposeVerify(docId);
  }, [docId]);
}
