import type { ReactNode } from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as CM from '@radix-ui/react-context-menu';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Kbd } from './Kbd';

/** Declarative menu entries shared by dropdown and context menus. */
export type MenuEntry =
  | {
      type?: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      onSelect(): void;
    }
  | { type: 'separator'; id: string }
  | { type: 'label'; id: string; label: string };

type Primitives = typeof DM | typeof CM;

function renderEntries(P: Primitives, entries: MenuEntry[]) {
  return entries.map((e) => {
    if (e.type === 'separator') return <P.Separator key={e.id} className="menu__separator" />;
    if (e.type === 'label')
      return (
        <P.Label key={e.id} className="menu__label">
          {e.label}
        </P.Label>
      );
    return (
      <P.Item
        key={e.id}
        className={clsx('menu__item', e.danger && 'menu__item--danger')}
        disabled={e.disabled}
        onSelect={() => e.onSelect()}
      >
        {e.checked !== undefined ? (
          <span className="menu__check">{e.checked && <Check size={14} />}</span>
        ) : (
          e.icon
        )}
        <span className="menu__item-label">{e.label}</span>
        {e.shortcut && <Kbd keys={e.shortcut} />}
      </P.Item>
    );
  });
}

export interface DropdownMenuProps {
  trigger: ReactNode;
  entries: MenuEntry[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function DropdownMenu({
  trigger,
  entries,
  align = 'start',
  side = 'bottom',
}: DropdownMenuProps) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className="menu" align={align} side={side} sideOffset={4} collisionPadding={8}>
          {renderEntries(DM, entries)}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface ContextMenuProps {
  entries: MenuEntry[];
  children: ReactNode;
  onOpenChange?(open: boolean): void;
}

export function ContextMenu({ entries, children, onOpenChange }: ContextMenuProps) {
  return (
    <CM.Root onOpenChange={onOpenChange} modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          {renderEntries(CM, entries)}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
