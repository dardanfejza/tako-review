import { useCallback, useEffect, useRef, useState } from 'react';
import { runCapabilityProbe, type NavigatorLike } from '../lib/capability';
import { detectBrowser } from '../lib/deviceClass';
import type { CapabilityStatus } from '../types/review';
import type { ErrorKind } from '../types/api';
import { useTelemetry } from './useTelemetry';

export interface CapabilityProbeState {
  status: CapabilityStatus | 'probing';
  deviceClass: string | null;
}

/** Injectable deps make the hook unit-testable without a real WebGPU browser. */
export interface CapabilityProbeDeps {
  secureContext?: boolean;
  navigator?: NavigatorLike;
  browser?: string;
  /** Wired by the workspace to the state machine on mid-session device loss (FE §7 DEVICE_LOST). */
  onDeviceLost?: () => void;
}

/** Maps a capability status to the telemetry error_kind enum (API §5.5). HTTPS failure → null. */
function toErrorKind(status: CapabilityStatus): ErrorKind | null {
  switch (status) {
    case 'no_webgpu':
      return 'no_webgpu';
    case 'no_adapter':
    case 'device_init_failed':
      return 'no_adapter';
    case 'oom':
      return 'oom';
    default:
      return null; // ok, needs_https (the error_kind enum has no HTTPS value by design)
  }
}

/**
 * Runs the staged WebGPU probe on mount, classifies the result, and beacons `webgpu_probe`
 * (FE §4.3/§6.1). Returns the status + device class and a `reprobe` for the DEVICE_LOST recovery.
 */
export function useCapabilityProbe(deps: CapabilityProbeDeps = {}) {
  const [state, setState] = useState<CapabilityProbeState>({ status: 'probing', deviceClass: null });
  const beacon = useTelemetry();
  const started = useRef(false);

  const probe = useCallback(async (): Promise<CapabilityStatus> => {
    const secureContext = deps.secureContext ?? window.isSecureContext;
    const nav = deps.navigator ?? (navigator as unknown as NavigatorLike);
    const browser = deps.browser ?? detectBrowser(navigator.userAgent);

    const result = await runCapabilityProbe({
      secureContext,
      navigator: nav,
      browser,
      onDeviceLost: deps.onDeviceLost,
    });
    setState({ status: result.status, deviceClass: result.deviceClass });
    beacon({
      event: 'webgpu_probe',
      webgpu_supported: result.status === 'ok',
      device_class: result.deviceClass,
      browser,
      metrics: { ok: result.status === 'ok' },
      error_kind: toErrorKind(result.status),
    });
    return result.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.secureContext, deps.navigator, deps.browser, deps.onDeviceLost, beacon]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void probe();
  }, [probe]);

  return { ...state, reprobe: probe };
}
