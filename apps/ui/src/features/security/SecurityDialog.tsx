/**
 * Password & permissions (J1, J2): sets a user and/or owner password and the permissions. The
 * protection is applied when the document is saved (pendingEncryption). "Gỡ bảo vệ" removes it
 * on the next save. Passwords live in this dialog's state only (never persisted or logged).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { getDoc, useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, TextInput } from '../../components/Form';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { errorMessage, runDocOp } from '../../app/actions';
import { toChefError } from '../../lib/errors';
import {
  ALL_PERMISSIONS,
  EMPTY_PASSWORD_FORM,
  PERMISSION_KEYS,
  issueKey,
  passwordStrength,
  protectionParams,
  setPermission,
  validatePasswords,
  type PasswordForm,
  type PermissionKey,
  type Permissions,
} from './securityModel';
import './security.css';

/** Password & permissions dialog (J1, J2). */
export function SecurityDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [perms, setPerms] = useState<Permissions>(ALL_PERMISSIONS);
  const [show, setShow] = useState(false);
  const [removePassword, setRemovePassword] = useState('');
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!doc) return null;

  const blocked = doc.state.signed;
  const issues = validatePasswords(form, perms);
  const set = (patch: Partial<PasswordForm>) => setForm((f) => ({ ...f, ...patch }));
  const togglePerm = (key: PermissionKey, value: boolean) =>
    setPerms((p) => setPermission(p, key, value));
  const inputType = show ? 'text' : 'password';
  const strength = passwordStrength(form.userPassword || form.ownerPassword);

  const apply = async () => {
    if (issues.length > 0 || blocked) return;
    setBusy(true);
    const ok = await runDocOp(
      doc.id,
      'security.encrypt',
      protectionParams(form, perms),
      t('security.job', { name: doc.name }),
    );
    setBusy(false);
    if (ok) {
      toast.success(t('security.title'), t('security.applied'));
      setForm(EMPTY_PASSWORD_FORM);
      close();
    }
  };

  const remove = async () => {
    if (blocked) return;
    setBusy(true);
    setRemoveError(null);
    // The password the file was opened with is kept in memory by the document tab.
    const password = removePassword || getDoc(doc.id)?.password || undefined;
    const ok = await runDocOp(
      doc.id,
      'security.decrypt',
      { password },
      t('security.removeJob', { name: doc.name }),
      {
        onError: (e) => {
          // Shown inline in the dialog instead of a toast.
          setRemoveError(errorMessage(toChefError(e)));
          return true;
        },
      },
    );
    setBusy(false);
    if (ok) {
      toast.success(t('security.title'), t('security.removed'));
      setRemovePassword('');
      close();
    }
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('security.signedBlocked'));
  if (doc.state.pendingEncryption) warnings.push(t('security.pendingNote'));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('security.title')}
      icon={<KeyRound size={18} />}
      description={t('security.description')}
      size="lg"
      modalLock={busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => close()} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            disabled={blocked || busy}
            title={blocked ? t('security.signedBlocked') : undefined}
          >
            {t('security.remove')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void apply()}
            disabled={blocked || busy || issues.length > 0}
            title={blocked ? t('security.signedBlocked') : undefined}
            loading={busy}
          >
            {t('security.apply')}
          </Button>
        </>
      }
    >
      <div className="security">
        <div className="security__passwords">
          <Field label={t('security.userPassword')} htmlFor="sec-user">
            <TextInput
              id="sec-user"
              type={inputType}
              autoComplete="new-password"
              value={form.userPassword}
              onChange={(e) => set({ userPassword: e.target.value })}
              disabled={blocked}
            />
          </Field>
          <Field label={t('security.userConfirm')} htmlFor="sec-user-confirm">
            <TextInput
              id="sec-user-confirm"
              type={inputType}
              autoComplete="new-password"
              value={form.userConfirm}
              invalid={issues.includes('userMismatch')}
              onChange={(e) => set({ userConfirm: e.target.value })}
              disabled={blocked}
            />
          </Field>
          <Field label={t('security.ownerPassword')} htmlFor="sec-owner">
            <TextInput
              id="sec-owner"
              type={inputType}
              autoComplete="new-password"
              value={form.ownerPassword}
              onChange={(e) => set({ ownerPassword: e.target.value })}
              disabled={blocked}
            />
          </Field>
          <Field label={t('security.ownerConfirm')} htmlFor="sec-owner-confirm">
            <TextInput
              id="sec-owner-confirm"
              type={inputType}
              autoComplete="new-password"
              value={form.ownerConfirm}
              invalid={issues.includes('ownerMismatch')}
              onChange={(e) => set({ ownerConfirm: e.target.value })}
              disabled={blocked}
            />
          </Field>
          <div className="security__row">
            <Checkbox checked={show} onChange={setShow} label={t('security.show')} />
            <span className={`security__strength security__strength--${strength}`}>
              {t('security.strength', { level: t(`security.level.${strength}`) })}
            </span>
          </div>
        </div>

        <fieldset className="security__perms">
          <legend>{t('security.permissions')}</legend>
          {PERMISSION_KEYS.map((key) => (
            <Checkbox
              key={key}
              checked={perms[key]}
              disabled={blocked || (key === 'printHighRes' && !perms.printLowRes)}
              onChange={(v) => togglePerm(key, v)}
              label={t(`security.perm.${key}`)}
              hint={t(`security.perm.${key}Hint`)}
            />
          ))}
        </fieldset>

        {issues.length > 0 && (form.userPassword || form.ownerPassword || form.userConfirm) && (
          <ul className="security__issues" role="alert">
            {issues.map((i) => (
              <li key={i}>{t(issueKey(i))}</li>
            ))}
          </ul>
        )}

        <Field
          label={t('security.removeLabel')}
          htmlFor="sec-remove"
          hint={t('security.removeHint')}
          error={removeError ?? undefined}
        >
          <TextInput
            id="sec-remove"
            type="password"
            autoComplete="off"
            value={removePassword}
            onChange={(e) => {
              setRemovePassword(e.target.value);
              setRemoveError(null);
            }}
            disabled={blocked}
          />
        </Field>

        <ul className="security__notes">
          <li>{t('security.saveHint')}</li>
          {doc.info.encrypted && <li>{t('security.encryptedNote')}</li>}
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
