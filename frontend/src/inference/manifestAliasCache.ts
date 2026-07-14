/**
 * Cache shim — defensive alias for the weight-manifest rename some MLC-converted repos still ship.
 *
 * web-llm 0.2.84 fetches the weight manifest as `tensor-cache.json`. A number of MLC weight
 * conversions (built for the 0.2.48-era runtime, or with an older `mlc_llm convert_weight`) only
 * ship the predecessor `ndarray-cache.json` — a PURE RENAME: identical schema (verified — same
 * metadata/record/shard fields), so the file the model already serves is exactly what 0.2.84 wants
 * under the new name. The currently pinned model repo (see appConfig.ts) ships both filenames, so
 * this shim is a no-op for it today; it stays wired in as cheap insurance against swapping to a
 * repo that only ships the older name.
 *
 * The runtime loads weights via the Cache API, and `Cache.add(tensorUrl)` rejects on the 404. We
 * intercept ONLY that one filename: fetch the real `ndarray-cache.json` and `put()` it under the
 * requested `tensor-cache.json` key. Every other request (config, wasm, tokenizer, weight shards)
 * passes through untouched.
 *
 * WHY a shim and not a downgrade: some reference chat UIs pin 0.2.48 via an `esm.run` CDN import
 * (which reads `ndarray-cache.json` natively). We instead install web-llm as a normal npm
 * dependency, so the exact version is lockfile-pinned and supply-chain-auditable, and we stay on
 * the current supported runtime (0.2.84) rather than a frozen CDN snapshot. The shim is the small
 * price for keeping both properties.
 */

const REQUESTED = '/tensor-cache.json'; // what web-llm 0.2.84 asks for
const ACTUAL = '/ndarray-cache.json'; // what the model actually ships

function requestUrl(request: RequestInfo | URL): string {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

/** The path portion of a URL, so the alias match ignores any `?query`/`#fragment` that would
 *  slip past a raw `endsWith`. Falls back to the raw string if the URL can't be parsed. */
function requestPath(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url;
  }
}

/**
 * Patch `cacheProto.add` to alias the renamed manifest. Returns a disposer that restores the
 * original (the worker installs once and never restores; the disposer exists for tests).
 */
export function installManifestAlias(
  cacheProto: Cache = Cache.prototype,
  fetchFn: typeof fetch = fetch,
): () => void {
  const original = cacheProto.add;
  cacheProto.add = async function (this: Cache, request: RequestInfo | URL): Promise<void> {
    const url = requestUrl(request);
    if (requestPath(url).endsWith(REQUESTED)) {
      const res = await fetchFn(url.replace(REQUESTED, ACTUAL));
      // Preserve Cache.add's contract: a bad response must reject, not silently cache a 404 body.
      if (!res.ok) throw new TypeError(`manifest alias fetch failed: HTTP ${res.status} for ${url}`);
      return this.put(url, res); // cache the real bytes under the requested (tensor-cache) key
    }
    return original.call(this, request);
  };
  return () => {
    cacheProto.add = original;
  };
}
