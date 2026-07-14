import { useCallback, useEffect, useRef } from 'react';
import { useLocalStoragePref } from './useLocalStoragePref';
import { TELEMETRY_OPT_OUT_KEY } from '../lib/telemetry';
import { useAuth } from '../providers/AuthProvider';
import { useUpdateProfile } from '../queries/useAuth';

/**
 * Telemetry opt-out preference (FE §12). The ENFORCEMENT path is unchanged: every toggle writes
 * localStorage `tako.telemetry_opt_out`, which isTelemetryOptedOut() reads synchronously per
 * beacon. Server persistence is a MIRROR for signed-in users only:
 *  - toggling ALSO PATCHes /api/auth/me { telemetry_opt_out } for a non-guest principal
 *    (guests have no profile to PATCH — the LocaleProvider N-20a rule);
 *  - on login / /me load the profile value is reconciled INTO localStorage ONCE per principal
 *    (server wins), exactly like LocaleProvider reconciles ui_language.
 */
export function useTelemetryPref(): [boolean, (next: boolean) => void] {
  const [optedOut, setStored] = useLocalStoragePref(TELEMETRY_OPT_OUT_KEY, false);
  const { user } = useAuth();
  const updateProfile = useUpdateProfile();

  // Adopt the signed-in profile's mirror ONCE per principal so a later local toggle is never
  // clobbered by a re-render (LocaleProvider's reconcile pattern). Guests are skipped: they can't
  // PATCH, so their server value is always the default and would erase a local opt-out.
  const reconciledForUserRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      user &&
      !user.is_guest &&
      typeof user.telemetry_opt_out === 'boolean' &&
      reconciledForUserRef.current !== user.id
    ) {
      reconciledForUserRef.current = user.id;
      if (user.telemetry_opt_out !== optedOut) setStored(user.telemetry_opt_out);
    }
    if (!user) reconciledForUserRef.current = null;
  }, [user, optedOut, setStored]);

  const setOptedOut = useCallback(
    (next: boolean) => {
      setStored(next); // enforcement: the beacon path reads this key synchronously
      if (user && !user.is_guest) updateProfile.mutate({ telemetry_opt_out: next });
    },
    [setStored, user, updateProfile],
  );

  return [optedOut, setOptedOut];
}
