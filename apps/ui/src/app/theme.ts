import { useEffect } from 'react';
import type { ThemeSetting } from '@chef/contracts';

export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === 'system') return prefersDark ? 'dark' : 'light';
  return setting;
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(setting: ThemeSetting) {
  document.documentElement.dataset.theme = resolveTheme(setting, systemPrefersDark());
}

/** Keep <html data-theme> in sync with the setting and the OS preference. */
export function useThemeSync(setting: ThemeSetting) {
  useEffect(() => {
    applyTheme(setting);
    if (setting !== 'system' || typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setting]);
}
