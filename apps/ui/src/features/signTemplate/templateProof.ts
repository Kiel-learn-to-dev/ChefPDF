/**
 * "Xem thử bằng lõi": a preview drawn by the real core, through the op `sign.templatePreview`.
 *
 * No core op exists for it yet. The button is shown only when `ops.list` names the op (feature
 * detection), so the studio works without it. The params below are the planned contract:
 * `{ template, outputPath, width, height, values }`; the op writes a PNG to outputPath.
 */
import type { OpDescriptor, SignatureTemplate } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { call } from '../../lib/rpc';
import { runLooseOp } from '../../lib/looseOp';
import { join } from '../../lib/path';
import { toWire } from './templateModel';

export const PROOF_OP_ID = 'sign.templatePreview';

/** True when the core lists the preview op. Never throws: a failed list means "not available". */
export async function hasProofOp(): Promise<boolean> {
  try {
    const ops = await call('ops.list', {});
    return (ops as OpDescriptor[]).some((o) => o.id === PROOF_OP_ID);
  } catch {
    return false;
  }
}

export interface ProofValues {
  signerName: string;
  organization: string;
  taxCode: string;
  citizenId: string;
  reason: string;
  location: string;
  contact: string;
}

/** Renders the template with the core and returns the PNG path (inside the app cache). */
export async function renderTemplateProof(
  template: SignatureTemplate,
  values: ProofValues,
  box: { width: number; height: number },
): Promise<string> {
  const dir = await chef().library.workDir();
  const outputPath = join(dir, `proof-${Math.random().toString(36).slice(2, 10)}.png`);
  const result = await runLooseOp(
    PROOF_OP_ID,
    { template: toWire(template), outputPath, width: box.width, height: box.height, values },
    'Xem thử mẫu chữ ký',
  );
  const written = (result as { path?: string } | null)?.path ?? outputPath;
  return written;
}
