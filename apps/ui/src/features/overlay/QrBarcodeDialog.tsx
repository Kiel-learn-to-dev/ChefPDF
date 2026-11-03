/**
 * QR code and barcode (F10): content with variables (for example {filename} and {page}), error
 * correction, size, colours, a label under the code, and the position (by numbers or by drag).
 * Barcodes: Code 128 (any ASCII), EAN-13 (12 or 13 digits, the check digit is checked here) and
 * Code 39 (capitals, digits and - . space $ / + %). The preview is a placeholder drawing: the core
 * makes the real code.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QrCode } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Field, Segmented, Select, Switch, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { ColorInput } from './ColorInput';
import { applyOverlay, prefsOf } from './overlayActions';
import {
  NumberField,
  PagePreview,
  PagesField,
  PositionFields,
  VariableChips,
  previewDocOf,
  useCurrentPage,
} from './OverlayControls';
import {
  BARCODE_KINDS_LIST,
  DEFAULT_BARCODE_FORM,
  DEFAULT_QR_FORM,
  ECC_LEVELS,
  barcodeParams,
  barcodeProblem,
  ean13Complete,
  previewBox,
  fromPt,
  qrContentProblem,
  qrParams,
  toPt,
  type BarcodeForm,
  type BarcodeKind,
  type EccLevel,
  type QrForm,
  type Unit,
} from './overlayModel';
import { renderTemplate } from './variables';
import { useDraft, useOverlayState } from './overlayState';
import './overlay.css';

type CodeMode = 'qr' | 'barcode';
const UNITS: Unit[] = ['mm', 'pt'];
const ENUMS = {
  errorCorrection: ECC_LEVELS,
  kind: BARCODE_KINDS_LIST,
  unit: UNITS,
  choice: ['current', 'all', 'range', 'odd', 'even'],
};

export function QrBarcodeDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [mode, setMode] = useDraft<CodeMode>('codeMode', () => 'qr');
  const [qr, setQr] = useDraft<QrForm>('qr', () => prefsOf('qr', DEFAULT_QR_FORM, ENUMS));
  const [bc, setBc] = useDraft<BarcodeForm>('barcode', () =>
    prefsOf('barcode', DEFAULT_BARCODE_FORM, ENUMS),
  );
  const current = useCurrentPage(doc?.id);

  // Back from a placement: the position goes to the form that was being edited.
  useEffect(() => {
    const r = useOverlayState.getState().takeResult('overlayCode');
    if (!r) return;
    const pageChoice = { choice: 'range' as const, range: String(r.pageIndex + 1) };
    if (mode === 'qr') {
      setQr((f) => ({ ...f, x: fromPt(r.x, 'mm'), y: fromPt(r.y, 'mm'), pages: pageChoice }));
    } else {
      setBc((f) => ({ ...f, x: fromPt(r.x, f.unit), y: fromPt(r.y, f.unit), pages: pageChoice }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const page = doc.info.pages[current] ?? { width: 595, height: 842 };

  const qrProblem = qrContentProblem(qr.content);
  const bcProblem = barcodeProblem(bc.kind, bc.content);
  const pagesOk = (pages: QrForm['pages']) => pages.choice !== 'range' || /\d/.test(pages.range);
  const canRun =
    !blocked && (mode === 'qr' ? !qrProblem && pagesOk(qr.pages) : !bcProblem && pagesOk(bc.pages));

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (mode === 'qr' && qrProblem) warnings.push(t(`overlay.qr.err.${qrProblem}`));
  if (mode === 'barcode' && bcProblem) warnings.push(t(`overlay.barcode.err.${bcProblem}`));

  const run = async () => {
    if (mode === 'qr') {
      const ok = await applyOverlay(
        doc.id,
        'overlay.qrCode',
        qrParams(qr, current, pageCount),
        t('overlay.qrJob', { name: doc.name }),
        { dialog: 'qr', value: qr },
      );
      if (ok) close();
    } else {
      const ok = await applyOverlay(
        doc.id,
        'overlay.barcode',
        barcodeParams(bc, current, pageCount),
        t('overlay.barcodeJob', { name: doc.name }),
        { dialog: 'barcode', value: bc },
      );
      if (ok) close();
    }
  };

  // Preview: a placeholder box of the object at its place (the core draws the real code).
  const isQr = mode === 'qr';
  // A code of n characters is about 11 modules a character plus its guard bars (approximate).
  const modules = Math.max(20, bc.content.length * 11 + 35);
  const sizePt = isQr ? toPt(qr.size, 'mm') : toPt(modules * bc.moduleWidth, bc.unit);
  const heightPt = isQr ? sizePt : toPt(bc.height, bc.unit);
  const placed = isQr
    ? previewBox(toPt(qr.x, 'mm'), toPt(qr.y, 'mm'), sizePt, sizePt, qr.anchor, page)
    : previewBox(toPt(bc.x, bc.unit), toPt(bc.y, bc.unit), sizePt, heightPt, bc.anchor, page);
  const sampleQr = renderTemplate(
    qr.content,
    current,
    previewDocOf(doc, { prefix: '', suffix: '', digits: 6 }, 1, 'dd/MM/yyyy'),
  );
  const shownContent = isQr
    ? sampleQr.ok
      ? sampleQr.text
      : ''
    : bc.kind === 'ean13'
      ? ean13Complete(bc.content)
      : bc.content;

  const modeOptions: { value: CodeMode; label: string }[] = [
    { value: 'qr', label: t('overlay.code.qr') },
    { value: 'barcode', label: t('overlay.code.barcode') },
  ];

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.code.title')}
      icon={<QrCode size={18} />}
      description={t('overlay.code.description')}
      size="xl"
      sideWidth={380}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      workflowStep={
        isQr
          ? {
              op: 'overlay.qrCode',
              params: qrParams(qr, current, pageCount) as unknown as Record<string, unknown>,
              label: t('overlay.code.qr'),
            }
          : {
              op: 'overlay.barcode',
              params: barcodeParams(bc, current, pageCount) as unknown as Record<string, unknown>,
              label: t('overlay.code.barcode'),
            }
      }
      canRun={canRun}
      warnings={warnings}
      preview={
        <PagePreview
          width={page.width}
          height={page.height}
          label={t('overlay.preview.page', { page: current + 1 })}
        >
          <div
            className={`ov-code-preview ov-code-preview--${isQr ? 'qr' : bc.kind}`}
            style={{
              left: `${placed.left}%`,
              top: `${placed.top}%`,
              width: `${placed.width}%`,
              height: `${(heightPt / page.height) * 100}%`,
              color: isQr ? qr.color : bc.color,
            }}
            data-testid="overlay-code-preview"
          >
            <span className="ov-code-preview__text">{isQr ? 'QR' : shownContent}</span>
          </div>
        </PagePreview>
      }
      advanced={
        isQr ? (
          <>
            <Field
              label={t('overlay.code.ecc')}
              htmlFor="ov-qr-ecc"
              hint={t('overlay.code.eccHint')}
            >
              <Select<EccLevel>
                id="ov-qr-ecc"
                value={qr.errorCorrection}
                onChange={(errorCorrection) => setQr((f) => ({ ...f, errorCorrection }))}
                options={ECC_LEVELS.map((l) => ({ value: l, label: t(`overlay.code.ecc${l}`) }))}
                aria-label={t('overlay.code.ecc')}
              />
            </Field>
            <div className="ov-row">
              <ColorInput
                id="ov-qr-color"
                label={t('overlay.look.color')}
                value={qr.color}
                onChange={(color) => setQr((f) => ({ ...f, color }))}
              />
              <Switch
                checked={!!qr.background}
                onChange={(on) => setQr((f) => ({ ...f, background: on ? '#FFFFFF' : '' }))}
                label={t('overlay.code.whiteBg')}
              />
            </div>
          </>
        ) : (
          <>
            <div className="ov-row">
              <NumberField
                id="ov-bc-module"
                label={t('overlay.code.module', { unit: t(`overlay.unit.${bc.unit}`) })}
                value={bc.moduleWidth}
                min={0.05}
                max={20}
                step={0.01}
                onChange={(moduleWidth) => setBc((f) => ({ ...f, moduleWidth }))}
              />
              <NumberField
                id="ov-bc-height"
                label={t('overlay.code.height', { unit: t(`overlay.unit.${bc.unit}`) })}
                value={bc.height}
                min={1}
                max={200}
                step={0.5}
                onChange={(height) => setBc((f) => ({ ...f, height }))}
              />
            </div>
            <div className="ov-row">
              <ColorInput
                id="ov-bc-color"
                label={t('overlay.look.color')}
                value={bc.color}
                onChange={(color) => setBc((f) => ({ ...f, color }))}
              />
              <Switch
                checked={!!bc.background}
                onChange={(on) => setBc((f) => ({ ...f, background: on ? '#FFFFFF' : '' }))}
                label={t('overlay.code.whiteBg')}
              />
            </div>
          </>
        )
      }
    >
      <Segmented<CodeMode>
        aria-label={t('overlay.code.kind')}
        value={mode}
        onChange={setMode}
        options={modeOptions}
      />
      {isQr ? (
        <>
          <Field
            label={t('overlay.code.content')}
            htmlFor="ov-qr-content"
            hint={t('overlay.code.contentHint')}
            error={qrProblem ? t(`overlay.qr.err.${qrProblem}`) : undefined}
          >
            <TextInput
              id="ov-qr-content"
              value={qr.content}
              invalid={!!qrProblem}
              onChange={(e) => setQr((f) => ({ ...f, content: e.target.value }))}
            />
          </Field>
          <VariableChips
            onPick={(name) => setQr((f) => ({ ...f, content: `${f.content}{${name}}` }))}
          />
          <div className="ov-row">
            <NumberField
              id="ov-qr-size"
              label={t('overlay.code.size', { unit: t('overlay.unit.mm') })}
              value={qr.size}
              min={5}
              max={200}
              step={0.5}
              onChange={(size) => setQr((f) => ({ ...f, size }))}
            />
            <Field label={t('overlay.code.label')} htmlFor="ov-qr-label">
              <TextInput
                id="ov-qr-label"
                value={qr.label}
                onChange={(e) => setQr((f) => ({ ...f, label: e.target.value }))}
              />
            </Field>
          </div>
          <PositionFields
            idPrefix="ov-qr"
            x={qr.x}
            y={qr.y}
            unit="mm"
            fixedUnit
            onChange={(p) => setQr((f) => ({ ...f, ...p }))}
            onPlace={
              blocked
                ? undefined
                : () =>
                    useOverlayState
                      .getState()
                      .start({ docId: doc.id, mode: 'point', returnTo: 'overlayCode' })
            }
            placeDisabled={blocked}
          />
          <PagesField
            id="ov-qr"
            value={qr.pages}
            onChange={(pages) => setQr((f) => ({ ...f, pages }))}
            pageCount={pageCount}
            currentPage={current + 1}
          />
        </>
      ) : (
        <>
          <div className="ov-row">
            <Field label={t('overlay.code.kind')} htmlFor="ov-bc-kind">
              <Select<BarcodeKind>
                id="ov-bc-kind"
                value={bc.kind}
                onChange={(kind) => setBc((f) => ({ ...f, kind }))}
                options={BARCODE_KINDS_LIST.map((k) => ({
                  value: k,
                  label: t(`overlay.code.kinds.${k}`),
                }))}
                aria-label={t('overlay.code.kind')}
              />
            </Field>
            <Field
              label={t('overlay.code.content')}
              htmlFor="ov-bc-content"
              error={bcProblem ? t(`overlay.barcode.err.${bcProblem}`) : undefined}
            >
              <TextInput
                id="ov-bc-content"
                value={bc.content}
                invalid={!!bcProblem}
                onChange={(e) => setBc((f) => ({ ...f, content: e.target.value }))}
              />
            </Field>
          </div>
          <Field
            label={t('overlay.code.label')}
            htmlFor="ov-bc-label"
            hint={bc.kind === 'code39' ? t('overlay.code.code39Hint') : undefined}
          >
            <TextInput
              id="ov-bc-label"
              value={bc.label}
              onChange={(e) => setBc((f) => ({ ...f, label: e.target.value }))}
            />
          </Field>
          <PositionFields
            idPrefix="ov-bc"
            x={bc.x}
            y={bc.y}
            unit={bc.unit}
            onChange={(p) => {
              if (p.unit && p.unit !== bc.unit) {
                setBc((f) => ({
                  ...f,
                  unit: p.unit!,
                  x: fromPt(toPt(f.x, f.unit), p.unit!),
                  y: fromPt(toPt(f.y, f.unit), p.unit!),
                }));
                return;
              }
              setBc((f) => ({ ...f, ...p }));
            }}
            onPlace={
              blocked
                ? undefined
                : () =>
                    useOverlayState
                      .getState()
                      .start({ docId: doc.id, mode: 'point', returnTo: 'overlayCode' })
            }
            placeDisabled={blocked}
          />
          <PagesField
            id="ov-bc"
            value={bc.pages}
            onChange={(pages) => setBc((f) => ({ ...f, pages }))}
            pageCount={pageCount}
            currentPage={current + 1}
          />
        </>
      )}
    </TaskDialog>
  );
}
