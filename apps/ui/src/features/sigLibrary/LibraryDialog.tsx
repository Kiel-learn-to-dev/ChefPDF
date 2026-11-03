import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  FileImage,
  Library,
  Pencil,
  PenLine,
  Palette,
  Smartphone,
  Trash2,
  TriangleAlert,
  Type,
  X,
} from 'lucide-react';
import type { LibraryItem, LibraryStatus } from '@chef/contracts';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextInput } from '../../components/Form';
import { Badge, EmptyState } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { DrawFlow, ImageFlow, TypeFlow, type FlowProps } from './LibraryFlows';
import { SeparateFlow } from './SeparateFlow';
import { NAME_MAX, itemName } from './libraryModel';
import './sigLibrary.css';

type View = 'list' | 'image' | 'draw' | 'type' | 'separate';

/** Object URL of a decrypted item, revoked when the card goes away. */
export function LibraryThumb({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    void chef()
      .library.get(id)
      .then((bytes) => {
        if (!alive) return;
        made = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        setUrl(made);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  return (
    <div className="lib-thumb" aria-hidden={url ? undefined : true}>
      {url && <img className="lib-thumb__img" src={url} alt={alt} />}
    </div>
  );
}

/** Dialog "Thư viện chữ ký & con dấu" (I19-I23). */
export function LibraryDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  // A photo taken with the phone (capture dialog) opens the image flow with that photo.
  const [seedImage] = useState<string | null>(
    () => (useUi.getState().dialogData as { seedImage?: string } | undefined)?.seedImage ?? null,
  );
  const [view, setView] = useState<View>(seedImage ? 'image' : 'list');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [separating, setSeparating] = useState<LibraryItem | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await chef().library.list());
      setError(null);
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void chef()
      .library.list()
      .then((list) => alive && setItems(list))
      .catch((e) => alive && setError(errorMessage(toChefError(e))));
    void chef()
      .library.status()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus({ encrypted: false }));
    return () => {
      alive = false;
    };
  }, []);

  const back = () => {
    setView('list');
    void reload();
  };

  const rename = async () => {
    if (!renaming) return;
    try {
      await chef().library.rename(renaming.id, itemName(renaming.value, renaming.value));
      setRenaming(null);
      await reload();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    }
  };

  const remove = async (item: LibraryItem) => {
    try {
      await chef().library.remove(item.id);
      await reload();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    }
  };

  const flowProps: FlowProps = { onSaved: back, onCancel: back };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<Library size={18} />}
      title={t('lib.title')}
      description={t('lib.description')}
      size="xl"
    >
      <div className="lib">
        {status && !status.encrypted && (
          <p className="lib__warning" role="alert">
            <TriangleAlert size={15} aria-hidden /> {t('lib.plainWarning')}
          </p>
        )}
        {error && (
          <p className="lib__error" role="alert">
            {error}
          </p>
        )}

        {view === 'list' && (
          <>
            <div className="lib__add" role="group" aria-label={t('lib.add')}>
              <Button size="sm" icon={<FileImage size={15} />} onClick={() => setView('image')}>
                {t('lib.fromImage')}
              </Button>
              <Button size="sm" icon={<PenLine size={15} />} onClick={() => setView('draw')}>
                {t('lib.draw')}
              </Button>
              <Button size="sm" icon={<Type size={15} />} onClick={() => setView('type')}>
                {t('lib.type')}
              </Button>
              <Button
                size="sm"
                icon={<Smartphone size={15} />}
                onClick={() => useUi.getState().openDialog('capture', { purpose: 'signature' })}
              >
                {t('lib.phone')}
              </Button>
            </div>

            {items.length === 0 ? (
              <EmptyState
                icon={<Library size={22} />}
                title={t('lib.emptyTitle')}
                text={t('lib.emptyText')}
              />
            ) : (
              <ul className="lib__grid" aria-label={t('lib.listLabel')}>
                {items.map((item) => (
                  <li key={item.id} className="lib-card">
                    <LibraryThumb id={item.id} alt={item.name} />
                    {renaming?.id === item.id ? (
                      <div className="lib-card__rename">
                        <TextInput
                          size="sm"
                          aria-label={t('lib.rename')}
                          value={renaming.value}
                          maxLength={NAME_MAX}
                          autoFocus
                          onChange={(e) => setRenaming({ id: item.id, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void rename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                        />
                        <IconButton
                          size="sm"
                          label={t('lib.saveName')}
                          icon={<Check size={14} />}
                          onClick={() => void rename()}
                        />
                        <IconButton
                          size="sm"
                          label={t('common.cancel')}
                          icon={<X size={14} />}
                          onClick={() => setRenaming(null)}
                        />
                      </div>
                    ) : (
                      <div className="lib-card__meta">
                        <span className="lib-card__name" title={item.name}>
                          {item.name}
                        </span>
                        <Badge>{t(`lib.kind.${item.kind}`)}</Badge>
                      </div>
                    )}
                    {renaming?.id !== item.id && (
                      <div className="lib-card__actions">
                        <IconButton
                          size="sm"
                          label={t('lib.rename')}
                          icon={<Pencil size={14} />}
                          onClick={() => setRenaming({ id: item.id, value: item.name })}
                        />
                        <IconButton
                          size="sm"
                          label={t('colorSep.open')}
                          icon={<Palette size={14} />}
                          onClick={() => {
                            setSeparating(item);
                            setView('separate');
                          }}
                        />
                        <IconButton
                          size="sm"
                          label={t('lib.delete')}
                          icon={<Trash2 size={14} />}
                          onClick={() => void remove(item)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {view === 'image' && <ImageFlow {...flowProps} initialInput={seedImage} />}
        {view === 'draw' && <DrawFlow {...flowProps} />}
        {view === 'type' && <TypeFlow {...flowProps} />}
        {view === 'separate' && separating && <SeparateFlow item={separating} {...flowProps} />}
      </div>
    </Dialog>
  );
}
