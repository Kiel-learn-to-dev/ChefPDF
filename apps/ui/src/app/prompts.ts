import { create } from 'zustand';

export interface ConfirmAction<R extends string> {
  id: R;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}

export type Prompt =
  | { kind: 'password'; fileName: string; invalid: boolean; resolve(v: string | null): void }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      tone: 'default' | 'danger';
      actions: ConfirmAction<string>[];
      resolve(v: string | null): void;
    };

interface PromptState {
  queue: Prompt[];
}

export const usePrompts = create<PromptState>(() => ({ queue: [] }));

function enqueue(p: Prompt) {
  usePrompts.setState((s) => ({ queue: [...s.queue, p] }));
}

export function settlePrompt(p: Prompt, value: string | null) {
  usePrompts.setState((s) => ({ queue: s.queue.filter((x) => x !== p) }));
  p.resolve(value);
}

/** Ask for a document password; null when cancelled. */
export function askPassword(fileName: string, invalid: boolean): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'password', fileName, invalid, resolve }));
}

/** Ask a question with custom buttons; resolves with the action id or null (dismissed). */
export function confirmDialog<R extends string>(opts: {
  title: string;
  message: string;
  tone?: 'default' | 'danger';
  actions: ConfirmAction<R>[];
}): Promise<R | null> {
  return new Promise((resolve) =>
    enqueue({
      kind: 'confirm',
      title: opts.title,
      message: opts.message,
      tone: opts.tone ?? 'default',
      actions: opts.actions,
      resolve: resolve as (v: string | null) => void,
    }),
  );
}
