/**
 * Coarse device class for the perf telemetry story (FE §6.4). GPU vendor + memory bucket +
 * browser only — explicitly NOT invasive fingerprinting. The probe wrapper that reads the
 * WebGPU adapter is wired in the capability probe (Slice 3); this is the pure formatter.
 */
export interface DeviceDescriptor {
  webgpu: boolean;
  vendor?: string;
  memBucket?: 'low' | 'medium' | 'high';
  browser?: string;
}

export function formatDeviceClass(d: DeviceDescriptor): string {
  if (!d.webgpu) return 'no-webgpu';
  const parts = ['webgpu'];
  if (d.vendor) parts.push(`vendor=${d.vendor}`);
  if (d.memBucket) parts.push(`mem=${d.memBucket}`);
  if (d.browser) parts.push(d.browser);
  return parts.join(';');
}

export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

/** Coarse browser family from a UA string. Order matters: Edge/Chrome UAs both contain "Chrome". */
export function detectBrowser(ua: string): BrowserName {
  if (/edg/i.test(ua)) return 'edge';
  if (/chrome|chromium|crios/i.test(ua)) return 'chrome';
  if (/firefox|fxios/i.test(ua)) return 'firefox';
  if (/safari/i.test(ua)) return 'safari';
  return 'other';
}
