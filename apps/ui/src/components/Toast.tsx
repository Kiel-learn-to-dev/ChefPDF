import { useEffect } from 'react';
import { create } from 'zustand';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './Button';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  text?: string;
  actions?: ToastAction[];
  /** ms; 0 = sticky. */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push(t: Omit<ToastItem, 'id' | 'duration'> & { duration?: number }): number;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(t) {
    const id = nextId++;
    const duration = t.duration ?? (t.tone === 'error' ? 8000 : t.actions?.length ? 9000 : 4000);
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, duration }] }));
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
}));

export const toast = {
  success: (title: string, text?: string, actions?: ToastAction[]) =>
    useToasts.getState().push({ tone: 'success', title, text, actions }),
  error: (title: string, text?: string) =>
    useToasts.getState().push({ tone: 'error', title, text }),
  warning: (title: string, text?: string, actions?: ToastAction[]) =>
    useToasts.getState().push({ tone: 'warning', title, text, actions }),
  info: (title: string, text?: string, actions?: ToastAction[]) =>
    useToasts.getState().push({ tone: 'info', title, text, actions }),
};

const ICONS = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info };

function ToastView({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    if (!item.duration) return;
    const timer = setTimeout(() => dismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, dismiss]);
  const Icon = ICONS[item.tone];
  return (
    <div className={`toast toast--${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={18} className="toast__icon" aria-hidden />
      <div className="toast__body">
        <div className="toast__title">{item.title}</div>
        {item.text && <div className="toast__text">{item.text}</div>}
        {item.actions && (
          <div className="toast__actions">
            {item.actions.map((a) => (
              <Button
                key={a.label}
                size="sm"
                onClick={() => {
                  a.onClick();
                  dismiss(item.id);
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton
        size="sm"
        label={t('common.close')}
        icon={<X size={14} />}
        tooltip={false}
        onClick={() => dismiss(item.id)}
      />
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}
