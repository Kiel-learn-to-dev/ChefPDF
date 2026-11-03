/**
 * "Sửa file hỏng" (M11): repairs a damaged PDF into a new copy (the original is never touched),
 * then opens the copy. Offered from the Start screen and from the open-failed error (INVALID_PDF).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileWarning, FolderOpen, Wrench } from 'lucide-react';
import { openFiles, errorMessage, pickSavePath } from '../../app/actions';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Field, TextInput } from '../../components/Form';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { basename } from '../../lib/path';
import { toChefError } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { parseRepairData, repairOutputPath, repairParams } from './docToolsModel';
import './docTools.css';

/** dialogData of the repair dialog: the damaged file, and the open error that led here. */
export interface RepairDialogData {
  path?: string;
  message?: string;
}

const PDF_FILTER = [{ name: 'PDF', extensions: ['pdf'] }];

export function RepairDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const data = useUi((s) => s.dialogData) as RepairDialogData | undefined;
  const [input, setInput] = useState<string | null>(data?.path ?? null);
  const [output, setOutput] = useState<string | null>(
    data?.path ? repairOutputPath(data.path) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickInput = async () => {
    const [picked] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTER });
    if (!picked) return;
    setInput(picked);
    setOutput(repairOutputPath(picked));
    setError(null);
  };

  const pickOutput = async () => {
    const path = await pickSavePath(
      basename(output ?? repairOutputPath(input ?? 'hong.pdf')),
      input,
    );
    if (path) setOutput(path);
  };

  const run = async () => {
    if (!input || !output) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runOp('doc.repair', repairParams(input, output), {
        title: t('repair.job'),
      });
      const r = parseRepairData(result.data);
      if (r.warnings.length > 0) toast.warning(t('repair.warnings'), r.warnings.join('\n'));
      close();
      await openFiles([output]);
      toast.success(t('repair.doneTitle'), t('repair.doneText', { pages: r.pageCount }));
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      modalLock={busy}
      onOpenChange={(o) => {
        if (!o && !busy) close();
      }}
      icon={<Wrench size={18} />}
      title={t('repair.title')}
      description={t('repair.description')}
      size="md"
      footer={
        <>
          <DialogSpacer />
          <Button onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Wrench size={15} />}
            loading={busy}
            disabled={!input || !output || busy}
            onClick={() => void run()}
          >
            {t('repair.run')}
          </Button>
        </>
      }
    >
      {data?.message && (
        <p className="docTools__note docTools__note--warn" role="alert">
          <FileWarning size={15} aria-hidden /> {data.message}
        </p>
      )}
      <Field label={t('repair.input')}>
        <div className="docTools__row">
          <Button icon={<FolderOpen size={15} />} disabled={busy} onClick={() => void pickInput()}>
            {input ? t('repair.changeInput') : t('repair.pickInput')}
          </Button>
          <span className="docTools__file" title={input ?? undefined}>
            {input ? basename(input) : t('repair.noInput')}
          </span>
        </div>
      </Field>
      <Field label={t('repair.output')}>
        <div className="docTools__row">
          <TextInput readOnly value={output ?? ''} placeholder={t('repair.noOutput')} />
          <Button disabled={!input || busy} onClick={() => void pickOutput()}>
            {t('repair.chooseOutput')}
          </Button>
        </div>
      </Field>
      <p className="docTools__note">{t('repair.keepsOriginal')}</p>
      {error && (
        <p className="docTools__note docTools__note--warn" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
