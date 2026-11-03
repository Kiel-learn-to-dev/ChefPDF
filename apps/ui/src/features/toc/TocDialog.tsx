import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTree } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp, showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { toast } from '../../components/Toast';
import { runOp } from '../../lib/rpc';

interface Heading {
  title: string;
  page: number;
  children: Heading[];
}
function flatten(nodes: Heading[], depth = 0): { title: string; page: number; depth: number }[] {
  return nodes.flatMap((node) => [
    { title: node.title, page: node.page, depth },
    ...flatten(node.children ?? [], depth + 1),
  ]);
}

export function TocDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [level, setLevel] = useState('3');
  const [position, setPosition] = useState<'front' | 'back'>('front');
  const [bookmark, setBookmark] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; headings: Heading[] } | null>(null);
  if (!doc) return null;
  const key = `${doc.id}:${doc.version}:${level}`;
  const headings = preview?.key === key ? flatten(preview.headings) : [];
  const load = async () => {
    setBusy(true);
    try {
      const result = await runOp(
        'toc.preview',
        { maxLevel: Number(level) },
        { sessionId: doc.id, title: t('toc.preview') },
      );
      const data = result.data as { bookmarks?: Heading[] } | undefined;
      if (!Array.isArray(data?.bookmarks)) throw new Error(t('toc.badPreview'));
      setPreview({ key, headings: data.bookmarks });
    } catch (e) {
      showError(e, t('toc.title'));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!headings.length || busy || doc.state.signed) return;
    setBusy(true);
    try {
      const result = await runDocOp(
        doc.id,
        'toc.insertPage',
        {
          maxLevel: Number(level),
          placement: position,
          addBookmark: bookmark,
        },
        t('toc.title'),
      );
      if (result) {
        toast.success(t('toc.done'));
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <TaskDialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('toc.title')}
      icon={<ListTree size={18} />}
      description={t('toc.description')}
      onRun={() => void apply()}
      runLabel={t('toc.insert')}
      running={busy}
      canRun={!busy && !doc.state.signed && headings.length > 0}
      preview={
        <div>
          <h3>{t('toc.preview')}</h3>
          {headings.length ? (
            <ol>
              {headings.map((h, i) => (
                <li key={i} style={{ marginInlineStart: `${h.depth}em` }}>
                  {h.title} — {h.page + 1}
                </li>
              ))}
            </ol>
          ) : (
            <p>{preview?.key === key ? t('toc.empty') : t('toc.previewHint')}</p>
          )}
        </div>
      }
    >
      <Field label={t('toc.level')} htmlFor="toc-level">
        <Select
          id="toc-level"
          value={level}
          onChange={setLevel}
          options={['1', '2', '3', '4', '5', '6'].map((value) => ({ value, label: value }))}
        />
      </Field>
      <Field label={t('toc.position')} htmlFor="toc-position">
        <Select<'front' | 'back'>
          id="toc-position"
          value={position}
          onChange={setPosition}
          options={[
            { value: 'front', label: t('toc.front') },
            { value: 'back', label: t('toc.back') },
          ]}
        />
      </Field>
      <Checkbox checked={bookmark} onChange={setBookmark} label={t('toc.bookmark')} />
      <Button onClick={() => void load()} disabled={busy}>
        {t('toc.analyze')}
      </Button>
    </TaskDialog>
  );
}
