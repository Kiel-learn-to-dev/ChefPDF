import { useState } from 'react';
import { Eye, EyeOff, KeyRound, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '../components/Button';
import { Dialog, DialogSpacer } from '../components/Dialog';
import { Field, TextInput } from '../components/Form';
import { settlePrompt, usePrompts, type Prompt } from './prompts';

function PasswordPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'password' }> }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const submit = () => value && settlePrompt(prompt, value);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && settlePrompt(prompt, null)}
      size="sm"
      icon={<KeyRound size={18} />}
      title={t('password.title')}
      description={t('password.description', { name: prompt.fileName })}
      footer={
        <>
          <DialogSpacer />
          <Button onClick={() => settlePrompt(prompt, null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={!value}>
            {t('password.open')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label={t('password.label')}
          htmlFor="pdf-password"
          error={prompt.invalid ? t('password.invalid') : undefined}
          hint={t('password.hint')}
        >
          <div className="field__row">
            <TextInput
              id="pdf-password"
              type={show ? 'text' : 'password'}
              autoFocus
              autoComplete="off"
              value={value}
              invalid={prompt.invalid}
              onChange={(e) => setValue(e.target.value)}
            />
            <IconButton
              label={show ? t('password.hide') : t('password.show')}
              icon={show ? <EyeOff size={16} /> : <Eye size={16} />}
              onClick={() => setShow(!show)}
            />
          </div>
        </Field>
      </form>
    </Dialog>
  );
}

function ConfirmPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'confirm' }> }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && settlePrompt(prompt, null)}
      size="sm"
      tone={prompt.tone}
      icon={prompt.tone === 'danger' ? <TriangleAlert size={18} /> : undefined}
      title={prompt.title}
      description={prompt.message}
      footer={
        <>
          <DialogSpacer />
          {prompt.actions.map((a, i) => (
            <Button
              key={a.id}
              variant={a.variant ?? 'secondary'}
              autoFocus={i === prompt.actions.length - 1}
              onClick={() => settlePrompt(prompt, a.id)}
            >
              {a.label}
            </Button>
          ))}
        </>
      }
    />
  );
}

const keys = new WeakMap<Prompt, number>();
let nextKey = 1;
function keyOf(p: Prompt): number {
  let k = keys.get(p);
  if (!k) keys.set(p, (k = nextKey++));
  return k;
}

/** Renders the first queued prompt (password, confirm). */
export function PromptHost() {
  const prompt = usePrompts((s) => s.queue[0]);
  if (!prompt) return null;
  return prompt.kind === 'password' ? (
    <PasswordPrompt key={keyOf(prompt)} prompt={prompt} />
  ) : (
    <ConfirmPrompt prompt={prompt} />
  );
}
