import type { ReactNode } from 'react';
import * as RD from '@radix-ui/react-dialog';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './Button';

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  footer?: ReactNode;
  children?: ReactNode;
  /** Prevent closing by clicking outside (e.g. while a job runs). */
  modalLock?: boolean;
  hideClose?: boolean;
  className?: string;
  onOpenAutoFocus?: (e: Event) => void;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  tone = 'default',
  size = 'md',
  footer,
  children,
  modalLock,
  hideClose,
  className,
  onOpenAutoFocus,
}: DialogProps) {
  const { t } = useTranslation();
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="dlg-overlay" />
        <RD.Content
          className={clsx('dlg', size !== 'md' && `dlg--${size}`, className)}
          onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}
          onEscapeKeyDown={modalLock ? (e) => e.preventDefault() : undefined}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          <div className="dlg__header">
            {icon && (
              <div className={clsx('dlg__icon', tone === 'danger' && 'dlg__icon--danger')}>
                {icon}
              </div>
            )}
            <div className="dlg__titles">
              <RD.Title className="dlg__title">{title}</RD.Title>
              {description ? (
                <RD.Description className="dlg__desc">{description}</RD.Description>
              ) : (
                <RD.Description className="sr-only">{title}</RD.Description>
              )}
            </div>
            {!hideClose && (
              <RD.Close asChild>
                <IconButton
                  className="dlg__close"
                  size="sm"
                  label={t('common.close')}
                  icon={<X size={16} />}
                  tooltip={false}
                />
              </RD.Close>
            )}
          </div>
          {children !== undefined && <div className="dlg__body">{children}</div>}
          {footer && <div className="dlg__footer">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function DialogSpacer() {
  return <div className="dlg__footer-spacer" />;
}
