import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import i18n from '../i18n';
import { useUpdateLanguage } from '../queries/useAuth';
import { AuthContext } from './AuthProvider';
import type { UiLanguage } from '../types/api';

const LOCALE_KEY = 'tako.ui_language';

/** Guarded localStorage read — storage-blocked browsers throw on access; degrade to null. */
function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

/** Guarded localStorage write — a throw here (write-denied) would otherwise unmount the tree. */
function writeStoredLocale(value: UiLanguage): void {
  try {
    localStorage.setItem(LOCALE_KEY, value);
  } catch {
    // Persistence unavailable — the locale still applies in-memory for the session.
  }
}

function initialLocale(): UiLanguage {
  const stored = readStoredLocale();
  if (stored === 'en' || stored === 'ja') return stored;
  return (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

interface LocaleContextValue {
  locale: UiLanguage;
  setLocale: (l: UiLanguage) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * UI locale (FE §14). Persists to localStorage immediately and mirrors to the profile via
 * PATCH /api/auth/me ONLY for a signed-in, non-guest user (an anonymous/guest caller has no
 * profile, so the PATCH is skipped rather than left to reject 401 — N-20a). Keeps
 * `document.documentElement.lang` in sync so screen readers / SEO see the active locale.
 * Distinct from a review's content language (ReviewSession.language).
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLanguage>(() => {
    const l = initialLocale();
    void i18n.changeLanguage(l);
    return l;
  });
  const updateLanguage = useUpdateLanguage();

  // Sync <html lang> to the active locale on mount and whenever it changes. setLocale and
  // the reconcile branch set it eagerly too, but this covers the initial render for a returning
  // visitor whose stored locale differs from the document's default.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Reconcile to the signed-in profile's ui_language. Read the principal tolerantly (null outside an
  // AuthProvider) and adopt the profile value ONCE per principal, so a later local toggle is never
  // clobbered by a re-render (FE §14: profile ui_language → localStorage → default precedence).
  const user = useContext(AuthContext)?.user ?? null;
  const reconciledForUserRef = useRef<string | null>(null);
  useEffect(() => {
    if (user && user.ui_language && reconciledForUserRef.current !== user.id) {
      reconciledForUserRef.current = user.id;
      if (user.ui_language !== locale) {
        setLocaleState(user.ui_language);
        writeStoredLocale(user.ui_language);
        void i18n.changeLanguage(user.ui_language);
        document.documentElement.lang = user.ui_language; // keep <html lang> in sync (a11y/SEO)
      }
    }
    if (!user) reconciledForUserRef.current = null;
  }, [user, locale]);

  const setLocale = useCallback(
    (l: UiLanguage) => {
      setLocaleState(l);
      writeStoredLocale(l);
      void i18n.changeLanguage(l);
      document.documentElement.lang = l; // keep <html lang> in sync with the active locale
      // Mirror to the profile only for a signed-in, non-guest user — an anonymous/guest caller has
      // no profile to PATCH, so firing it just yields an unhandled 401 on every toggle.
      if (user && !user.is_guest) updateLanguage.mutate({ ui_language: l });
    },
    [updateLanguage, user],
  );

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider');
  return ctx;
}
