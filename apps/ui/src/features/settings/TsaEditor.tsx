/**
 * Timestamp servers (I28): up to five http(s) URLs, tried in order. B-T and above need one.
 * The list is cleaned here and checked again by the main process before it is saved.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { useSettings } from '../../app/state/settings';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Field, TextInput } from '../../components/Form';
import { MAX_TSA_URLS, cleanTsaUrls } from '../sign/tsa';

export function TsaEditor() {
  const { t } = useTranslation();
  const saved = useSettings((s) => s.settings.tsaUrls);
  const update = useSettings((s) => s.update);
  const [rows, setRows] = useState<string[]>(saved.length > 0 ? saved : ['']);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const edit = (next: string[]) => {
    setRows(next);
    setDirty(true);
    setNote(null);
  };

  const save = async () => {
    const cleaned = cleanTsaUrls(rows);
    if (cleaned.invalid.length > 0) {
      setNote(t('settings.tsa.invalid', { list: cleaned.invalid.join(', ') }));
      return;
    }
    if (cleaned.tooMany) {
      setNote(t('settings.tsa.tooMany', { max: MAX_TSA_URLS }));
      return;
    }
    try {
      await update({ tsaUrls: cleaned.urls });
      setRows(cleaned.urls.length > 0 ? cleaned.urls : ['']);
      setDirty(false);
      setNote(t('settings.tsa.saved'));
    } catch (e) {
      setNote(errorMessage(e));
    }
  };

  return (
    <Field label={t('settings.tsa.label')} hint={t('settings.tsa.hint')}>
      <div className="settings__tsa">
        {rows.map((url, i) => (
          <div key={i} className="settings__tsa-row">
            <TextInput
              aria-label={t('settings.tsa.item', { n: i + 1 })}
              placeholder="https://"
              value={url}
              onChange={(e) => edit(rows.map((r, j) => (j === i ? e.target.value : r)))}
            />
            <IconButton
              label={t('settings.tsa.remove')}
              icon={<Trash2 size={14} />}
              onClick={() =>
                edit(rows.filter((_, j) => j !== i).concat(rows.length === 1 ? [''] : []))
              }
            />
          </div>
        ))}
        <div className="settings__links">
          <Button
            icon={<Plus size={14} />}
            disabled={rows.length >= MAX_TSA_URLS}
            onClick={() => edit([...rows, ''])}
          >
            {t('settings.tsa.add')}
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            {t('settings.tsa.save')}
          </Button>
        </div>
        {saved.length === 0 && (
          <p className="sign-note sign-note--warn">{t('settings.tsa.needed')}</p>
        )}
        {note && (
          <p className="sign-note" role="status">
            {note}
          </p>
        )}
      </div>
    </Field>
  );
}
