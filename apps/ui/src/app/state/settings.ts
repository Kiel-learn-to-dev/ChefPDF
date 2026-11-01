import { create } from 'zustand';
import type { Settings } from '@chef/contracts';
import { chef } from '../../lib/bridge';

export const fallbackSettings: Settings = {
  version: 1,
  language: 'vi',
  theme: 'system',
  defaultSaveDir: null,
  recentFiles: [],
  prefs: {},
  scanPresets: [],
  knownPfxFiles: [],
  lastDriverPath: null,
  signTemplates: [],
  tsaUrls: [],
  overlayPresets: [],
  compressPresets: [],
  userName: '',
};

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<void>;
  addRecent(path: string): Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: fallbackSettings,
  loaded: false,
  async load() {
    try {
      const settings = await chef().settings.get();
      set({ settings, loaded: true });
      return settings;
    } catch {
      set({ loaded: true });
      return fallbackSettings;
    }
  },
  async update(patch) {
    // Optimistic so the UI reacts immediately (theme, language).
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    const settings = await chef().settings.set(patch);
    set({ settings });
  },
  async addRecent(path) {
    const settings = await chef().settings.addRecent(path);
    set({ settings });
  },
}));
