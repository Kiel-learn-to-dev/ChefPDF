import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import * as RS from '@radix-ui/react-select';
import * as RC from '@radix-ui/react-checkbox';
import * as RR from '@radix-ui/react-radio-group';
import * as RSw from '@radix-ui/react-switch';
import * as RT from '@radix-ui/react-toggle-group';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  return (
    <div className={clsx('field', className)}>
      {label && (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <div className="field__error" role="alert">
          {error}
        </div>
      ) : (
        hint && <div className="field__hint">{hint}</div>
      )}
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { size = 'md', invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        'input',
        size === 'sm' && 'input--sm',
        rest.type === 'number' && 'input--num',
        className,
      )}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      {...rest}
    />
  );
});

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: SelectOption<V>[];
  id?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

export function Select<V extends string>({
  value,
  onChange,
  options,
  id,
  size = 'md',
  disabled,
  className,
  ...rest
}: SelectProps<V>) {
  return (
    <RS.Root value={value} onValueChange={(v) => onChange(v as V)} disabled={disabled}>
      <RS.Trigger
        id={id}
        className={clsx('select-trigger', size === 'sm' && 'select-trigger--sm', className)}
        aria-label={rest['aria-label']}
      >
        <RS.Value />
        <RS.Icon>
          <ChevronDown size={14} />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          className="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RS.Viewport className="select-viewport">
            {options.map((o) => (
              <RS.Item key={o.value} value={o.value} className="select-item">
                <span className="select-item__check">
                  <RS.ItemIndicator>
                    <Check size={14} />
                  </RS.ItemIndicator>
                </span>
                <RS.ItemText>{o.label}</RS.ItemText>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, hint, disabled }: CheckboxProps) {
  const id = useId();
  return (
    <label className="checkbox-row" htmlFor={id} data-disabled={disabled || undefined}>
      <RC.Root
        id={id}
        className="checkbox"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      >
        <RC.Indicator>
          <Check size={12} strokeWidth={3} />
        </RC.Indicator>
      </RC.Root>
      <span className="checkbox-row__text">
        {label}
        {hint && <span className="checkbox-row__hint">{hint}</span>}
      </span>
    </label>
  );
}

export interface RadioOption<V extends string> {
  value: V;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: RadioOption<V>[];
  'aria-label'?: string;
  className?: string;
}

export function RadioGroup<V extends string>({
  value,
  onChange,
  options,
  className,
  ...rest
}: RadioGroupProps<V>) {
  const base = useId();
  return (
    <RR.Root
      className={className}
      value={value}
      onValueChange={(v) => onChange(v as V)}
      aria-label={rest['aria-label']}
    >
      {options.map((o) => {
        const id = `${base}-${o.value}`;
        return (
          <label
            key={o.value}
            className="radio-row"
            htmlFor={id}
            data-disabled={o.disabled || undefined}
          >
            <RR.Item id={id} className="radio-dot" value={o.value} disabled={o.disabled} />
            <span className="radio-row__text">
              {o.label}
              {o.hint && <span className="radio-row__hint">{o.hint}</span>}
            </span>
          </label>
        );
      })}
    </RR.Root>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  const id = useId();
  return (
    <label className="switch-row" htmlFor={id}>
      <RSw.Root id={id} className="switch" checked={checked} onCheckedChange={onChange}>
        <RSw.Thumb className="switch__thumb" />
      </RSw.Root>
      {label}
    </label>
  );
}

export interface SegmentedProps<V extends string> {
  value: V;
  onChange(value: V): void;
  options: { value: V; label: ReactNode; icon?: ReactNode; title?: string }[];
  'aria-label': string;
}

export function Segmented<V extends string>({
  value,
  onChange,
  options,
  ...rest
}: SegmentedProps<V>) {
  return (
    <RT.Root
      type="single"
      className="segmented"
      value={value}
      onValueChange={(v) => v && onChange(v as V)}
      aria-label={rest['aria-label']}
    >
      {options.map((o) => (
        <RT.Item key={o.value} value={o.value} className="segmented__item" title={o.title}>
          {o.icon}
          {o.label}
        </RT.Item>
      ))}
    </RT.Root>
  );
}

export interface CollapsibleProps {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Collapsible({ label, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="collapsible">
      <button
        type="button"
        className="collapsible__trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={15} />
        {label}
      </button>
      {open && (
        <div id={id} className="collapsible__content">
          {children}
        </div>
      )}
    </div>
  );
}
