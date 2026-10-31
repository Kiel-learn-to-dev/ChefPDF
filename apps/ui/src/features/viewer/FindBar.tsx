import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CaseSensitive, ChevronDown, ChevronUp, Search, WholeWord, X } from 'lucide-react';
import clsx from 'clsx';
import { IconButton } from '../../components/Button';
import { useUi } from '../../app/state/ui';
import { getViewer } from './controllers';
import { useFind } from './findStore';

/** Ctrl+F search bar. Diacritics-insensitive by default ("nghi dinh" finds "nghị định"). */
export function FindBar({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTick = useUi((s) => s.findFocusTick);
  const { query, matchDiacritics, entireWord, caseSensitive, status, current, total, set } =
    useFind();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const search = (
    patch: Partial<{
      query: string;
      matchDiacritics: boolean;
      entireWord: boolean;
      caseSensitive: boolean;
    }>,
    type: '' | 'again' = '',
    findPrevious = false,
  ) => {
    const next = { query, matchDiacritics, entireWord, caseSensitive, ...patch };
    set({ ...patch, ...(next.query ? {} : { status: 'idle', current: 0, total: 0 }) });
    getViewer(docId)?.find({ ...next, type, findPrevious });
  };

  const close = () => {
    useUi.getState().set({ findOpen: false });
    getViewer(docId)?.container()?.focus();
  };

  const countText =
    !query || status === 'idle'
      ? ''
      : status === 'pending' && total === 0
        ? '…'
        : total === 0
          ? t('find.noResults')
          : t('find.count', { current, total });

  return (
    <div className="findbar" role="search" aria-label={t('find.label')}>
      <Search size={15} className="findbar__icon" aria-hidden />
      <input
        ref={inputRef}
        className="findbar__input"
        placeholder={t('find.placeholder')}
        aria-label={t('find.label')}
        value={query}
        spellCheck={false}
        onChange={(e) => search({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            search({}, 'again', e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      <span
        className={clsx(
          'findbar__count',
          query &&
            status !== 'pending' &&
            total === 0 &&
            status !== 'idle' &&
            'findbar__count--none',
        )}
        aria-live="polite"
      >
        {countText}
      </span>
      <IconButton
        size="sm"
        label={t('find.matchDiacritics')}
        icon={<span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>ă</span>}
        pressed={matchDiacritics}
        onClick={() => search({ matchDiacritics: !matchDiacritics })}
      />
      <IconButton
        size="sm"
        label={t('find.caseSensitive')}
        icon={<CaseSensitive size={16} />}
        pressed={caseSensitive}
        onClick={() => search({ caseSensitive: !caseSensitive })}
      />
      <IconButton
        size="sm"
        label={t('find.wholeWord')}
        icon={<WholeWord size={16} />}
        pressed={entireWord}
        onClick={() => search({ entireWord: !entireWord })}
      />
      <IconButton
        size="sm"
        label={t('find.previous')}
        shortcut="Shift+Enter"
        icon={<ChevronUp size={16} />}
        disabled={!total}
        onClick={() => search({}, 'again', true)}
      />
      <IconButton
        size="sm"
        label={t('find.next')}
        shortcut="Enter"
        icon={<ChevronDown size={16} />}
        disabled={!total}
        onClick={() => search({}, 'again')}
      />
      <IconButton
        size="sm"
        label={t('common.close')}
        shortcut="Escape"
        icon={<X size={15} />}
        onClick={close}
      />
    </div>
  );
}
