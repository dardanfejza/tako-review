import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useMe, useGuest, useLogout } from '../queries/useAuth';
import type { MeResponse } from '../types/api';

interface AuthContextValue {
  user: MeResponse | null;
  isLoading: boolean;
  signInGitHub: () => void;
  continueAsGuest: () => void;
  signOut: () => void;
}

/** Exported so peer providers (e.g. LocaleProvider) can read the principal tolerantly via
 *  `useContext(AuthContext)` (null outside a provider) without the throwing `useAuth` guard. */
export const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Session principal (FE §9). Bootstraps from GET /api/auth/me (401 → null). GitHub sign-in is a
 * full-page top-level redirect to the backend route (no pop-up, no SPA callback route — §9). Guest
 * mode populates directly from POST /api/auth/guest with no follow-up /me. `navigate` is injectable
 * for tests (real default: window.location.assign).
 */
export function AuthProvider({
  children,
  navigate,
}: {
  children: ReactNode;
  navigate?: (url: string) => void;
}) {
  const me = useMe();
  const guest = useGuest();
  const logout = useLogout();

  const signInGitHub = useCallback(() => {
    const go = navigate ?? ((url: string) => window.location.assign(url));
    go('/api/auth/github/login');
  }, [navigate]);

  const continueAsGuest = useCallback(() => guest.mutate(), [guest]);
  const signOut = useCallback(() => logout.mutate(), [logout]);

  // Guest is the default principal: once /me resolves to anonymous (and the page isn't showing a
  // sign-in error), establish a guest session so history/feedback work without a forced sign-in.
  // `autoGuested` makes it fire exactly once. `hadAuthError` is captured at render time because
  // AuthErrorBanner (a child) strips `?auth_error` in its mount effect BEFORE this parent effect runs.
  const autoGuested = useRef(false);
  const hadAuthError = useRef(
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('auth_error'),
  );
  useEffect(() => {
    if (autoGuested.current || hadAuthError.current) return;
    if (me.isLoading || me.data) return;
    autoGuested.current = true;
    guest.mutate();
  }, [me.isLoading, me.data, guest]);

  const value: AuthContextValue = {
    user: me.data ?? null,
    isLoading: me.isLoading,
    signInGitHub,
    continueAsGuest,
    signOut,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
