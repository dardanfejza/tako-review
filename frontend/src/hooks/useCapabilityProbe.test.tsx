import { act, renderHook, waitFor } from '@testing-library/react';
import { useCapabilityProbe } from './useCapabilityProbe';

describe('useCapabilityProbe', () => {
  it('resolves to ok with an injected working adapter', async () => {
    const { result } = renderHook(() =>
      useCapabilityProbe({
        secureContext: true,
        browser: 'chrome',
        navigator: {
          gpu: {
            requestAdapter: async () => ({ info: { vendor: 'apple' }, requestDevice: async () => ({}) }),
          },
        },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.deviceClass).toContain('webgpu');
  });

  it('resolves to no_webgpu when navigator.gpu is absent', async () => {
    const { result } = renderHook(() =>
      useCapabilityProbe({ secureContext: true, navigator: {} }),
    );
    await waitFor(() => expect(result.current.status).toBe('no_webgpu'));
  });

  it('resolves to needs_https when not a secure context', async () => {
    const { result } = renderHook(() =>
      useCapabilityProbe({ secureContext: false, navigator: {} }),
    );
    await waitFor(() => expect(result.current.status).toBe('needs_https'));
  });

  it('reprobe() resolves to the capability status so DEVICE_LOST recovery can branch on it', async () => {
    const { result } = renderHook(() =>
      useCapabilityProbe({
        secureContext: true,
        browser: 'chrome',
        navigator: {
          gpu: { requestAdapter: async () => ({ info: { vendor: 'apple' }, requestDevice: async () => ({}) }) },
        },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ok'));
    let status: unknown;
    await act(async () => {
      status = await result.current.reprobe();
    });
    expect(status).toBe('ok');
  });
});
