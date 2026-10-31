/**
 * Calls of the certificate and token ops (standalone, no document needed). Each returns the
 * `data` of the job result. The PIN is never passed here (T3.02, T3.03).
 */
import type { CertInfoData, DiagnoseData, DriverScanData, ListTokensData } from '@chef/contracts';
import { ChefError } from '../../lib/errors';
import { runOp } from '../../lib/rpc';

function dataOf<T>(result: { data?: unknown }): T {
  if (result.data === undefined || result.data === null) {
    throw new ChefError('INTERNAL', 'The core returned no data');
  }
  return result.data as T;
}

/** Reads the certificate in a .pfx / .p12 file. `password` is used once and not kept. */
export async function readCertificate(
  pfxPath: string,
  password: string | undefined,
  title: string,
): Promise<CertInfoData> {
  const result = await runOp('sign.certInfo', password ? { pfxPath, password } : { pfxPath }, {
    title,
    silent: true,
  });
  return dataOf<CertInfoData>(result);
}

export async function scanDrivers(title: string): Promise<DriverScanData> {
  const result = await runOp('sign.driverScan', { probe: true }, { title, silent: true });
  return dataOf<DriverScanData>(result);
}

export async function listTokens(modulePath: string, title: string): Promise<ListTokensData> {
  const result = await runOp('sign.listTokens', { modulePath }, { title, silent: true });
  return dataOf<ListTokensData>(result);
}

export async function diagnoseToken(
  modulePath: string | null,
  title: string,
): Promise<DiagnoseData> {
  const result = await runOp('sign.diagnoseToken', modulePath ? { modulePath } : {}, {
    title,
    silent: true,
  });
  return dataOf<DiagnoseData>(result);
}
