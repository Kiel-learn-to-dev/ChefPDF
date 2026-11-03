import { describe, expect, it } from 'vitest';
import {
  buildWorkflowOutputOverride,
  createWorkflow,
  formatWorkflowJson,
  moveWorkflowStep,
  parseWorkflowJson,
  removeWorkflowStep,
} from './workflowModel';

describe('workflow editor model', () => {
  it('creates an empty editable workflow with a valid baseline shape', () => {
    expect(createWorkflow()).toMatchObject({ version: 1, steps: [], inputs: { accept: ['pdf'] } });
  });

  it('starts a workflow with a copied task dialog step', () => {
    const params = { mode: 'grayscale' };
    const flow = createWorkflow({ op: 'color.convert', params, label: 'Convert colours' });
    params.mode = 'blackwhite';
    expect(flow.steps).toEqual([
      { op: 'color.convert', params: { mode: 'grayscale' }, label: 'Convert colours' },
    ]);
  });

  it('moves steps in order and leaves the list unchanged at its boundaries', () => {
    const steps = [{ op: 'page.rotate' }, { op: 'page.crop' }];
    expect(moveWorkflowStep(steps, 0, 1).map((step) => step.op)).toEqual([
      'page.crop',
      'page.rotate',
    ]);
    expect(moveWorkflowStep(steps, 0, -1)).toEqual(steps);
  });

  it('keeps editor keys attached to their draft owners while reordering or deleting rows', () => {
    const keys = ['a', 'b', 'c'];
    const drafts: Record<string, string> = { a: '{bad', b: '{"pages":[0]}', c: '{}' };
    const moved = moveWorkflowStep(keys, 0, 1);
    expect(moved).toEqual(['b', 'a', 'c']);
    expect(drafts[moved[1]!]).toBe('{bad');
    expect(removeWorkflowStep(moved, 1)).toEqual(['b', 'c']);
  });

  it('round trips workflow JSON and rejects non-object JSON', () => {
    const flow = createWorkflow();
    expect(parseWorkflowJson(formatWorkflowJson(flow))).toEqual(flow);
    expect(() => parseWorkflowJson('[]')).toThrow();
  });

  it('preserves an output size cap when constructing the UI run override', () => {
    expect(
      buildWorkflowOutputOverride(
        { mode: 'suffix', suffix: '_signed', maxBytes: 5_000_000, alsoSavePdf: true },
        { mode: 'folder', suffix: '_user', folder: 'D:/out', nameTemplate: '' },
      ),
    ).toEqual({
      mode: 'folder',
      suffix: '_user',
      folder: 'D:/out',
      maxBytes: 5_000_000,
      alsoSavePdf: true,
    });
  });
});
