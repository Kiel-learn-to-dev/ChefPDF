import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus, ImagePlus, SquarePlus } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { PDF_FILTERS, probePdf, showError } from '../../app/actions';
import { TaskDialog } from '../../components/TaskDialog';
import { Field, RadioGroup, Select, TextInput } from '../../components/Form';
import { Button } from '../../components/Button';
import { chef } from '../../lib/bridge';
import { parsePageRanges } from '../../lib/pageRange';
import { basename } from '../../lib/path';
import {
  insertBlank,
  insertFromFile,
  insertImages,
  insertionPoint,
  pickImages,
} from './pageActions';

type Where = 'before' | 'after' | 'start' | 'end';

function WhereField({ value, onChange }: { value: Where; onChange(v: Where): void }) {
  const { t } = useTranslation();
  return (
    <Field label={t('insert.position')}>
      <Select<Where>
        value={value}
        onChange={onChange}
        aria-label={t('insert.position')}
        options={[
          { value: 'after', label: t('insert.afterSelection') },
          { value: 'before', label: t('insert.beforeSelection') },
          { value: 'start', label: t('insert.atStart') },
          { value: 'end', label: t('insert.atEnd') },
        ]}
      />
    </Field>
  );
}

const SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export function InsertBlankDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [where, setWhere] = useState<Where>('after');
  const [count, setCount] = useState(1);
  const [size, setSize] = useState<'same' | 'a4' | 'letter'>('same');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [running, setRunning] = useState(false);
  if (!doc) return null;
  const run = async () => {
    setRunning(true);
    let dims: { width: number; height: number } | undefined;
    if (size !== 'same') {
      const s = SIZES[size];
      dims = orientation === 'portrait' ? { ...s } : { width: s.height, height: s.width };
    }
    await insertBlank(doc.id, insertionPoint(doc.id, where), count, dims);
    setRunning(false);
    close();
  };
  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      size="md"
      title={t('insert.blankTitle')}
      icon={<SquarePlus size={18} />}
      runLabel={t('insert.insert')}
      onRun={() => void run()}
      running={running}
      canRun={count >= 1 && count <= 500}
    >
      <WhereField value={where} onChange={setWhere} />
      <Field label={t('insert.count')} htmlFor="blank-count">
        <TextInput
          id="blank-count"
          type="number"
          min={1}
          max={500}
          value={count}
          onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
        />
      </Field>
      <Field label={t('insert.pageSize')}>
        <Select<'same' | 'a4' | 'letter'>
          value={size}
          onChange={setSize}
          aria-label={t('insert.pageSize')}
          options={[
            { value: 'same', label: t('insert.sameAsNeighbour') },
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'Letter' },
          ]}
        />
      </Field>
      {size !== 'same' && (
        <RadioGroup<'portrait' | 'landscape'>
          value={orientation}
          onChange={setOrientation}
          aria-label={t('insert.orientation')}
          options={[
            { value: 'portrait', label: t('insert.portrait') },
            { value: 'landscape', label: t('insert.landscape') },
          ]}
        />
      )}
    </TaskDialog>
  );
}

export function InsertFromFileDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [where, setWhere] = useState<Where>('after');
  const [file, setFile] = useState<{ path: string; pageCount: number; password?: string } | null>(
    null,
  );
  const [range, setRange] = useState('');
  const [running, setRunning] = useState(false);
  if (!doc) return null;

  const pick = async () => {
    const [path] = await chef().files.openDialog({ multiple: false, filters: PDF_FILTERS });
    if (!path) return;
    try {
      const probed = await probePdf(path);
      if (probed) setFile(probed);
    } catch (e) {
      showError(e);
    }
  };

  const parsed =
    file && range.trim() && file.pageCount ? parsePageRanges(range, file.pageCount) : null;
  const rangeError = parsed && !parsed.ok ? t(`range.${parsed.error}`) : undefined;

  const run = async () => {
    if (!file) return;
    setRunning(true);
    const r = await insertFromFile(
      doc.id,
      insertionPoint(doc.id, where),
      file.path,
      parsed?.ok ? parsed.pages : undefined,
      file.password,
    );
    setRunning(false);
    if (r) close();
  };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      size="md"
      title={t('insert.fileTitle')}
      icon={<FilePlus size={18} />}
      runLabel={t('insert.insert')}
      onRun={() => void run()}
      running={running}
      canRun={!!file && !rangeError}
    >
      <Field
        label={t('insert.sourceFile')}
        hint={file ? t('insert.filePages', { count: file.pageCount }) : undefined}
      >
        <div className="field__row">
          <TextInput
            readOnly
            value={file ? basename(file.path) : ''}
            placeholder={t('insert.noFile')}
            aria-label={t('insert.sourceFile')}
          />
          <Button onClick={() => void pick()}>{t('common.browse')}</Button>
        </div>
      </Field>
      <Field
        label={t('insert.pages')}
        htmlFor="insert-range"
        hint={t('range.hint')}
        error={rangeError}
      >
        <TextInput
          id="insert-range"
          value={range}
          onChange={(e) => setRange(e.target.value)}
          placeholder={t('insert.allPages')}
          invalid={!!rangeError}
        />
      </Field>
      <WhereField value={where} onChange={setWhere} />
    </TaskDialog>
  );
}

export function InsertImagesDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [where, setWhere] = useState<Where>('after');
  const [images, setImages] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState<'image' | 'a4' | 'letter'>('a4');
  const [margin, setMargin] = useState(18);
  const [running, setRunning] = useState(false);
  if (!doc) return null;
  const run = async () => {
    setRunning(true);
    const r = await insertImages(
      doc.id,
      insertionPoint(doc.id, where),
      images.map((path) => ({ path })),
      pageSize,
      margin,
    );
    setRunning(false);
    if (r) close();
  };
  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      size="md"
      title={t('insert.imagesTitle')}
      icon={<ImagePlus size={18} />}
      runLabel={t('insert.insert')}
      onRun={() => void run()}
      running={running}
      canRun={images.length > 0}
    >
      <Field
        label={t('insert.images')}
        hint={images.length ? images.map(basename).join(', ') : t('insert.noImages')}
      >
        <div className="field__row">
          <Button
            icon={<ImagePlus size={15} />}
            onClick={() => void pickImages().then((p) => p.length && setImages(p))}
          >
            {images.length
              ? t('insert.imagesPicked', { count: images.length })
              : t('insert.pickImages')}
          </Button>
        </div>
      </Field>
      <Field label={t('insert.pageSize')}>
        <Select<'image' | 'a4' | 'letter'>
          value={pageSize}
          onChange={setPageSize}
          aria-label={t('insert.pageSize')}
          options={[
            { value: 'a4', label: 'A4' },
            { value: 'letter', label: 'Letter' },
            { value: 'image', label: t('insert.fitImage') },
          ]}
        />
      </Field>
      <Field label={t('insert.margin')} htmlFor="img-margin" hint={t('insert.marginHint')}>
        <TextInput
          id="img-margin"
          type="number"
          min={0}
          max={144}
          value={margin}
          onChange={(e) => setMargin(Math.max(0, Number(e.target.value) || 0))}
        />
      </Field>
      <WhereField value={where} onChange={setWhere} />
    </TaskDialog>
  );
}
