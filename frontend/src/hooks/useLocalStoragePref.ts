import { useCallback, useState } from 'react';

/** Tiny typed boolean localStorage pref (FE §3). Used for the telemetry opt-out (§12). */
export function useLocalStoragePref(
  key: string,
  defaultValue: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultValue : raw === 'true';
    } catch {
      // Storage blocked (Safari Private Browsing, disabled storage) — reading in the useState
      // initializer would otherwise throw during render and white-screen the app. Fall back to
      // the default; the pref simply isn't persisted this session (clientId.ts pattern).
      return defaultValue;
    }
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // Write denied — keep the in-memory value; never let a storage error break the app.
      }
    },
    [key],
  );

  return [value, set];
}
