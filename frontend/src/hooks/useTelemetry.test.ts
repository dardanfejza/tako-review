import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTelemetry, useVisitBeacon, VISIT_BEACON_KEY } from './useTelemetry';
import { sendTelemetryBeacon, TELEMETRY_OPT_OUT_KEY } from '../lib/telemetry';

vi.mock('../lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry')>();
  return { ...actual, sendTelemetryBeacon: vi.fn(() => true) };
});

const sent = vi.mocked(sendTelemetryBeacon);

beforeEach(() => {
  sent.mockReset();
  sent.mockReturnValue(true);
  sessionStorage.removeItem(VISIT_BEACON_KEY);
  localStorage.removeItem(TELEMETRY_OPT_OUT_KEY);
});

describe('useTelemetry (beacon helper — FE §12)', () => {
  it('stamps the anonymous client_id onto every beacon and returns the queued flag', () => {
    const { result } = renderHook(() => useTelemetry());
    const queued = result.current({
      event: 'webgpu_probe',
      webgpu_supported: true,
      metrics: { ok: true },
    });
    expect(queued).toBe(true);
    expect(sent).toHaveBeenCalledOnce();
    const beacon = sent.mock.calls[0]![0];
    expect(beacon.event).toBe('webgpu_probe');
    expect(typeof beacon.client_id).toBe('string');
    expect(beacon.client_id.length).toBeGreaterThan(0);
  });

  it('propagates a false queued flag (opt-out / sendBeacon failure) to the caller', () => {
    sent.mockReturnValue(false);
    const { result } = renderHook(() => useTelemetry());
    expect(result.current({ event: 'error', webgpu_supported: false, metrics: { ok: false } })).toBe(
      false,
    );
  });
});

describe('useVisitBeacon (visit funnel producer — metrics F2 stage="visit")', () => {
  it('fires ONE funnel_stage/visit beacon on mount and sets the session guard', () => {
    renderHook(() => useVisitBeacon());
    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toMatchObject({
      event: 'funnel_stage',
      webgpu_supported: false, // pre-probe: support unknown at visit time
      metrics: { ok: true, stage: 'visit' },
    });
    expect(sessionStorage.getItem(VISIT_BEACON_KEY)).toBe('true');
  });

  it('dedupes within a browser session: a remount with the guard set sends nothing', () => {
    const first = renderHook(() => useVisitBeacon());
    first.unmount();
    expect(sent).toHaveBeenCalledOnce();
    renderHook(() => useVisitBeacon()); // second page-level mount, same session
    expect(sent).toHaveBeenCalledOnce(); // still exactly one
  });

  it('does not fire at all when the guard is already set (e.g. StrictMode double-effect)', () => {
    sessionStorage.setItem(VISIT_BEACON_KEY, 'true');
    renderHook(() => useVisitBeacon());
    expect(sent).not.toHaveBeenCalled();
  });

  it('leaves the guard UNSET when the beacon was not queued, so the next mount retries', () => {
    sent.mockReturnValue(false); // transient sendBeacon failure (or opt-out)
    const first = renderHook(() => useVisitBeacon());
    first.unmount();
    expect(sessionStorage.getItem(VISIT_BEACON_KEY)).toBeNull();

    sent.mockReturnValue(true); // delivery works again
    renderHook(() => useVisitBeacon());
    expect(sent).toHaveBeenCalledTimes(2); // retried on the next mount
    expect(sessionStorage.getItem(VISIT_BEACON_KEY)).toBe('true');
  });

  it('respects the existing telemetry opt-out end-to-end (nothing reaches sendBeacon)', async () => {
    // Use the REAL sendTelemetryBeacon (the opt-out lives inside it) with a spied transport.
    const actual = await vi.importActual<typeof import('../lib/telemetry')>('../lib/telemetry');
    sent.mockImplementation(actual.sendTelemetryBeacon);
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
    try {
      renderHook(() => useVisitBeacon());
      expect(sendBeacon).not.toHaveBeenCalled(); // opted out → nothing leaves the browser
      expect(sessionStorage.getItem(VISIT_BEACON_KEY)).toBeNull(); // and the visitor is not marked counted
    } finally {
      delete (navigator as { sendBeacon?: unknown }).sendBeacon;
    }
  });

  it('survives an unavailable sessionStorage (Safari Private) — still beacons, never throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      expect(() => renderHook(() => useVisitBeacon())).not.toThrow();
      expect(sent).toHaveBeenCalledOnce(); // the visit still counts; dedupe degrades to per-mount
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
