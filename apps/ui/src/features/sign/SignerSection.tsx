/**
 * Who signs (dialog section (a)): a certificate file (.pfx / .p12, password kept in memory or in
 * the OS keychain when the user asks) or a USB token (driver, token, certificate and PIN).
 *
 * Secrets: the PFX password and the token PIN live only in this component's state. They are sent
 * to the core in the op params and never saved. The parent gets the ready choice through onReady;
 * unmounting (closing the dialog) drops both secrets.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  FileKey,
  FolderOpen,
  Lock,
  RefreshCw,
  Stethoscope,
  TriangleAlert,
  ShieldCheck,
  Usb,
} from 'lucide-react';
import type {
  CertInfoData,
  DriverRow,
  KnownPfxFile,
  PinState,
  TokenCertificate,
  TokenInfo,
} from '@chef/contracts';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Select, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { isPasswordProblem, toChefError } from '../../lib/errors';
import { CertCard } from '../certs/CertCard';
import { listTokens, readCertificate, scanDrivers } from '../certs/certOps';
import { fileNameOf, findKnownPfx, setRemembered, upsertKnownPfx } from '../certs/pfxList';
import { isSelectable, sortDrivers } from '../certs/driverList';
import type { SignerChoice } from './signRequest';

/** One certificate of the Windows personal store, as sign.listStoreCertificates reports it. */
interface StoreRow {
  subject: string;
  issuer: string;
  thumbprint: string;
  notAfter: string;
  hasPrivateKey: boolean;
}
import './sign.css';

export interface SignerReady {
  choice: SignerChoice | null;
  /** Fingerprint of the signing certificate, when known (for the bound template). */
  fingerprint: string | null;
  /** True when the chosen token has one try left: a confirmation is needed. */
  finalTry: boolean;
  /** Short name of the signer for messages. */
  label: string;
}

export interface SignerHandle {
  /** Forgets the PIN and the password typed so far (after use). */
  clearSecrets(): void;
}

interface Props {
  onReady(r: SignerReady): void;
  /** Called with a message when the signer cannot be used (wrong password, token problems). */
  onProblem?(message: string | null): void;
}

/** Paths of .pfx files compare case-insensitively on Windows and macOS (as the certificate manager does). */
function pathCompare() {
  const p = chef().app.platform;
  return { caseInsensitive: p === 'win32' || p === 'darwin' };
}

const PIN_NOTE: Record<PinState, string | null> = {
  ok: null,
  count_low: 'sign.pin.countLow',
  final_try: 'sign.pin.finalTry',
  locked: 'sign.pin.locked',
  to_be_changed: 'sign.pin.toBeChanged',
};

