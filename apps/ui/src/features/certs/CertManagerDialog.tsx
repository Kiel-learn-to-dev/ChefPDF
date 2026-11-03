import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import clsx from 'clsx';
import {
  CircleAlert,
  FileKey,
  FolderOpen,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  Trash,
  TriangleAlert,
  Usb,
} from 'lucide-react';
import type {
  CertInfoData,
  DriverConfidence,
  DriverRow,
  KnownPfxFile,
  PinState,
  TokenInfo,
} from '@chef/contracts';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox, Field, Segmented, TextInput } from '../../components/Form';
import { Badge } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { isPasswordProblem, toChefError } from '../../lib/errors';
import { CertCard } from './CertCard';
import { listTokens, readCertificate, scanDrivers } from './certOps';
import { fileNameOf, findKnownPfx, removeKnownPfx, setRemembered, upsertKnownPfx } from './pfxList';
import { isSelectable, probeSummary, sortDrivers } from './driverList';
import './certs.css';

/** Path comparison follows the OS: Windows and macOS ignore case. */
function usePathCompare() {
  const platform = chef().app.platform;
  return { caseInsensitive: platform === 'win32' || platform === 'darwin' };
}

/** T3.04 + T3.02 + T3.03 entry point: certificate files, USB tokens and the token check. */
export function CertManagerDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [section, setSection] = useState<'file' | 'token'>('file');
  const [secretsOk, setSecretsOk] = useState(false);

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

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<KeyRound size={18} />}
      title={t('certs.title')}
      description={t('certs.description')}
      size="lg"
    >
      <Segmented<'file' | 'token'>
        aria-label={t('certs.title')}
        value={section}
        onChange={setSection}
        options={[
          { value: 'file', label: t('certs.sectionFile'), icon: <FileKey size={14} /> },
          { value: 'token', label: t('certs.sectionToken'), icon: <Usb size={14} /> },
        ]}
      />
      {section === 'file' ? <PfxSection secretsAvailable={secretsOk} /> : <TokenSection />}
    </Dialog>
  );
}

// ---------- (a) .pfx / .p12 files ----------

