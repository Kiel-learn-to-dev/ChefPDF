import { useTranslation } from 'react-i18next';
import * as RT from '@radix-ui/react-tabs';
import { Images, ListTree, PanelLeftClose } from 'lucide-react';
import type { DocTab } from './state/documents';
import { useUi, type SidebarTab } from './state/ui';
import { IconButton } from '../components/Button';
import { Tooltip } from '../components/Tooltip';
import { ThumbnailList } from '../features/viewer/ThumbnailList';
import { OutlineTree } from '../features/viewer/OutlineTree';

/** Left sidebar (B3): thumbnails / outline. */
export function Sidebar({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const tab = useUi((s) => s.sidebarTab);
  const set = useUi((s) => s.set);
  return (
    <aside className="sidenav" aria-label={t('sidebar.label')}>
      <RT.Root
        value={tab}
        onValueChange={(v) => set({ sidebarTab: v as SidebarTab })}
        className="sidenav__tabs"
      >
        <div className="sidenav__head">
          <RT.List className="sidenav__tablist" aria-label={t('sidebar.label')}>
            <Tooltip content={t('sidebar.thumbnails')}>
              <RT.Trigger
                value="thumbnails"
                className="sidenav__tab"
                aria-label={t('sidebar.thumbnails')}
              >
                <Images size={16} />
              </RT.Trigger>
            </Tooltip>
            <Tooltip content={t('sidebar.outline')}>
              <RT.Trigger
                value="outline"
                className="sidenav__tab"
                aria-label={t('sidebar.outline')}
              >
                <ListTree size={16} />
              </RT.Trigger>
            </Tooltip>
          </RT.List>
          <span className="sidenav__title">{t(`sidebar.${tab}`)}</span>
          <IconButton
            size="sm"
            label={t('sidebar.hide')}
            icon={<PanelLeftClose size={15} />}
            onClick={() => set({ sidebarOpen: false })}
          />
        </div>
        <RT.Content value="thumbnails" className="sidenav__content">
          <ThumbnailList doc={doc} />
        </RT.Content>
        <RT.Content value="outline" className="sidenav__content">
          <OutlineTree doc={doc} />
        </RT.Content>
      </RT.Root>
    </aside>
  );
}
