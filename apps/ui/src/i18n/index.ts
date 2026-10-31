import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { LanguageSetting } from '@chef/contracts';
import vi from './vi.json';
import en from './en.json';

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: 'vi',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
});

export function setLanguage(lang: LanguageSetting) {
  if (i18n.language !== lang) void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export const LANGUAGES: { value: LanguageSetting; label: string }[] = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
];
