import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, FolderOpen, ShieldCheck, Trash2 } from 'lucide-react';
import type { TrustEntry } from '@chef/contracts';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Select } from '../../components/Form';
import { Badge } from '../../components/Misc';
import { toChefError } from '../../lib/errors';
import { addTrust, listTrust, pickTrustFiles, removeTrust } from './trustOps';
import {
  TRUST_GROUPS,
  canRemove,
  expiresWithin,
  expiryText,
  groupLabelKey,
  sortTrust,
  type TrustGroup,
} from './trustModel';
import { commonNameOf } from './verifyModel';
import './signatures.css';

/** Trust store (I35): Root CA lists shipped with the app plus the certificates the user added. */
export function TrustDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [entries, setEntries] = useState<TrustEntry[]>([]);
  const [group, setGroup] = useState<TrustGroup>('user');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(sortTrust(await listTrust(t('sig.trust.listJob'))));
      setError(null);
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let alive = true;
    listTrust(t('sig.trust.listJob'))
      .then((list) => {
        if (!alive) return;
        setEntries(sortTrust(list));
        setError(null);
      })
      .catch((e) => alive && setError(errorMessage(toChefError(e))))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [t]);

  const add = async () => {
    try {
      const [picked] = await pickTrustFiles();
      if (!picked) return;
      await addTrust({ path: picked, group }, t('sig.trust.addJob'));
      await reload();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    }
  };

  const remove = async (entry: TrustEntry) => {
    try {
      await removeTrust(entry.fingerprintSha256, t('sig.trust.removeJob'));
      await reload();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    }
  };

  const now = new Date();

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<ShieldCheck size={18} />}
      title={t('sig.trust.title')}
      description={t('sig.trust.description')}
      size="lg"
    >
      <div className="trust">
        <div className="trust__add">
          <Select<TrustGroup>
            aria-label={t('sig.trust.group.label')}
            value={group}
            onChange={setGroup}
            options={TRUST_GROUPS.map((g) => ({ value: g, label: t(groupLabelKey(g)) }))}
          />
          <Button icon={<FolderOpen size={15} />} onClick={() => void add()}>
            {t('sig.trust.add')}
          </Button>
        </div>

        {error && (
          <p className="trust__error" role="alert">
            <CircleAlert size={14} aria-hidden /> {error}
          </p>
        )}

        {loading ? (
          <p role="status">{t('sig.trust.loading')}</p>
        ) : entries.length === 0 ? (
          <p>{t('sig.trust.empty')}</p>
        ) : (
          <table className="trust__table">
            <thead>
              <tr>
                <th scope="col">{t('sig.trust.col.name')}</th>
                <th scope="col">{t('sig.trust.col.group')}</th>
                <th scope="col">{t('sig.trust.col.expiry')}</th>
                <th scope="col">
                  <span className="sr-only">{t('sig.trust.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const soon = expiresWithin(e.notAfter, 90, now);
                return (
                  <tr key={e.fingerprintSha256} data-source={e.source}>
                    <td>
                      <div>{commonNameOf(e.subject)}</div>
                      <div title={e.fingerprintSha256}>
                        <Badge>
                          {e.source === 'bundled' ? t('sig.trust.bundled') : t('sig.trust.yours')}
                        </Badge>
                      </div>
                    </td>
                    <td>{t(groupLabelKey(e.group))}</td>
                    <td>
                      {expiryText(e.notAfter)}
                      {soon && <div>{t('sig.trust.expiringSoon')}</div>}
                    </td>
                    <td>
                      {canRemove(e) && (
                        <IconButton
                          label={t('sig.trust.remove')}
                          icon={<Trash2 size={15} />}
                          onClick={() => void remove(e)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
