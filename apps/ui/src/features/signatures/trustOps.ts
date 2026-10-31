/**
 * Calls of the trust-store ops (sign.trustList / sign.trustAdd / sign.trustRemove, I35).
 * Param types come from the generated core types; the result data is TrustListData (rpc.ts).
 */
import type { TrustEntry, TrustListData } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { ChefError } from '../../lib/errors';
import { runOp } from '../../lib/rpc';

export async function listTrust(title: string): Promise<TrustEntry[]> {
  const result = await runOp('sign.trustList', {}, { title, silent: true });
  const data = result.data as TrustListData | null | undefined;
  if (!data || !Array.isArray(data.entries)) {
    throw new ChefError('INTERNAL', 'The core returned no trust list');
  }
  return data.entries;
}

export async function addTrust(
  params: { path: string; group: 'vn-public-ca' | 'vn-gov-ca' | 'user' },
  title: string,
): Promise<void> {
  await runOp('sign.trustAdd', params, { title, silent: true });
}

export async function removeTrust(fingerprintSha256: string, title: string): Promise<void> {
  await runOp('sign.trustRemove', { fingerprintSha256 }, { title, silent: true });
}

/** Path picker for trust files (PEM / DER certificates). */
export async function pickTrustFiles(): Promise<string[]> {
  return chef().files.openDialog({
    multiple: false,
    filters: [{ name: 'Certificate', extensions: ['pem', 'crt', 'cer', 'der'] }],
  });
}
