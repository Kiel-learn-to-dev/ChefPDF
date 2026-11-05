import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Info, Plus, Search, Settings, X } from 'lucide-react';
import { useDocs } from './state/documents';
import { useUi } from './state/ui';
import { closeDoc, openWithDialog } from './actions';
import { IconButton } from '../components/Button';
import { Tooltip } from '../components/Tooltip';
import { Kbd } from '../components/Kbd';
import { Logo } from './Logo';

/** Top bar: home, open documents as tabs (A2), palette and settings. */
export function DocumentTabs() {
  const { t } = useTranslation();
  const docs = useDocs((s) => s.docs);
  const activeId = useDocs((s) => s.activeId);
  const aboutOpen = useDocs((s) => s.aboutOpen);
  const activate = useDocs((s) => s.activate);
  const openAbout = useDocs((s) => s.openAbout);
  const set = useUi((s) => s.set);

  // The tabs in order: start, the documents, About. The arrow keys walk them.
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const count = docs.length + 2;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = Math.min(count - 1, index + 1);
    if (e.key === 'ArrowLeft') next = Math.max(0, index - 1);
    if (next === null) return;
    e.preventDefault();
    if (next === count - 1) openAbout();
    else activate(next === 0 ? null : (docs[next - 1]?.id ?? null));
    (
      e.currentTarget.parentElement?.parentElement?.children[next]?.querySelector(
        '[role=tab]',
      ) as HTMLElement | null
    )?.focus();
  };

  return (
    <header className="topbar">
      <div className="doctabs" role="tablist" aria-label={t('shell.documents')}>
        <div className="doctab-wrap">
          <button
            type="button"
            role="tab"
            aria-selected={activeId === null && !aboutOpen}
            tabIndex={activeId === null && !aboutOpen ? 0 : -1}
            className={clsx('doctab doctab--home', activeId === null && !aboutOpen && 'is-active')}
            onClick={() => activate(null)}
            onKeyDown={(e) => onKeyDown(e, 0)}
          >
            <Logo size={20} />
            <span className="doctab__brand">Chef PDF</span>
          </button>
        </div>
        {docs.map((d, i) => {
          const active = d.id === activeId && !aboutOpen;
          return (
            <div key={d.id} className={clsx('doctab-wrap', active && 'is-active')}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={clsx('doctab', active && 'is-active')}
                title={d.state.sourcePath ?? d.name}
                onClick={() => activate(d.id)}
                onAuxClick={(e) => e.button === 1 && void closeDoc(d.id)}
                onKeyDown={(e) => onKeyDown(e, i + 1)}
              >
                <span className="doctab__name">{d.name}</span>
                {d.state.dirty && (
                  <span className="doctab__dirty" aria-label={t('shell.unsaved')} />
                )}
              </button>
              <IconButton
                size="sm"
                className="doctab__close"
                label={t('shell.closeTab', { name: d.name })}
                icon={<X size={13} />}
                tooltip={false}
                tabIndex={-1}
                onClick={() => void closeDoc(d.id)}
              />
            </div>
          );
        })}
        <div className="doctab-wrap">
          <button
            type="button"
            role="tab"
            aria-selected={aboutOpen}
            tabIndex={aboutOpen ? 0 : -1}
            className={clsx('doctab doctab--about', aboutOpen && 'is-active')}
            onClick={() => openAbout()}
            onKeyDown={(e) => onKeyDown(e, docs.length + 1)}
          >
            <Info size={14} aria-hidden />
            <span className="doctab__label">{t('about.tab')}</span>
          </button>
        </div>
        <IconButton
          size="sm"
          className="doctabs__add"
          label={t('cmd.open')}
          shortcut="Mod+O"
          icon={<Plus size={16} />}
          onClick={() => void openWithDialog()}
        />
      </div>
      <div className="topbar__right">
        <Tooltip content={t('cmd.palette')} shortcut="Mod+K">
          <button
            type="button"
            className="topbar__search"
            onClick={() => set({ paletteOpen: true })}
          >
            <Search size={14} aria-hidden />
            <span>{t('palette.short')}</span>
            <Kbd keys="Mod+K" />
          </button>
        </Tooltip>
        <IconButton
          label={t('cmd.settings')}
          shortcut="Mod+,"
          icon={<Settings size={17} />}
          onClick={() => useUi.getState().openDialog('settings')}
        />
      </div>
    </header>
  );
}
