import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ja from './ja.json';

/** UI catalogs (FE §14). Keys are namespaced; the parity test enforces EN ⇄ JA completeness. */
export const resources = {
  en: { translation: en },
  ja: { translation: ja },
} as const;

export const SUPPORTED_LANGUAGES = ['en', 'ja'] as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
});

export default i18n;
