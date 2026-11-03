import type { FormsAddFieldParams } from '@chef/contracts';

export async function addFieldsSequentially(
  fields: FormsAddFieldParams[],
  add: (field: FormsAddFieldParams) => Promise<boolean>,
  removeGroup: (name: string) => Promise<boolean>,
): Promise<{ success: boolean; completed: number; rolledBack: boolean }> {
  for (let index = 0; index < fields.length; index += 1) {
    if (await add(fields[index]!)) continue;
    const rolledBack = fields.length > 1 ? await removeGroup(fields[0]!.name) : false;
    return { success: false, completed: index, rolledBack };
  }
  return { success: true, completed: fields.length, rolledBack: false };
}
