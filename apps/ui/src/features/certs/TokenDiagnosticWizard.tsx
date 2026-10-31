import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import clsx from 'clsx';
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Copy,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import type { DiagnoseData, DiagStatus, DiagStep } from '@chef/contracts';
import { useUi } from '../../app/state/ui';
import { errorMessage } from '../../app/actions';
import { toast } from '../../components/Toast';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Spinner } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { diagnoseToken } from './certOps';
import {
  buildReport,
  localizedStep,
  orderSteps,
  overallOf,
  pinAlert,
  type ReportLabels,
} from './diagModel';
import './certs.css';

interface WizardData {
  modulePath?: string | null;
}

const STATUS_ICON: Record<DiagStatus, ReactNode> = {
  ok: <CircleCheck size={18} aria-hidden />,
  warn: <TriangleAlert size={18} aria-hidden />,
  fail: <CircleX size={18} aria-hidden />,
  skipped: <CircleMinus size={18} aria-hidden />,
};

/** Translated status words. Literal keys so the i18n check can see them. */
function statusWord(t: TFunction, status: DiagStatus): string {
  switch (status) {
    case 'ok':
      return t('diag.status.ok');
    case 'warn':
      return t('diag.status.warn');
    case 'fail':
      return t('diag.status.fail');
    case 'skipped':
      return t('diag.status.skipped');
  }
}

/** T3.03 / I6: step-by-step token check with Vietnamese fixes and a PIN warning. */
export function TokenDiagnosticWizard() {
  const { t, i18n } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const data = useUi((s) => s.dialogData) as WizardData | undefined;
  const modulePath = data?.modulePath ?? null;
  const lang: 'vi' | 'en' = i18n.language === 'en' ? 'en' : 'vi';
  const [result, setResult] = useState<DiagnoseData | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');
  // Starts "running" so the first render shows the spinner; the effect only starts the call.
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // State is only set inside the promise callbacks, never synchronously in the effect.
  const load = useCallback(
    () =>
      diagnoseToken(modulePath, t('diag.jobTitle'))
        .then((res) => {
          setResult(res);
          setError(null);
          setGeneratedAt(new Date().toISOString());
        })
        .catch((e: unknown) => {
          setResult(null);
          setError(errorMessage(e));
        })
        .finally(() => setRunning(false)),
    [modulePath, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = () => {
    setRunning(true);
    setError(null);
    void load();
  };

  const copyReport = async () => {
    if (!result) return;
    const labels: ReportLabels = {
      title: t('diag.reportTitle'),
      generatedAt: t('diag.generatedAt'),
      driver: t('diag.driverLabel'),
      overall: {
        ok: t('diag.overall.ok'),
        warn: t('diag.overall.warn'),
        fail: t('diag.overall.fail'),
      },
      status: {
        ok: t('diag.status.ok'),
        warn: t('diag.status.warn'),
        fail: t('diag.status.fail'),
        skipped: t('diag.status.skipped'),
      },
      fix: t('diag.fix'),
      noDriver: t('diag.noDriver'),
    };
    const text = buildReport({
      steps: result.steps,
      overall: result.overall,
      lang,
      labels,
      modulePath,
      generatedAt,
    });
    try {
      await chef().clipboard.writeText(text);
      toast.success(t('diag.copied'));
    } catch (e) {
      toast.error(t('errors.title'), errorMessage(e));
    }
  };

  const steps = result ? orderSteps(result.steps) : [];
  const alert = result ? pinAlert(result.steps) : null;
  const overall = result ? overallOf(result.steps) : null;
  const overallTitle = overall === null ? null : overallText(t, overall);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      icon={<Stethoscope size={18} />}
      title={t('diag.title')}
      description={t('diag.description')}
      size="lg"
      footer={
        <>
          <Button icon={<RefreshCw size={15} />} loading={running} onClick={run}>
            {t('diag.rerun')}
          </Button>
          <Button icon={<Copy size={15} />} disabled={!result} onClick={() => void copyReport()}>
            {t('diag.copy')}
          </Button>
        </>
      }
    >
      <p className="diag__target">
        {t('diag.driverLabel')}:{' '}
        <span className="cert-card__mono">{modulePath ?? t('diag.noDriver')}</span>
      </p>

      {running && !result && (
        <div className="diag__loading" role="status">
          <Spinner label={t('diag.running')} /> <span>{t('diag.running')}</span>
        </div>
      )}

      {error && (
        <div className="certs__error" role="alert">
          <CircleX size={16} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {alert && (
        <div className="diag-pin" role="alert">
          <ShieldAlert size={28} aria-hidden />
          <div className="diag-pin__body">
            <strong className="diag-pin__title">{t('diag.pinTitle')}</strong>
            <p>{localizedStep(alert, lang).title}</p>
            {localizedStep(alert, lang).fix && <p>{localizedStep(alert, lang).fix}</p>}
          </div>
        </div>
      )}

      {result && overall && overallTitle && (
        <div className={clsx('diag-overall', `diag-overall--${overall}`)} role="status">
          {overall === 'ok' ? (
            <CircleCheck size={20} aria-hidden />
          ) : overall === 'warn' ? (
            <TriangleAlert size={20} aria-hidden />
          ) : (
            <CircleX size={20} aria-hidden />
          )}
          <span>{overallTitle}</span>
        </div>
      )}

      {steps.length > 0 && (
        <ol className="diag-steps">
          {steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              lang={lang}
              statusWord={statusWord(t, step.status)}
            />
          ))}
        </ol>
      )}
    </Dialog>
  );
}

function overallText(t: TFunction, overall: 'ok' | 'warn' | 'fail'): string {
  switch (overall) {
    case 'ok':
      return t('diag.overall.ok');
    case 'warn':
      return t('diag.overall.warn');
    case 'fail':
      return t('diag.overall.fail');
  }
}

function StepRow({
  step,
  lang,
  statusWord: word,
}: {
  step: DiagStep;
  lang: 'vi' | 'en';
  statusWord: string;
}) {
  const { t } = useTranslation();
  const { title, fix } = localizedStep(step, lang);
  const needsFix = (step.status === 'warn' || step.status === 'fail') && fix;
  return (
    <li className={clsx('diag-step', `diag-step--${step.status}`)}>
      <span className="diag-step__icon">{STATUS_ICON[step.status]}</span>
      <div className="diag-step__body">
        <div className="diag-step__head">
          <span className="diag-step__title">{title}</span>
          <span className="diag-step__status">{word}</span>
        </div>
        <p className="diag-step__detail">{step.detail}</p>
        {needsFix && (
          <p className="diag-step__fix">
            <strong>{t('diag.fix')}: </strong>
            {fix}
          </p>
        )}
      </div>
    </li>
  );
}
