import { afterEach, beforeEach, vi } from 'vitest';
import {
  mapUsage,
  buildBeacon,
  sendTelemetryBeacon,
  isTelemetryOptedOut,
  TELEMETRY_OPT_OUT_KEY,
} from './telemetry';

describe('mapUsage (FE §4.7: WebLLM usage.extra seconds → wire timing milliseconds)', () => {
  it('converts seconds to rounded milliseconds and passes tokens/tok-per-sec through', () => {
    const usage = {
      prompt_tokens: 512,
      completion_tokens: 256,
      extra: { e2e_latency_s: 4.2, time_to_first_token_s: 0.21, decode_tokens_per_s: 38.04 },
    };
    expect(mapUsage(usage, 1234)).toEqual({
      load_ms: 1234,
      ttft_ms: 210,
      total_ms: 4200,
      tokens_prompt: 512,
      tokens_completion: 256,
      tok_per_sec: 38.0,
    });
  });

  it('OMITS ttft_ms/total_ms/tok_per_sec (not 0) when usage is undefined so "unknown" ≠ "instant" (review §4)', () => {
    // Regression: encoding an absent measurement as 0 beaconed a missing generation as a
    // zero-latency success, dragging the inference percentiles toward 0 (backend `_inference`
    // skips IS NULL but not > 0). Omit the keys so the wire JSON carries no value → backend skips.
    const t = mapUsage(undefined, 0);
    expect(t).toEqual({ load_ms: 0, tokens_prompt: 0, tokens_completion: 0 });
    expect('ttft_ms' in t).toBe(false);
    expect('total_ms' in t).toBe(false);
    expect('tok_per_sec' in t).toBe(false);
    // The serialized beacon-bound object carries no zero-latency keys.
    expect(JSON.stringify(t)).not.toContain('ttft_ms');
    expect(JSON.stringify(t)).not.toContain('total_ms');
    expect(JSON.stringify(t)).not.toContain('tok_per_sec');
  });

  it('omits only the individually-absent timing fields, keeps the present ones', () => {
    // Usage present but WebLLM reported no TTFT / decode rate → those two omitted, total_ms kept.
    const t = mapUsage({ prompt_tokens: 3, extra: { e2e_latency_s: 2 } }, 0);
    expect(t.total_ms).toBe(2000);
    expect(t.tokens_prompt).toBe(3);
    expect('ttft_ms' in t).toBe(false);
    expect('tok_per_sec' in t).toBe(false);
  });

  it('preserves a genuine instant measurement (0 reported) as 0, distinct from absent', () => {
    // A real time_to_first_token_s of 0 is a measurement, not absence → keep the key as 0.
    const t = mapUsage({ extra: { time_to_first_token_s: 0, decode_tokens_per_s: 0 } }, 0);
    expect(t.ttft_ms).toBe(0);
    expect(t.tok_per_sec).toBe(0);
    expect('ttft_ms' in t).toBe(true);
    expect('tok_per_sec' in t).toBe(true);
  });

  it('falls back to usage.extra token counts when not present at the top level', () => {
    const usage = { extra: { prompt_tokens: 7, completion_tokens: 9, e2e_latency_s: 1 } };
    const t = mapUsage(usage, 0);
    expect(t.tokens_prompt).toBe(7);
    expect(t.tokens_completion).toBe(9);
    expect(t.total_ms).toBe(1000);
  });
});

describe('buildBeacon (no-raw-code / no-version invariant — API §5.5)', () => {
  it('builds a contract-shaped beacon and never includes code_text or version fields', () => {
    const beacon = buildBeacon({
      event: 'model_load',
      client_id: 'cid',
      code_hash: 'abc123',
      webgpu_supported: true,
      device_class: 'webgpu;vendor=apple;mem=high;chrome',
      browser: 'chrome',
      metrics: { load_ms: 1234, ok: true },
    });
    expect(beacon.event).toBe('model_load');
    expect(beacon.metrics).toEqual({ load_ms: 1234, ok: true });
    const serialized = JSON.stringify(beacon);
    expect(serialized).not.toContain('model_version');
    expect(serialized).not.toContain('prompt_version');
    expect(serialized).not.toContain('code_text');
  });

  it('defaults nullable fields to null', () => {
    const beacon = buildBeacon({
      event: 'webgpu_probe',
      client_id: 'cid',
      webgpu_supported: false,
      metrics: { ok: false },
    });
    expect(beacon.code_hash).toBeNull();
    expect(beacon.device_class).toBeNull();
    expect(beacon.browser).toBeNull();
    expect(beacon.error_kind).toBeNull();
  });
});

describe('isTelemetryOptedOut (storage-safe — N-15)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('returns true only when the opt-out flag is set', () => {
    expect(isTelemetryOptedOut()).toBe(false);
    localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
    expect(isTelemetryOptedOut()).toBe(true);
  });

  it('treats a throwing localStorage (Safari Private) as "not opted out" rather than crashing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => isTelemetryOptedOut()).not.toThrow();
    expect(isTelemetryOptedOut()).toBe(false);
  });
});

describe('sendTelemetryBeacon (auth=none, opt-out, no guest — FE §12/§8.D)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  const sample = () =>
    buildBeacon({ event: 'model_load', client_id: 'c', webgpu_supported: true, metrics: { ok: true } });

  it('posts via navigator.sendBeacon to /api/telemetry when not opted out', () => {
    const sb = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: sb });
    expect(sendTelemetryBeacon(sample())).toBe(true);
    expect(sb).toHaveBeenCalledOnce();
    expect(sb.mock.calls[0]![0]).toBe('/api/telemetry');
  });

  it('is a no-op when telemetry is opted out', () => {
    localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
    const sb = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: sb });
    expect(sendTelemetryBeacon(sample())).toBe(false);
    expect(sb).not.toHaveBeenCalled();
  });

  it('never calls fetch — no guest session is established to beacon', () => {
    const sb = vi.fn().mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: sb });
    vi.stubGlobal('fetch', fetchMock);
    sendTelemetryBeacon(sample());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('no-raw-code invariant (recursive — API §5.5 / backend.md §10.6)', () => {
  // Mirrors the backend scrub list; no code-like key may appear at ANY depth of a beacon.
  const CODE_LIKE_KEYS = [
    'code_text', 'code', 'source', 'source_code', 'snippet', 'content', 'file_contents',
  ];

  function assertNoCodeLikeKeys(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(assertNoCodeLikeKeys);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        expect(CODE_LIKE_KEYS).not.toContain(key.toLowerCase());
        assertNoCodeLikeKeys(child);
      }
    }
  }

  const events = ['model_load', 'generation', 'webgpu_probe', 'funnel_stage', 'error'] as const;

  it.each(events)('beacon for %s carries no code-like key at any depth', (event) => {
    const beacon = buildBeacon({
      event,
      client_id: 'c',
      code_hash: 'deadbeef',
      webgpu_supported: true,
      device_class: 'webgpu;vendor=apple',
      browser: 'chrome',
      metrics: { load_ms: 10, ttft_ms: 5, tok_per_sec: 20, ok: true },
      error_kind: event === 'error' ? 'generation' : null,
    });
    assertNoCodeLikeKeys(beacon);
  });
});