export const SignerSection = forwardRef<SignerHandle, Props>(function SignerSection(
  { onReady, onProblem },
  ref,
) {
  const { t } = useTranslation();
  const knownPfx = useSettings((s) => s.settings.knownPfxFiles);
  const lastDriver = useSettings((s) => s.settings.lastDriverPath);
  const update = useSettings((s) => s.update);
  const openDialog = useUi((s) => s.openDialog);
  const [kind, setKind] = useState<'pfx' | 'token' | 'store'>('pfx');
  // Windows store state (T4.11).
  const [storeRows, setStoreRows] = useState<StoreRow[] | null>(null);
  const [storeThumb, setStoreThumb] = useState('');
  const [secretsOk, setSecretsOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PFX state.
  const [pfxPath, setPfxPath] = useState<string | null>(null);
  const [pfxPassword, setPfxPassword] = useState('');
  const [rememberPfx, setRememberPfx] = useState(false);
  const [cert, setCert] = useState<CertInfoData | null>(null);

  // Token state.
  const [drivers, setDrivers] = useState<DriverRow[] | null>(null);
  const [modulePath, setModulePath] = useState<string | null>(lastDriver);
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [certId, setCertId] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  useEffect(() => {
    let alive = true;
    chef()
      .secrets.available()
      .then((ok) => alive && setSecretsOk(ok))
      .catch(() => alive && setSecretsOk(false));
    return () => {
      alive = false;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    clearSecrets() {
      setPfxPassword('');
      setPin('');
    },
  }));

  const token = tokens?.find((x) => x.slotId === slotId) ?? null;
  const tokenCerts: TokenCertificate[] = token?.certificates.filter((c) => !c.isCa) ?? [];
  const tokenCert = tokenCerts.find((c) => c.ckaId === certId) ?? null;

  // Report the ready choice whenever an input changes.
  useEffect(() => {
    if (kind === 'store') {
      const picked = storeRows?.find((r) => r.thumbprint === storeThumb) ?? null;
      onReady({
        choice: picked ? { kind: 'store', thumbprint: picked.thumbprint } : null,
        fingerprint: null,
        finalTry: false,
        label: picked?.subject ?? '',
      });
      return;
    }
    if (kind === 'pfx') {
      onReady({
        choice: pfxPath
          ? { kind: 'pfx', pfxPath, ...(pfxPassword ? { password: pfxPassword } : {}) }
          : null,
        fingerprint: cert?.fingerprintSha256 ?? null,
        finalTry: false,
        label:
          cert?.identity.personName ??
          cert?.subjectCommonName ??
          (pfxPath ? fileNameOf(pfxPath) : ''),
      });
      return;
    }
    const usable = !!token && token.pinState !== 'locked' && !!tokenCert && slotId !== null;
    onReady({
      choice:
        usable && modulePath && certId
          ? { kind: 'token', modulePath, slotId: slotId!, certId, pin }
          : null,
      fingerprint: tokenCert?.cert.fingerprintSha256 ?? null,
      finalTry: token?.pinState === 'final_try',
      label: tokenCert?.cert.identity.personName ?? tokenCert?.cert.subjectCommonName ?? '',
    });
    // onReady is stable enough: the parent passes a setState-based callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    kind,
    pfxPath,
    pfxPassword,
    cert,
    modulePath,
    token,
    tokenCert,
    slotId,
    certId,
    pin,
    storeRows,
    storeThumb,
  ]);

  const fail = (e: unknown) => {
    const msg = errorMessage(e);
    setError(msg);
    onProblem?.(msg);
  };

  const saveList = (list: KnownPfxFile[]) => update({ knownPfxFiles: list });

  // ---------- certificate file ----------

  async function readPfx(path: string, pw: string | undefined, fromSaved: boolean) {
    setBusy(true);
    setError(null);
    try {
      const info = await readCertificate(path, pw, t('sign.signer.readJob'));
      setCert(info);
      const cmp = pathCompare();
      const list = useSettings.getState().settings.knownPfxFiles;
      const wasRemembered = findKnownPfx(list, path, cmp)?.remembered ?? false;
      let remembered = false;
      if (rememberPfx && secretsOk && pw) {
        await chef().secrets.set(path, pw);
        remembered = true;
      } else if (wasRemembered && !rememberPfx) {
        await chef()
          .secrets.delete(path)
          .catch(() => undefined);
      }
      setRememberPfx(remembered);
      await saveList(upsertKnownPfx(list, path, cmp, { remembered }));
    } catch (e) {
      setCert(null);
      const err = toChefError(e);
      if (fromSaved && isPasswordProblem(err.kind)) {
        await chef()
          .secrets.delete(path)
          .catch(() => undefined);
        const list = useSettings.getState().settings.knownPfxFiles;
        await saveList(setRemembered(list, path, false, { caseInsensitive: true })).catch(
          () => undefined,
        );
        setRememberPfx(false);
        setPfxPassword('');
        setError(t('sign.signer.savedPasswordWrong'));
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const pickPfx = async () => {
    const [picked] = await chef().files.openDialog({
      multiple: false,
      filters: [{ name: t('certs.pfxFilter'), extensions: ['pfx', 'p12'] }],
    });
    if (!picked) return;
    setPfxPath(picked);
    setCert(null);
    setPfxPassword('');
    setError(null);
    const cmp = pathCompare();
    const entry = findKnownPfx(useSettings.getState().settings.knownPfxFiles, picked, cmp);
    setRememberPfx(entry?.remembered ?? false);
    if (entry?.remembered && secretsOk) {
      const saved = await chef().secrets.get(picked);
      if (saved !== null) {
        setPfxPassword(saved);
        await readPfx(picked, saved, true);
      }
    }
  };

  // ---------- Windows certificate store ----------
  const readStore = async () => {
    setError(null);
    try {
      const result = await runOp(
        'sign.listStoreCertificates',
        { store: 'MY' },
        { title: t('sign.store.readJob'), silent: true },
      );
      const rows = ((result.data as { certificates?: StoreRow[] }).certificates ?? []).filter(
        (r) => r.hasPrivateKey,
      );
      setStoreRows(rows);
      setStoreThumb(rows[0]?.thumbprint ?? '');
    } catch (e) {
      fail(e);
    }
  };

  // ---------- USB token ----------

  const scan = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await scanDrivers(t('certs.scanJob'));
      setDrivers(sortDrivers(data.drivers));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const chooseDriver = (path: string) => {
    setModulePath(path);
    setTokens(null);
    setSlotId(null);
    setCertId(null);
    setPin('');
    update({ lastDriverPath: path }).catch(() => undefined);
  };

  const readTokens = async () => {
    if (!modulePath) return;
    setBusy(true);
    setError(null);
    try {
      const data = await listTokens(modulePath, t('certs.readTokensJob'));
      setTokens(data.tokens);
      const first = data.tokens[0];
      setSlotId(first ? first.slotId : null);
      setCertId(first?.certificates.find((c) => !c.isCa)?.ckaId ?? null);
    } catch (e) {
      setTokens(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const driverOptions = [
    ...(drivers ?? [])
      .filter(isSelectable)
      .map((d) => ({ value: d.path, label: `${d.ca} · ${d.model}` })),
    ...(modulePath && !(drivers ?? []).some((d) => d.path === modulePath)
      ? [{ value: modulePath, label: fileNameOf(modulePath) }]
      : []),
  ];

  return (
    <div className="sign-section">
      <h3 className="sign-section__title">{t('sign.signer.title')}</h3>
      <Segmented<'pfx' | 'token' | 'store'>
        aria-label={t('sign.signer.title')}
        value={kind}
        onChange={(v) => {
          setKind(v);
          setError(null);
        }}
        options={[
          { value: 'pfx', label: t('sign.signer.file'), icon: <FileKey size={14} /> },
          { value: 'token', label: t('sign.signer.token'), icon: <Usb size={14} /> },
          { value: 'store', label: t('sign.signer.store'), icon: <ShieldCheck size={14} /> },
        ]}
      />

      {kind === 'store' ? (
        <div className="sign-store">
          <Button variant="secondary" onClick={() => void readStore()}>
            {t('sign.store.read')}
          </Button>
          {storeRows && storeRows.length === 0 && <p className="muted">{t('sign.store.empty')}</p>}
          {storeRows && storeRows.length > 0 && (
            <Field label={t('sign.store.pick')} htmlFor="sign-store-cert">
              <Select
                id="sign-store-cert"
                value={storeThumb}
                onChange={setStoreThumb}
                options={storeRows.map((r) => ({
                  value: r.thumbprint,
                  label: `${r.subject} · ${t('sign.store.until', { date: r.notAfter.slice(0, 10) })}`,
                }))}
              />
            </Field>
          )}
        </div>
      ) : kind === 'pfx' ? (
        <>
          <div className="sign-row">
            <Button icon={<FolderOpen size={15} />} onClick={() => void pickPfx()} disabled={busy}>
              {t('sign.signer.pickFile')}
            </Button>
            <span className="sign-note" title={pfxPath ?? undefined}>
              {pfxPath ? fileNameOf(pfxPath) : t('sign.signer.noFile')}
            </span>
          </div>
          {knownPfx.length > 0 && (
            <Select
              aria-label={t('sign.signer.saved')}
              value={pfxPath ?? ''}
              options={[
                { value: '', label: t('sign.signer.savedPick') },
                ...knownPfx.map((k) => ({ value: k.path, label: k.label })),
              ]}
              onChange={(v) => {
                if (!v) return;
                const entry = knownPfx.find((k) => k.path === v);
                setPfxPath(v);
                setCert(null);
                setPfxPassword('');
                setRememberPfx(entry?.remembered ?? false);
                if (entry?.remembered && secretsOk) {
                  void chef()
                    .secrets.get(v)
                    .then((saved) => {
                      if (saved !== null) {
                        setPfxPassword(saved);
                        return readPfx(v, saved, true);
                      }
                      return undefined;
                    });
                }
              }}
            />
          )}
          <Field label={t('sign.signer.password')} htmlFor="sign-pfx-password">
            <TextInput
              id="sign-pfx-password"
              type="password"
              autoComplete="off"
              value={pfxPassword}
              disabled={!pfxPath || busy}
              onChange={(e) => setPfxPassword(e.target.value)}
            />
          </Field>
          {secretsOk ? (
            <Checkbox
              checked={rememberPfx}
              onChange={setRememberPfx}
              label={t('sign.signer.remember')}
              hint={t('sign.signer.rememberHint')}
              disabled={!pfxPath}
            />
          ) : (
            <p className="sign-note">
              <Lock size={13} aria-hidden /> {t('certs.noSecrets')}
            </p>
          )}
          <div className="sign-row">
            <Button
              loading={busy}
              disabled={!pfxPath}
              onClick={() => pfxPath && void readPfx(pfxPath, pfxPassword || undefined, false)}
            >
              {t('sign.signer.readCert')}
            </Button>
          </div>
          {cert && <CertCard info={cert} />}
        </>
      ) : (
        <>
          <div className="sign-row">
            <Button icon={<RefreshCw size={15} />} onClick={() => void scan()} disabled={busy}>
              {t('certs.scanDrivers')}
            </Button>
            <Button
              icon={<Stethoscope size={15} />}
              onClick={() => openDialog('tokenWizard', { modulePath })}
            >
              {t('certs.diagnose')}
            </Button>
          </div>
          <Select
            aria-label={t('sign.signer.driver')}
            value={modulePath ?? ''}
            options={[{ value: '', label: t('sign.signer.driverPick') }, ...driverOptions]}
            onChange={(v) => v && chooseDriver(v)}
          />
          <div className="sign-row">
            <Button loading={busy} disabled={!modulePath} onClick={() => void readTokens()}>
              {t('sign.signer.readTokens')}
            </Button>
          </div>
          {tokens !== null && tokens.length === 0 && (
            <p className="sign-note">{t('certs.noTokens')}</p>
          )}
          {tokens && tokens.length > 0 && (
            <div className="sign-grid">
              <Select
                aria-label={t('sign.signer.token')}
                value={String(slotId ?? '')}
                options={tokens.map((tk) => ({
                  value: String(tk.slotId),
                  label: tk.label || tk.slotDescription || `#${tk.slotId}`,
                }))}
                onChange={(v) => {
                  const next = tokens.find((tk) => String(tk.slotId) === v);
                  setSlotId(next?.slotId ?? null);
                  setCertId(next?.certificates.find((c) => !c.isCa)?.ckaId ?? null);
                  setPin('');
                }}
              />
              {tokenCerts.length > 0 && (
                <Select
                  aria-label={t('sign.signer.certificate')}
                  value={certId ?? ''}
                  options={tokenCerts.map((c) => ({
                    value: c.ckaId,
                    label: c.cert.identity.personName ?? c.cert.subjectCommonName ?? c.label,
                  }))}
                  onChange={(v) => setCertId(v)}
                />
              )}
            </div>
          )}
          {token && (
            <>
              {PIN_NOTE[token.pinState] && (
                <p
                  className={`sign-note ${token.pinState === 'locked' ? 'sign-note--danger' : 'sign-note--warn'}`}
                  role="alert"
                >
                  <TriangleAlert size={14} aria-hidden /> {t(PIN_NOTE[token.pinState]!)}
                </p>
              )}
              <Field
                label={t('sign.signer.pin')}
                htmlFor="sign-token-pin"
                hint={t('sign.signer.pinHint')}
              >
                <TextInput
                  id="sign-token-pin"
                  className="sign-pin"
                  type="password"
                  autoComplete="off"
                  inputMode="numeric"
                  value={pin}
                  disabled={token.pinState === 'locked' || busy}
                  onChange={(e) => setPin(e.target.value)}
                />
              </Field>
            </>
          )}
          {tokenCert && <CertCard info={tokenCert.cert} />}
        </>
      )}

      {error && (
        <div className="certs__error" role="alert">
          <CircleAlert size={16} aria-hidden />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
});
