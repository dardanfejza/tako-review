import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
import { installManifestAlias } from './manifestAliasCache';

/**
 * Web Worker hosting the MLC engine (FE §4.1). The ~1 GB load + the decode loop run here, off the
 * main thread, so React stays responsive during download and streaming. Bundled by Vite as an
 * ES-module worker (worker.format = 'es'). Not unit-tested — exercised on the real WebGPU path.
 */

// Defensive bridge for MLC repos that only ship the older `ndarray-cache.json` weight manifest
// under the `tensor-cache.json` name web-llm 0.2.84 requests (a pure rename — see
// manifestAliasCache.ts). No-op for the currently pinned model, which ships both. MUST run before
// the engine loads.
installManifestAlias();

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (event: MessageEvent): void => {
  handler.onmessage(event);
};
