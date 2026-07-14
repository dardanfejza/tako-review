import { describe, it, expect, vi } from 'vitest';
import { installManifestAlias } from './manifestAliasCache';

const BASE = 'https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC/resolve/main';
const TENSOR = `${BASE}/tensor-cache.json`;
const NDARRAY = `${BASE}/ndarray-cache.json`;

describe('manifestAliasCache (tensor-cache.json → ndarray-cache.json shim, FE model-load)', () => {
  it('aliases the renamed manifest and caches the real bytes under the REQUESTED key', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const proto = { add: vi.fn(), put } as unknown as Cache;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    installManifestAlias(proto, fetchFn);

    await proto.add(TENSOR);

    expect(fetchFn).toHaveBeenCalledWith(NDARRAY); // fetched the file the model actually ships
    expect(put).toHaveBeenCalledWith(TENSOR, { ok: true }); // cached under the name web-llm asked for
  });

  it('leaves every other request to the original Cache.add (config, wasm, weight shards)', async () => {
    const original = vi.fn().mockResolvedValue(undefined);
    const proto = { add: original, put: vi.fn() } as unknown as Cache;
    const fetchFn = vi.fn();
    installManifestAlias(proto, fetchFn);

    const shard = `${BASE}/params_shard_0.bin`;
    await proto.add(shard);

    expect(original).toHaveBeenCalledWith(shard);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects (does not cache) when the aliased fetch fails — preserves Cache.add semantics', async () => {
    const put = vi.fn();
    const proto = { add: vi.fn(), put } as unknown as Cache;
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    installManifestAlias(proto, fetchFn);

    await expect(proto.add(TENSOR)).rejects.toThrow(/404/);
    expect(put).not.toHaveBeenCalled();
  });

  it('resolves the URL from string, URL, and Request-like inputs', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const proto = { add: vi.fn(), put } as unknown as Cache;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    installManifestAlias(proto, fetchFn);

    await proto.add(new URL(TENSOR));
    await proto.add({ url: TENSOR } as Request);

    expect(fetchFn).toHaveBeenNthCalledWith(1, NDARRAY);
    expect(fetchFn).toHaveBeenNthCalledWith(2, NDARRAY);
  });

  it('aliases even when the manifest URL carries a query string (pathname match, not raw endsWith)', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const proto = { add: vi.fn(), put } as unknown as Cache;
    const fetchFn = vi.fn().mockResolvedValue({ ok: true } as Response);
    installManifestAlias(proto, fetchFn);

    await proto.add(`${TENSOR}?t=123`);

    expect(fetchFn).toHaveBeenCalledWith(`${NDARRAY}?t=123`); // a `?query` must not bypass the alias
    expect(put).toHaveBeenCalledWith(`${TENSOR}?t=123`, { ok: true });
  });

  it('the disposer restores the original add', () => {
    const original = vi.fn();
    const proto = { add: original, put: vi.fn() } as unknown as Cache;
    const dispose = installManifestAlias(proto, vi.fn());
    expect(proto.add).not.toBe(original);
    dispose();
    expect(proto.add).toBe(original);
  });
});
