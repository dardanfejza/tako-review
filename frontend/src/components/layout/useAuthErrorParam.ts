import { useEffect, useState } from 'react';

/** auth_error reasons (API §5.2) → localized message keys. */
const AUTH_ERROR_KEYS: Record<string, string> = {
  state_mismatch: 'errors.authStateMismatch',
  github_error: 'errors.authGithubError',
  db_error: 'errors.authDbError',
};

/**
 * Reads `?auth_error=` once at `/` (there is no SPA /auth/callback route — FE §9), returns the
 * localized message key, and strips the param. The strip must run in a child mount effect before
 * AuthProvider's auto-guest effect (it captures `hadAuthError` at render). Returns null otherwise.
 */
export function useAuthErrorParam(): { errorKey: string | null; dismiss: () => void } {
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('auth_error');
    if (!reason) return;
    setErrorKey(AUTH_ERROR_KEYS[reason] ?? 'errors.generic');
    params.delete('auth_error');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);
  return { errorKey, dismiss: () => setErrorKey(null) };
}
