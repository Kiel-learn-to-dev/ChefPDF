/**
 * The About tab (1.2): what this copy is (version, core, runtime), that it is for personal use, and
 * the two folders that used to sit in the Help menu: the logs and the data folder.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chef } from '../../lib/bridge';
import { call } from '../../lib/rpc';
import { Button } from '../../components/Button';
import { Logo } from '../../app/Logo';
import './about.css';

interface CoreInfo {
  version: string;
  python: string;
}

export function AboutScreen() {
  const { t } = useTranslation();
  const [core, setCore] = useState<CoreInfo | null>(null);
  const [coreError, setCoreError] = useState(false);
  const app = chef().app;

  useEffect(() => {
    let alive = true;
    call('system.ping', {})
      .then((info) => alive && setCore(info))
      .catch(() => alive && setCoreError(true));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="about" aria-labelledby="about-title">
      <div className="about__card">
        <Logo size={48} />
        <h1 id="about-title" className="about__title">
          Chef PDF
        </h1>
        <p className="about__version" data-testid="about-version">
          {t('about.version', { version: app.version })}
        </p>
        <p className="about__note">{t('about.personal')}</p>

        <dl className="about__facts">
          <dt>{t('about.core')}</dt>
          <dd data-testid="about-core">
            {core
              ? t('about.coreValue', { version: core.version, python: core.python })
              : coreError
                ? t('about.coreError')
                : t('about.coreLoading')}
          </dd>
          <dt>{t('about.runtime')}</dt>
          <dd data-testid="about-runtime">
            {t('about.runtimeValue', {
              electron: app.versions.electron,
              chrome: app.versions.chrome,
              node: app.versions.node,
            })}
          </dd>
          <dt>{t('about.licences')}</dt>
          <dd>{t('about.licencesValue')}</dd>
        </dl>

        <div className="about__actions">
          <Button variant="ghost" onClick={() => void app.openLogs()}>
            {t('about.openLogs')}
          </Button>
          <Button variant="ghost" onClick={() => void app.openDataDir()}>
            {t('about.openDataDir')}
          </Button>
        </div>
      </div>
    </main>
  );
}
