import type { ReactNode } from 'react';
import * as RSA from '@radix-ui/react-scroll-area';
import * as RSep from '@radix-ui/react-separator';
import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';

export function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RSA.Root className={clsx('scroll-area', className)} type="hover">
      <RSA.Viewport className="scroll-area__viewport">{children}</RSA.Viewport>
      <RSA.Scrollbar className="scroll-area__bar" orientation="vertical">
        <RSA.Thumb className="scroll-area__thumb" />
      </RSA.Scrollbar>
    </RSA.Root>
  );
}

export function Separator({
  orientation = 'vertical',
}: {
  orientation?: 'vertical' | 'horizontal';
}) {
  return <RSep.Root className="separator" orientation={orientation} decorative />;
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <LoaderCircle
      size={size}
      className="spinner"
      aria-label={label}
      aria-hidden={!label}
      role={label ? 'status' : undefined}
    />
  );
}

export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  return (
    <div
      className={clsx('progress', value === null && 'progress--indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div
        className="progress__bar"
        style={value === null ? undefined : { width: `${value * 100}%` }}
      />
    </div>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, text, actions }: EmptyStateProps) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {text && <div className="empty__text">{text}</div>}
      {actions && <div className="field__row">{actions}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return <span className={clsx('badge', tone === 'accent' && 'badge--accent')}>{children}</span>;
}
