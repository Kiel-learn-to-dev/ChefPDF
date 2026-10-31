import { useTranslation } from 'react-i18next';
import * as RT from '@radix-ui/react-tabs';
import { FUNCTION_TABS, READY_TABS, useUi, type FunctionTab } from './state/ui';

/** Xem · Trang · Chỉnh sửa · Ghi chú · Form · Ký & Bảo mật · Xuất · Quy trình */
export function FunctionTabs() {
  const { t } = useTranslation();
  const tab = useUi((s) => s.functionTab);
  const set = useUi((s) => s.set);
  return (
    <RT.Root
      value={tab}
      onValueChange={(v) => set({ functionTab: v as FunctionTab, tool: 'select' })}
      activationMode="automatic"
    >
      <RT.List className="ftabs" aria-label={t('shell.functions')}>
        {FUNCTION_TABS.map((id) => (
          <RT.Trigger
            key={id}
            value={id}
            className="ftab"
            data-ready={READY_TABS.has(id) || undefined}
          >
            {t(`tabs.${id}`)}
          </RT.Trigger>
        ))}
      </RT.List>
    </RT.Root>
  );
}
