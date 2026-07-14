import type { CapabilityStatus } from '../types/review';
import { formatDeviceClass } from './deviceClass';

/**
 * A REAL staged WebGPU probe (FE §4.3) — presence of `navigator.gpu` is not enough. Each stage
 * failure classifies into an actionable status the UI maps to a localized message.
 */
export interface ProbeInput {
  secureContext: boolean;
  hasGpu?: boolean;
  adapter?: object | null;
  deviceError?: Error | null;
}

export function classifyProbe(i: ProbeInput): CapabilityStatus {
  if (!i.secureContext) return 'needs_https';
  if (!i.hasGpu) return 'no_webgpu';
  if (i.adapter === null || i.adapter === undefined) return 'no_adapter';
  if (i.deviceError) {
    // \boom\b avoids matching the substring in words like "boom".
    return /out of memory|\boom\b/i.test(i.deviceError.message) ? 'oom' : 'device_init_failed';
  }
  return 'ok';
}

interface GpuDeviceLike {
  lost?: Promise<{ reason?: string; message?: string }>;
}
interface GpuAdapterLike {
  requestDevice(): Promise<GpuDeviceLike>;
  info?: { vendor?: string; architecture?: string };
}
export interface NavigatorLike {
  gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> };
}

export interface ProbeResult {
  status: CapabilityStatus;
  deviceClass: string;
}

export interface RunProbeOptions {
  secureContext: boolean;
  navigator: NavigatorLike;
  browser?: string;
  /** Registered on the PROBE device's `device.lost`. Note this is the capability-probe device, not
   *  the inference worker's device — a loss DURING generation is caught separately, by classifying
   *  the rejected `generate()` in EngineProvider (`isDeviceLostError`). Both routes converge on the
   *  DEVICE_LOST recovery state (re-probe → reload). (FE §4.3 stage 5 / §7.) */
  onDeviceLost?: () => void;
}

export async function runCapabilityProbe(opts: RunProbeOptions): Promise<ProbeResult> {
  const { secureContext, navigator: nav, browser } = opts;
  const hasGpu = !!nav.gpu;

  if (!secureContext || !hasGpu) {
    return {
      status: classifyProbe({ secureContext, hasGpu }),
      deviceClass: formatDeviceClass({ webgpu: false }),
    };
  }

  let adapter: GpuAdapterLike | null = null;
  try {
    adapter = await nav.gpu!.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) {
    return { status: 'no_adapter', deviceClass: formatDeviceClass({ webgpu: false }) };
  }

  let deviceError: Error | null = null;
  let device: GpuDeviceLike | null = null;
  try {
    device = await adapter.requestDevice();
  } catch (e) {
    deviceError = e instanceof Error ? e : new Error(String(e));
  }

  const status = classifyProbe({ secureContext, hasGpu, adapter, deviceError });
  if (status === 'ok' && device?.lost && opts.onDeviceLost) {
    void device.lost.then(() => opts.onDeviceLost?.());
  }

  return {
    status,
    deviceClass: formatDeviceClass({ webgpu: status === 'ok', vendor: adapter.info?.vendor, browser }),
  };
}
