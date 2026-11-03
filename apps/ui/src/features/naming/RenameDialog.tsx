import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePenLine } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { useDocs } from '../../app/state/documents';
import { showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Field, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { toast } from '../../components/Toast';
import { executableMapping, undoMapping, type RenameRow } from './namingModel';

export function RenameDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const [files, setFiles] = useState<string[]>([]);
  const [template, setTemplate] = useState('{name}_{seq:2}');
  const [preview, setPreview] = useState<RenameRow[] | null>(null);
  const [result, setResult] = useState<RenameRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    try {
      const selected = await chef().files.openDialog({ multiple: true });
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      const opened = new Set(
        useDocs
          .getState()
          .docs.flatMap((d) => (d.state.sourcePath ? [norm(d.state.sourcePath)] : [])),
      );
      const eligible = selected.filter((p) => !opened.has(norm(p)));
      if (eligible.length !== selected.length)
        toast.warning(t('rename.title'), t('rename.openFiles'));
      setFiles((old) => [...new Set([...old, ...eligible])]);
      setPreview(null);
      setResult(null);
    } catch (e) {
      showError(e, t('rename.title'));
    }
  };
  const readRows = (data: unknown): RenameRow[] => {
    const rows = (data as { items?: RenameRow[] } | undefined)?.items;
    if (!Array.isArray(rows)) throw new Error(t('rename.badResult'));
    return rows;
  };
  const previewNames = async () => {
    setBusy(true);
    try {
      const r = await runOp(
        'naming.preview',
        { files, template, conflict: 'suffix' },
        { title: t('rename.preview') },
      );
      setPreview(readRows(r.data));
      setResult(null);
    } catch (e) {
      showError(e, t('rename.title'));
    } finally {
      setBusy(false);
    }
  };
  const execute = async (mapping: { source: string; target: string }[], undo: boolean) => {
    if (!mapping.length) return;
    setBusy(true);
    try {
      const r = await runOp(
        'files.renameBatch',
        { mapping, dryRun: false },
        { title: t(undo ? 'rename.undo' : 'rename.apply') },
      );
      const rows = readRows(r.data);
      setResult(rows);
      setPreview(null);
      if (undo)
        setFiles(rows.filter((row) => row.status === 'done' && row.to).map((row) => row.to!));
      else setFiles(rows.map((row) => (row.status === 'done' && row.to ? row.to : row.from)));
    } catch (e) {
      showError(e, t('rename.title'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modalLock={busy}
      onOpenChange={(o) => !o && !busy && close()}
      title={t('rename.title')}
      icon={<FilePenLine size={18} />}
      description={t('rename.description')}
      size="lg"
      footer={
        <>
          <Button
            disabled={busy || !result || !undoMapping(result).length}
            onClick={() => result && void execute(undoMapping(result), true)}
          >
            {t('rename.undo')}
          </Button>
          <DialogSpacer />
          <Button disabled={busy} onClick={close}>
            {t('common.close')}
          </Button>
          <Button
            disabled={busy || !files.length || !template.trim()}
            onClick={() => void previewNames()}
          >
            {t('rename.preview')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !preview || !executableMapping(preview).length}
            onClick={() => preview && void execute(executableMapping(preview), false)}
          >
            {t('rename.apply')}
          </Button>
        </>
      }
    >
      <Button disabled={busy} onClick={() => void pick()}>
        {t('rename.add')}
      </Button>
      <p>{t('rename.count', { count: files.length })}</p>
      {files.length > 0 && (
        <ul>
          {files.map((file) => (
            <li key={file}>
              {file}{' '}
              <button
                type="button"
                disabled={busy}
                aria-label={t('rename.remove', { file })}
                onClick={() => {
                  setFiles((list) => list.filter((p) => p !== file));
                  setPreview(null);
                  setResult(null);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field label={t('rename.template')} htmlFor="rename-template" hint={t('rename.templateHint')}>
        <TextInput
          id="rename-template"
          value={template}
          disabled={busy}
          onChange={(e) => {
            setTemplate(e.target.value);
            setPreview(null);
            setResult(null);
          }}
        />
      </Field>
      {(preview || result) && (
        <div role="region" aria-label={t('rename.results')}>
          <h3>{t('rename.results')}</h3>
          <ul>
            {(preview ?? result ?? []).map((row, index) => (
              <li key={index}>
                {row.from} → {row.to ?? '—'} (
                {t(`rename.status.${row.status}`, { defaultValue: row.status })}) {row.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
