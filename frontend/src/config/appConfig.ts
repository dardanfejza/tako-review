/**
 * Pinned model artifacts (supply-chain). This module is the single source of the model identity
 * sent to the backend. The wasm runtime (MODEL_LIB_URL) is pinned to a specific binary-mlc-llm-libs
 * commit SHA — not the moving `main` ref — so it is byte-reproducible. MODEL_HF_REVISION records the
 * intended weights commit but is NOT yet wired into the fetch URL (web-llm resolves the weights from
 * MODEL_HF_URL's default ref); pinning the weight fetch to that revision is a known follow-up.
 */
export const WEBLLM_VERSION = '0.2.84'; // also exact in package.json + lockfile
export const MODEL_ID = 'Qwen2.5-Coder-1.5B';
export const MODEL_HF_URL =
  'https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC';
export const MODEL_HF_REVISION = '0d603ead13079d75115c46fc5429401fd5166509';

// HARD-PINNED wasm (Qwen2 runtime). FROZEN full string — do NOT rebuild from
// `modelLibURLPrefix + modelVersion`. web-llm 0.2.84's lib for Qwen2-1.5B-Instruct-q4f32_1 (matches
// Qwen2.5-Coder-1.5B's base arch + quant — the Coder variant reuses the base Qwen2 1.5B kernel/tokenizer
// lib). Filename is `q4f32_1_cs1k` (the v0_2_84/base/ dir dropped the old `-ctx4k` infix; the earlier
// `…-ctx4k_cs1k…` guess 404'd). Pinned to commit 025bcaf (NOT `main`) for byte-reproducibility.
// Verified 2026-06-09 (and re-verified against the current model): HTTP 200, `\0asm`. NOTE: this
// model ships both `ndarray-cache.json` and `tensor-cache.json`; the worker cache shim
// (inference/manifestAliasCache.ts) still runs as a defensive alias for MLC repos that only ship
// the older name — harmless no-op here since both filenames already resolve to equivalent content.
export const MODEL_LIB_URL =
  'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm';

/** Passed to CreateWebWorkerMLCEngine. cacheBackend left at WebLLM's default (CacheStorage). */
export const appConfig = {
  model_list: [{ model: MODEL_HF_URL, model_id: MODEL_ID, model_lib: MODEL_LIB_URL }],
};

/** Context budget against the ctx4k runtime, reserving headroom for the system prompt (FE §4.5). */
export const CONTEXT_BUDGET_TOKENS = 3500;
