import { classifyProbe, runCapabilityProbe } from './capability';

describe('classifyProbe (staged WebGPU classification — FE §4.3)', () => {
  it('needs_https when not a secure context', () => {
    expect(classifyProbe({ secureContext: false })).toBe('needs_https');
  });
  it('no_webgpu when secure but navigator.gpu is absent', () => {
    expect(classifyProbe({ secureContext: true, hasGpu: false })).toBe('no_webgpu');
  });
  it('no_adapter when requestAdapter returned null', () => {
    expect(classifyProbe({ secureContext: true, hasGpu: true, adapter: null })).toBe('no_adapter');
  });
  it('oom when device init failed with an out-of-memory error', () => {
    expect(
      classifyProbe({
        secureContext: true,
        hasGpu: true,
        adapter: {},
        deviceError: new Error('Out of memory while creating device'),
      }),
    ).toBe('oom');
  });
  it('device_init_failed for other device errors', () => {
    expect(
      classifyProbe({ secureContext: true, hasGpu: true, adapter: {}, deviceError: new Error('boom') }),
    ).toBe('device_init_failed');
  });
  it('ok when all stages pass', () => {
    expect(classifyProbe({ secureContext: true, hasGpu: true, adapter: {} })).toBe('ok');
  });
});

describe('runCapabilityProbe (FE §4.3)', () => {
  it('returns no_webgpu when navigator.gpu is missing', async () => {
    const r = await runCapabilityProbe({ secureContext: true, navigator: {} });
    expect(r.status).toBe('no_webgpu');
    expect(r.deviceClass).toBe('no-webgpu');
  });

  it('returns no_adapter when requestAdapter resolves null', async () => {
    const r = await runCapabilityProbe({
      secureContext: true,
      navigator: { gpu: { requestAdapter: async () => null } },
    });
    expect(r.status).toBe('no_adapter');
  });

  it('returns ok with a webgpu device class and registers device.lost', async () => {
    let resolveLost: () => void = () => {};
    const lost = new Promise<{ reason?: string }>((res) => {
      resolveLost = () => res({ reason: 'destroyed' });
    });
    let lostFired = false;
    const r = await runCapabilityProbe({
      secureContext: true,
      browser: 'chrome',
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: 'apple' },
            requestDevice: async () => ({ lost }),
          }),
        },
      },
      onDeviceLost: () => {
        lostFired = true;
      },
    });
    expect(r.status).toBe('ok');
    expect(r.deviceClass).toContain('webgpu');
    expect(r.deviceClass).toContain('vendor=apple');
    resolveLost();
    await new Promise((res) => setTimeout(res, 0));
    expect(lostFired).toBe(true);
  });

  it('classifies an OOM device error', async () => {
    const r = await runCapabilityProbe({
      secureContext: true,
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            requestDevice: async () => {
              throw new Error('Out of memory');
            },
          }),
        },
      },
    });
    expect(r.status).toBe('oom');
  });
});
