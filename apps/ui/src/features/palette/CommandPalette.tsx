import { useEffect, useMemo, useRef, useState } from 'react';
import * as RD from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Search } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { useCommands, type Command } from '../../app/commands';
import { Kbd } from '../../components/Kbd';
import { Badge } from '../../components/Misc';
import { rankMatches } from './match';
import './CommandPalette.css';

const HIDDEN = new Set(['app.palette', 'app.nextTab', 'app.prevTab']);

/** Ctrl/Cmd+K command palette (A3), diacritics-insensitive ("ky so" → "Ký số"). */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const set = useUi((s) => s.set);
  return (
    <RD.Root open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      {/* Mounted only while open, so the query starts empty each time. */}
      {open && <PaletteContent />}
    </RD.Root>
  );
}

function PaletteContent() {
  const { t } = useTranslation();
  const set = useUi((s) => s.set);
  const commands = useCommands();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const visible = commands.filter(
      (c) => !HIDDEN.has(c.id) && (c.enabled || c.comingSoon || query),
    );
    const ranked = rankMatches(query, visible);
    // Enabled first, then disabled / coming soon.
    return [...ranked.filter((c) => c.enabled), ...ranked.filter((c) => !c.enabled)].slice(0, 50);
  }, [commands, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c || !c.enabled) return;
    set({ paletteOpen: false });
    // Let the dialog close (and return focus) before running.
    setTimeout(() => c.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Home' && e.ctrlKey) {
      setActive(0);
    }
  };

  const activeId = results[active] ? `cmd-${results[active].id}` : undefined;

  return (
    <>
      <RD.Portal>
        <RD.Overlay className="dlg-overlay palette-overlay" />
        <RD.Content className="palette" aria-describedby={undefined} onKeyDown={onKeyDown}>
          <RD.Title className="sr-only">{t('palette.title')}</RD.Title>
          <div className="palette__search">
            <Search size={17} aria-hidden />
            <input
              autoFocus
              className="palette__input"
              placeholder={t('palette.placeholder')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={activeId}
              aria-label={t('palette.title')}
              spellCheck={false}
            />
            <Kbd keys="Escape" />
          </div>
          <ul
            ref={listRef}
            id="palette-list"
            className="palette__list"
            role="listbox"
            aria-label={t('palette.results')}
          >
            {results.length === 0 && <li className="palette__empty">{t('palette.noResults')}</li>}
            {results.map((c, i) => (
              <li
                key={c.id}
                id={`cmd-${c.id}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                aria-disabled={!c.enabled}
                className={clsx(
                  'palette__item',
                  i === active && 'is-active',
                  !c.enabled && 'is-disabled',
                )}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="palette__icon">{c.icon}</span>
                <span className="palette__title">{c.title}</span>
                {!c.comingSoon && (
                  <span className="palette__group">{t(`palette.group.${c.group}`)}</span>
                )}
                {c.comingSoon && <Badge tone="accent">{t('common.comingSoon')}</Badge>}
                {c.shortcut && c.enabled && <Kbd keys={c.shortcut} />}
              </li>
            ))}
          </ul>
          <div className="palette__footer">
            <span>
              <Kbd keys="ArrowUp" /> <Kbd keys="ArrowDown" /> {t('palette.navigate')}
            </span>
            <span>
              <Kbd keys="Enter" /> {t('palette.run')}
            </span>
            <span className="palette__tip">{t('palette.tip')}</span>
          </div>
        </RD.Content>
      </RD.Portal>
    </>
  );
}
