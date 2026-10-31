import type { ReactNode } from 'react';
import * as RT from '@radix-ui/react-tooltip';
import { Kbd } from './Kbd';

export const TooltipProvider = RT.Provider;

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="tip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
          {shortcut && <Kbd keys={shortcut} />}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
