import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Monitor, Moon, Settings as SettingsIcon, Sun } from 'lucide-react';
import type { LanguageSetting, ThemeSetting } from '@chef/contracts';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { pickFolder, showError } from '../../app/actions';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button } from '../../components/Button';
import { Field, Segmented, Select, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { LANGUAGES } from '../../i18n';
import './SettingsDialog.css';

/** A4: language, theme, default save folder. Persisted via chef.settings.set. */
export function SettingsDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [dir, setDir] = useState(settings.defaultSaveDir ?? '');

  const save = (patch: Parameters<typeof update>[0]) =>
    update(patch).catch((e: unknown) => showError(e));
  const commitDir = (value: string) => {
    const v = value.trim() || null;
    if (v !== settings.defaultSaveDir) void save({ defaultSaveDir: v });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          commitDir(dir);
          close();
        }
      }}
      icon={<SettingsIcon size={18} />}
      title={t('settings.title')}
      footer={
        <>
          <span className="muted settings__version">
            {t('settings.version', { version: chef().app.version })}
          </span>
          <DialogSpacer />
          <Button
            variant="primary"
            onClick={() => {
              commitDir(dir);
              close();
            }}
          >
            {t('common.done')}
          </Button>
        </>
      }
    >
      <section className="settings__section">
        <h3 className="settings__heading">{t('settings.general')}</h3>
        <Field label={t('settings.language')} htmlFor="set-lang">
          <Select<LanguageSetting>
            id="set-lang"
            value={settings.language}
            onChange={(language) => void save({ language })}
            options={LANGUAGES}
            aria-label={t('settings.language')}
          />
        </Field>
        <Field label={t('settings.theme')}>
          <Segmented<ThemeSetting>
            aria-label={t('settings.theme')}
            value={settings.theme}
            onChange={(theme) => void save({ theme })}
            options={[
              { value: 'system', label: t('settings.themeSystem'), icon: <Monitor size={14} /> },
              { value: 'light', label: t('settings.themeLight'), icon: <Sun size={14} /> },
              { value: 'dark', label: t('settings.themeDark'), icon: <Moon size={14} /> },
            ]}
          />
        </Field>
      </section>
      <section className="settings__section">
        <h3 className="settings__heading">{t('settings.files')}</h3>
        <Field
          label={t('settings.defaultSaveDir')}
          htmlFor="set-dir"
          hint={t('settings.defaultSaveDirHint')}
        >
          <div className="field__row">
            <TextInput
              id="set-dir"
              value={dir}
              placeholder={t('settings.defaultSaveDirPlaceholder')}
              onChange={(e) => setDir(e.target.value)}
              onBlur={() => commitDir(dir)}
            />
            <Button
              icon={<FolderOpen size={15} />}
              onClick={() =>
                void pickFolder().then((d) => {
                  if (d) {
                    setDir(d);
                    commitDir(d);
                  }
                })
              }
            >
              {t('common.browse')}
            </Button>
          </div>
        </Field>
        {settings.recentFiles.length > 0 && (
          <Field label={t('settings.recent')}>
            <div>
              <Button size="sm" onClick={() => void save({ recentFiles: [] })}>
                {t('settings.clearRecent', { count: settings.recentFiles.length })}
              </Button>
            </div>
          </Field>
        )}
      </section>
    </Dialog>
  );
}
