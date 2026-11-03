import { expect, it } from 'vitest';
import { executableMapping, undoMapping } from './namingModel';

it('executes only ready mappings and reverses only successful renames', () => {
  const rows = [
    { from: 'a.pdf', to: 'b.pdf', status: 'ready', message: null },
    { from: 'c.pdf', to: null, status: 'skipped', message: 'conflict' },
    { from: 'd.pdf', to: 'e.pdf', status: 'done', message: null },
  ];
  expect(executableMapping(rows)).toEqual([{ source: 'a.pdf', target: 'b.pdf' }]);
  expect(undoMapping(rows)).toEqual([{ source: 'e.pdf', target: 'd.pdf' }]);
});
