import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  Clock,
  Combine,
  Hash,
  Layers,
  FileText,
  FolderOpen,
  ScanLine,
  Shrink,
  Split,
  Stamp,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useSettings } from '../../app/state/settings';
import { useUi } from '../../app/state/ui';
import { useDocs } from '../../app/state/documents';
import { openFiles, openWithDialog, PDF_FILTERS } from '../../app/actions';
import { IconButton } from '../../components/Button';
import { Badge } from '../../components/Misc';
import { Kbd } from '../../components/Kbd';
import { chef } from '../../lib/bridge';
import { formatRelative } from '../../lib/format';
import { dirname } from '../../lib/path';
import { Logo } from '../../app/Logo';
import { openScanFlow } from '../scan/ScanDialog';
import './StartScreen.css';

interface Tile {
  id: string;
  title: string;
  text: string;
  icon: ReactNode;
  tone: 'blue' | 'green' | 'violet' | 'amber' | 'rose' | 'teal' | 'slate';
  onClick?(): void;
}

async function splitFlow() {
  const docs = useDocs.getState();
  if (!docs.activeId) {
    const [path] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTERS });
    if (!path) return;
    await openFiles([path]);
  }
  if (useDocs.getState().activeId) useUi.getState().openDialog('split');
}

/** A1: start screen with task tiles, recent files and drag-and-drop hint. */
export function StartScreen() {
  const { t, i18n } = useTranslation();
  const recent = useSettings((s) => s.settings.recentFiles);
  const update = useSettings((s) => s.update);

  const tiles: Tile[] = [
    {
      id: 'open',
      title: t('start.open'),
      text: t('start.openText'),
      icon: <FolderOpen size={22} />,
      tone: 'blue',
      onClick: () => void openWithDialog(),
    },
    {
      id: 'merge',
      title: t('start.merge'),
      text: t('start.mergeText'),
      icon: <Combine size={22} />,
      tone: 'green',
      onClick: () => useUi.getState().openDialog('merge'),
    },
    {
      id: 'split',
      title: t('start.split'),
      text: t('start.splitText'),
      icon: <Split size={22} />,
      tone: 'violet',
      onClick: () => void splitFlow(),
    },
    {
      id: 'scan',
      title: t('start.scanTitle'),
      text: t('start.scanText'),
      icon: <ScanLine size={22} />,
      tone: 'amber',
      onClick: () => void openScanFlow(),
    },
    {
      id: 'batchSign',
      title: t('start.batchSignTitle'),
      text: t('start.batchSignText'),
      icon: <Layers size={22} />,
      tone: 'rose',
      onClick: () => useUi.getState().openDialog('batchSign'),
    },
    {
      id: 'bates',
      title: t('start.batesTitle'),
      text: t('start.batesText'),
      icon: <Hash size={22} />,
      tone: 'violet',
      onClick: () => useUi.getState().openDialog('overlayBates'),
    },
    {
      id: 'stamp',
      title: t('soon.stamp'),
      text: t('start.stampText'),
      icon: <Stamp size={22} />,
      tone: 'teal',
    },
    {
      id: 'compress',
      title: t('soon.compress'),
      text: t('start.compressText'),
      icon: <Shrink size={22} />,
      tone: 'slate',
    },
  ];

  return (
    <div className="start">
      <div className="start__inner">
        <header className="start__hero">
          <Logo size={44} />
          <div>
            <h1 className="start__title">{t('start.title')}</h1>
            <p className="start__subtitle">{t('start.subtitle')}</p>
          </div>
        </header>

        <section aria-labelledby="start-tasks">
          <h2 id="start-tasks" className="start__section-title">
            {t('start.tasks')}
          </h2>
          <ul className="start__tiles">
            {tiles.map((tile) => {
              const disabled = !tile.onClick;
              return (
                <li key={tile.id}>
                  <button
                    type="button"
                    className={clsx('tile', `tile--${tile.tone}`, disabled && 'is-disabled')}
                    onClick={tile.onClick}
                    disabled={disabled}
                    aria-describedby={`tile-${tile.id}-text`}
                  >
                    <span className="tile__icon">{tile.icon}</span>
                    <span className="tile__title">
                      {tile.title}
                      {disabled && <Badge>{t('common.comingSoonShort')}</Badge>}
                    </span>
                    <span id={`tile-${tile.id}-text`} className="tile__text">
                      {tile.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="start-recent" className="start__recent">
          <h2 id="start-recent" className="start__section-title">
            {t('start.recent')}
          </h2>
          {recent.length === 0 ? (
            <div className="start__drop">
              <FileText size={20} aria-hidden />
              <span>{t('start.dropHint')}</span>
            </div>
          ) : (
            <ul className="recent">
              {recent.slice(0, 8).map((r) => (
                <li key={r.path} className="recent__item">
                  <button
                    type="button"
                    className="recent__open"
                    onClick={() => void openFiles([r.path])}
                    title={r.path}
                  >
                    <span className="recent__icon">
                      <FileText size={18} />
                    </span>
                    <span className="recent__name">{r.name}</span>
                    <span className="recent__dir">{dirname(r.path)}</span>
                    <span className="recent__time">
                      <Clock size={12} aria-hidden /> {formatRelative(r.openedAt, i18n.language)}
                    </span>
                  </button>
                  <IconButton
                    size="sm"
                    className="recent__remove"
                    label={t('start.removeRecent')}
                    icon={<X size={14} />}
                    onClick={() =>
                      void update({ recentFiles: recent.filter((x) => x.path !== r.path) })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <footer className="start__footer">
          <span>
            {t('start.paletteHint')} <Kbd keys="Mod+K" />
          </span>
          {recent.length > 0 && <span>{t('start.dropHintShort')}</span>}
        </footer>
      </div>
    </div>
  );
}
