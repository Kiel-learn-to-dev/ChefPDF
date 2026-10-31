import { useTranslation } from 'react-i18next';
import * as RP from '@radix-ui/react-popover';
import clsx from 'clsx';
import { Ban, CircleAlert, CircleCheck, ListChecks, LoaderCircle, X } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { Button, IconButton } from '../../components/Button';
import { ProgressBar } from '../../components/Misc';
import { cancelJob } from '../../lib/rpc';
import { formatRelative } from '../../lib/format';
import { jobProgress, selectRunningCount, useJobStore, type Job } from './jobStore';
import './JobPanel.css';

function JobRow({ job }: { job: Job }) {
  const { t, i18n } = useTranslation();
  const dismiss = useJobStore((s) => s.dismiss);
  const Icon = {
    running: LoaderCircle,
    finished: CircleCheck,
    failed: CircleAlert,
    cancelled: Ban,
  }[job.status];
  return (
    <li className={clsx('job', `job--${job.status}`)}>
      <Icon
        size={16}
        className={clsx('job__icon', job.status === 'running' && 'spinner')}
        aria-hidden
      />
      <div className="job__body">
        <div className="job__title">{job.title}</div>
        {job.status === 'running' ? (
          <>
            <ProgressBar value={jobProgress(job)} label={job.title} />
            <div className="job__meta">
              {job.message ??
                (job.total
                  ? t('jobs.progress', { done: job.done, total: job.total })
                  : t('jobs.running'))}
            </div>
          </>
        ) : (
          <div className="job__meta">
            {t(`jobs.status.${job.status}`)}
            {job.error ? ` · ${job.error}` : ''} ·{' '}
            {formatRelative(new Date(job.endedAt ?? job.startedAt).toISOString(), i18n.language)}
          </div>
        )}
      </div>
      {job.status === 'running' ? (
        <IconButton
          size="sm"
          label={t('jobs.cancel')}
          icon={<X size={14} />}
          onClick={() => void cancelJob(job.id).catch(() => undefined)}
        />
      ) : (
        <IconButton
          size="sm"
          label={t('jobs.dismiss')}
          icon={<X size={14} />}
          onClick={() => dismiss(job.id)}
        />
      )}
    </li>
  );
}

/** Status-bar job indicator with a popover listing jobs (job.* events). */
export function JobIndicator() {
  const { t } = useTranslation();
  const open = useUi((s) => s.jobPanelOpen);
  const set = useUi((s) => s.set);
  const jobs = useJobStore((s) => s.jobs);
  const running = useJobStore(selectRunningCount);
  const clearFinished = useJobStore((s) => s.clearFinished);
  const failed = jobs.some((j) => j.status === 'failed');
  return (
    <RP.Root open={open} onOpenChange={(o) => set({ jobPanelOpen: o })}>
      <RP.Trigger asChild>
        <button
          type="button"
          className={clsx(
            'status__job',
            running > 0 && 'is-running',
            failed && !running && 'is-failed',
          )}
          aria-label={t('jobs.title')}
        >
          {running > 0 ? <LoaderCircle size={13} className="spinner" /> : <ListChecks size={13} />}
          <span>{running > 0 ? t('jobs.runningCount', { count: running }) : t('jobs.title')}</span>
        </button>
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          className="jobs-panel"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
        >
          <div className="jobs-panel__head">
            <span className="jobs-panel__title">{t('jobs.title')}</span>
            {jobs.some((j) => j.status !== 'running') && (
              <Button size="sm" variant="ghost" onClick={clearFinished}>
                {t('jobs.clearFinished')}
              </Button>
            )}
          </div>
          {jobs.length === 0 ? (
            <p className="jobs-panel__empty">{t('jobs.empty')}</p>
          ) : (
            <ul className="jobs-panel__list">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </ul>
          )}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}
