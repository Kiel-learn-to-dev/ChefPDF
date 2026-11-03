/** Restore each session independently, retaining failed IDs so a retry does not repeat successes. */
export async function restoreAfterCrash<T>(
  ids: string[],
  restore: (id: string) => Promise<T>,
  apply: (id: string, result: T) => void,
  reportError: (error: unknown) => void,
): Promise<string[]> {
  const pending: string[] = [];
  for (const id of ids) {
    try {
      const result = await restore(id);
      apply(id, result);
    } catch (error) {
      pending.push(id);
      reportError(error);
    }
  }
  return pending;
}