function PfxSection({ secretsAvailable }: { secretsAvailable: boolean }) {
  const { t } = useTranslation();
  const known = useSettings((s) => s.settings.knownPfxFiles);
  const update = useSettings((s) => s.update);
  const cmp = usePathCompare();
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [info, setInfo] = useState<CertInfoData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveList = async (list: KnownPfxFile[]) => {
    await update({ knownPfxFiles: list });
  };
  const currentList = () => useSettings.getState().settings.knownPfxFiles;

  async function read(
    filePath: string,
    pw: string | undefined,
    keepSecret: boolean,
    fromSecret: boolean,
  ) {
    setBusy(true);
    setError(null);
    try {
      const data = await readCertificate(filePath, pw, t('certs.readJob'));
      setPath(filePath);
      setInfo(data);
      const wasRemembered = findKnownPfx(currentList(), filePath, cmp)?.remembered ?? false;
      let remembered = false;
      if (keepSecret && secretsAvailable && pw) {
        await chef().secrets.set(filePath, pw);
        remembered = true;
      } else if (wasRemembered) {
        // The user unticked "remember": forget the saved password.
        await chef().secrets.delete(filePath);
      }
      setPassword('');
      setRemember(remembered);
      await saveList(upsertKnownPfx(currentList(), filePath, cmp, { remembered }));
    } catch (e) {
      const err = toChefError(e);
      setInfo(null);
      if (fromSecret && isPasswordProblem(err.kind)) {
        // The saved password no longer works: drop it so the user types it again.
        await chef()
          .secrets.delete(filePath)
          .catch(() => undefined);
        await saveList(setRemembered(currentList(), filePath, false, cmp)).catch(() => undefined);
        setRemember(false);
        setError(t('certs.savedPasswordWrong'));
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const pick = async () => {
    const [picked] = await chef().files.openDialog({
      multiple: false,
      filters: [{ name: t('certs.pfxFilter'), extensions: ['pfx', 'p12'] }],
    });
    if (!picked) return;
    setPath(picked);
    setInfo(null);
    setError(null);
    setPassword('');
    setRemember(findKnownPfx(currentList(), picked, cmp)?.remembered ?? false);
  };

  const openSaved = async (entry: KnownPfxFile) => {
    setError(null);
    setPath(entry.path);
    setInfo(null);
    if (entry.remembered && secretsAvailable) {
      const saved = await chef().secrets.get(entry.path);
      if (saved !== null) {
        await read(entry.path, saved, true, true);
        return;
      }
      // Nothing usable in the keychain any more.
      await saveList(setRemembered(currentList(), entry.path, false, cmp)).catch(() => undefined);
      setError(t('certs.savedPasswordMissing'));
    }
    setPassword('');
    setRemember(false);
  };

  const removeEntry = async (entry: KnownPfxFile) => {
    if (entry.remembered)
      await chef()
        .secrets.delete(entry.path)
        .catch(() => undefined);
    await saveList(removeKnownPfx(currentList(), entry.path, cmp));
    if (path && findKnownPfx([entry], path, cmp)) {
      setPath(null);
      setInfo(null);
    }
  };

  const showError = (message: string) => (
    <div className="certs__error" role="alert">
      <CircleAlert size={16} aria-hidden />
      <span>{message}</span>
    </div>
  );

  return (
    <div className="certs__section">
      <div className="certs__pick">
        <Button icon={<FolderOpen size={15} />} onClick={() => void pick()} disabled={busy}>
          {t('certs.pickPfx')}
        </Button>
        <span className="certs__file" title={path ?? undefined}>
          {path ? fileNameOf(path) : t('certs.noFile')}
        </span>
      </div>

      <Field label={t('certs.password')} htmlFor="pfx-password">
        <TextInput
          id="pfx-password"
          type="password"
          autoComplete="off"
          value={password}
          disabled={!path || busy}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && path && !busy) {
              void read(path, password || undefined, remember && secretsAvailable, false);
            }
          }}
        />
      </Field>

      {secretsAvailable ? (
        <Checkbox
          checked={remember}
          onChange={setRemember}
          label={t('certs.remember')}
          hint={t('certs.rememberHint')}
          disabled={!path}
        />
      ) : (
        <p className="certs__note">
          <Lock size={14} aria-hidden /> {t('certs.noSecrets')}
        </p>
      )}

      <div className="certs__actions">
        <Button
          variant="primary"
          loading={busy}
          disabled={!path}
          onClick={() =>
            path && void read(path, password || undefined, remember && secretsAvailable, false)
          }
        >
          {t('certs.read')}
        </Button>
      </div>

      {error && showError(error)}
      {info && <CertCard info={info} />}

      <section className="certs__saved" aria-labelledby="certs-saved-title">
        <h3 id="certs-saved-title" className="certs__heading">
          {t('certs.savedFiles')}
        </h3>
        {known.length === 0 ? (
          <p className="certs__note">{t('certs.noSaved')}</p>
        ) : (
          <ul className="certs__list">
            {known.map((entry) => (
              <li key={entry.path} className="certs__saved-item">
                <div className="certs__saved-main">
                  <span className="certs__saved-label">{entry.label}</span>
                  <span className="certs__saved-path" title={entry.path}>
                    {entry.path}
                  </span>
                </div>
                {entry.remembered && <Badge tone="accent">{t('certs.rememberedBadge')}</Badge>}
                <Button onClick={() => void openSaved(entry)} disabled={busy}>
                  {t('certs.open')}
                </Button>
                <IconButton
                  label={t('certs.remove')}
                  icon={<Trash size={14} />}
                  onClick={() => void removeEntry(entry)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------- (b) USB token: drivers and tokens ----------

const CONFIDENCE_LABEL: Record<DriverConfidence, (t: TFunction) => string> = {
  documented: (t) => t('certs.confidence.documented'),
  reported: (t) => t('certs.confidence.reported'),
  unverified: (t) => t('certs.confidence.unverified'),
};

function pinLabel(t: TFunction, state: PinState): string {
  switch (state) {
    case 'ok':
      return t('certs.pin.ok');
    case 'count_low':
      return t('certs.pin.countLow');
    case 'final_try':
      return t('certs.pin.finalTry');
    case 'locked':
      return t('certs.pin.locked');
    case 'to_be_changed':
      return t('certs.pin.toBeChanged');
  }
}

function TokenSection() {
  const { t } = useTranslation();
  const openDialog = useUi((s) => s.openDialog);
  const lastDriver = useSettings((s) => s.settings.lastDriverPath);
  const update = useSettings((s) => s.update);
  const [drivers, setDrivers] = useState<DriverRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [chosen, setChosen] = useState<string | null>(lastDriver);
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (modulePath: string) => {
    setChosen(modulePath);
    setTokens(null);
    update({ lastDriverPath: modulePath }).catch((e: unknown) => setError(errorMessage(e)));
  };

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const data = await scanDrivers(t('certs.scanJob'));
      setDrivers(sortDrivers(data.drivers));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const pickFile = async () => {
    const [picked] = await chef().files.openDialog({
      multiple: false,
      filters: [{ name: t('certs.driverFilter'), extensions: ['dll', 'so', 'dylib'] }],
    });
    if (picked) choose(picked);
  };

  const readTokens = async () => {
    if (!chosen) return;
    setReading(true);
    setError(null);
    try {
      const data = await listTokens(chosen, t('certs.readTokensJob'));
      setTokens(data.tokens);
    } catch (e) {
      setTokens(null);
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="certs__section">
      <div className="certs__actions">
        <Button
          icon={scanning ? undefined : <RefreshCw size={15} />}
          loading={scanning}
          onClick={() => void scan()}
        >
          {t('certs.scanDrivers')}
        </Button>
        <Button icon={<FolderOpen size={15} />} onClick={() => void pickFile()}>
          {t('certs.chooseDriverFile')}
        </Button>
      </div>

      {drivers === null ? (
        <p className="certs__note">{t('certs.scanHint')}</p>
      ) : drivers.length === 0 ? (
        <p className="certs__note">{t('certs.noDrivers')}</p>
      ) : (
        <>
          <p className="certs__note">{t('certs.selectHint')}</p>
          <ul className="certs__drivers">
            {drivers.map((row) => {
              const selectable = isSelectable(row);
              const probe = probeSummary(row.probe);
              const selected = chosen === row.path;
              return (
                <li key={`${row.caId}-${row.modelId}-${row.path}`}>
                  <button
                    type="button"
                    className={clsx(
                      'driver-row',
                      !selectable && 'driver-row--missing',
                      selected && 'is-selected',
                    )}
                    disabled={!selectable}
                    aria-pressed={selected}
                    onClick={() => selectable && choose(row.path)}
                  >
                    <span className="driver-row__head">
                      <strong>{row.ca}</strong>
                      <span className="driver-row__model">{row.model}</span>
                      <Badge>{CONFIDENCE_LABEL[row.confidence](t)}</Badge>
                      <Badge tone={selectable ? 'accent' : 'neutral'}>
                        {selectable ? t('certs.driverFound') : t('certs.driverMissing')}
                      </Badge>
                    </span>
                    <span className="driver-row__path">{row.path}</span>
                    {probe.kind === 'labels' && (
                      <span className="driver-row__probe">
                        {probe.labels.length > 0
                          ? t('certs.tokensSeen', { labels: probe.labels.join(', ') })
                          : t('certs.noTokenSeen')}
                      </span>
                    )}
                    {probe.kind === 'error' && (
                      <span className="driver-row__probe driver-row__probe--error">
                        {t('certs.probeError', { reason: probe.reason ?? probe.errorKind ?? '' })}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p className="certs__note">
        {chosen ? t('certs.chosenDriver', { path: chosen }) : t('certs.noChosenDriver')}
      </p>

      <div className="certs__actions">
        <Button
          variant="primary"
          loading={reading}
          disabled={!chosen}
          onClick={() => void readTokens()}
        >
          {t('certs.readTokens')}
        </Button>
        <Button
          icon={<Stethoscope size={15} />}
          onClick={() => openDialog('tokenWizard', { modulePath: chosen })}
        >
          {t('certs.diagnose')}
        </Button>
      </div>

      {error && (
        <div className="certs__error" role="alert">
          <CircleAlert size={16} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {tokens !== null && tokens.length === 0 && (
        <p className="certs__note">{t('certs.noTokens')}</p>
      )}
      {tokens?.map((token) => (
        <TokenCard key={`${token.slotId}-${token.serial}`} token={token} />
      ))}
    </div>
  );
}

function TokenCard({ token }: { token: TokenInfo }) {
  const { t } = useTranslation();
  const signers = token.certificates.filter((c) => !c.isCa);
  const locked = token.pinState === 'locked';
  const warn = token.pinState !== 'ok';
  return (
    <article className="token-card">
      <header className="token-card__head">
        <Usb size={18} aria-hidden />
        <strong>{token.label || t('certs.token.unnamed')}</strong>
        <span className="token-card__maker">
          {[token.manufacturer, token.model].filter(Boolean).join(' · ')}
        </span>
      </header>
      {token.serial && (
        <p className="certs__note">
          {t('certs.token.serial')}: <span className="cert-card__mono">{token.serial}</span>
        </p>
      )}
      <p
        className={clsx(
          'pin-note',
          warn ? (locked ? 'pin-note--danger' : 'pin-note--warn') : 'pin-note--ok',
        )}
        role={warn ? 'alert' : undefined}
      >
        {warn ? <ShieldAlert size={16} aria-hidden /> : <Lock size={14} aria-hidden />}
        <span>{pinLabel(t, token.pinState)}</span>
      </p>
      {!token.initialized && <p className="pin-note pin-note--warn">{t('certs.token.notInit')}</p>}
      {token.unreadableObjects > 0 && (
        <p className="certs__note">
          <TriangleAlert size={14} aria-hidden />{' '}
          {t('certs.token.unreadable', { count: token.unreadableObjects })}
        </p>
      )}
      <h4 className="certs__heading">{t('certs.token.certs')}</h4>
      {signers.length === 0 ? (
        <p className="certs__note">{t('certs.token.noCerts')}</p>
      ) : (
        signers.map((c) => <CertCard key={c.ckaId} info={c.cert} />)
      )}
      <p className="certs__note">
        <Lock size={13} aria-hidden /> {t('certs.noPinHere')}
      </p>
    </article>
  );
}
