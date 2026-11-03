export interface RenameRow {
  from: string;
  to: string | null;
  status: string;
  message: string | null;
}
export function executableMapping(rows: RenameRow[]) {
  return rows
    .filter((row) => row.status === 'ready' && row.to !== null)
    .map((row) => ({ source: row.from, target: row.to! }));
}
export function undoMapping(rows: RenameRow[]) {
  return rows
    .filter((row) => row.status === 'done' && row.to !== null)
    .map((row) => ({ source: row.to!, target: row.from }));
}
