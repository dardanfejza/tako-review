import { useCallback, useEffect } from 'react';
import { buildBeacon, sendTelemetryBeacon, type BeaconInput } from '../lib/telemetry';
import { getOrCreateClientId } from '../lib/clientId';

/**
 * Beacon helper (FE §12). Stamps the anonymous client_id and fires fire-and-forget via
 * navigator.sendBeacon (auth='none'). Honors the opt-out inside sendTelemetryBeacon.
 * Returns whether the beacon was actually queued (false on opt-out / sendBeacon failure).
 */
export function useTelemetry() {
  return useCallback(
    (input: Omit<BeaconInput, 'client_id'>): boolean =>
      sendTelemetryBeacon(buildBeacon({ ...input, client_id: getOrCreateClientId() })),
    [],
  );
}

/** sessionStorage guard for the once-per-browser-session `visit` funnel beacon. */
export const VISIT_BEACON_KEY = 'tako.visit_beacon_sent';

/**
 * The `visit` funnel producer (metrics gap #6): one `funnel_stage`/`stage:'visit'` beacon per
 * browser session, fired from a hook whose mount is UNCONDITIONAL on the workspace page so it
 * counts visitors who bounce before the WebGPU probe resolves (pre-probe — `webgpu_supported`
 * is therefore reported `false` = "not known supported"; the funnel collector keys on
 * event+stage only). The sessionStorage guard dedupes remounts/StrictMode double-effects and is
 * set ONLY when the beacon was actually queued, so an opted-out user (sendTelemetryBeacon
 * returns false, honoring the existing opt-out) is simply never counted, and a transient
 * sendBeacon failure retries on the next mount. Storage errors never break the app.
 */
export function useVisitBeacon(): void {
  const beacon = useTelemetry();
  useEffect(() => {
    try {
      if (sessionStorage.getItem(VISIT_BEACON_KEY) === 'true') return;
    } catch {
      // Storage unavailable (Safari Private) → fall through; the effect's once-per-mount
      // semantics still bound the beacon to one per page load.
    }
    const queued = beacon({
      event: 'funnel_stage',
      webgpu_supported: false, // pre-probe: support is unknown at visit time
      metrics: { ok: true, stage: 'visit' },
    });
    if (!queued) return; // opted out / sendBeacon failed → leave the guard unset (retry next mount)
    try {
      sessionStorage.setItem(VISIT_BEACON_KEY, 'true');
    } catch {
      // Guard unset on storage failure — worst case is an extra visit count, never a crash.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount; beacon is stable
  }, []);
}
