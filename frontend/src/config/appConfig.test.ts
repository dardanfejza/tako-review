import { appConfig, MODEL_LIB_URL, MODEL_HF_URL, MODEL_ID, WEBLLM_VERSION, MODEL_HF_REVISION } from './appConfig';

describe('appConfig pins (FE §4.2 supply-chain)', () => {
  it('freezes the full wasm URL as an https string (not runtime-assembled from prefix+version)', () => {
    expect(MODEL_LIB_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\.wasm$/);
  });

  it('pins the web-llm version exactly to 0.2.84', () => {
    expect(WEBLLM_VERSION).toBe('0.2.84');
  });

  it('model_list references the pinned id, HF URL and wasm lib', () => {
    expect(appConfig.model_list[0]).toEqual({
      model: MODEL_HF_URL,
      model_id: MODEL_ID,
      model_lib: MODEL_LIB_URL,
    });
  });
});

describe('model bytes are pinned + correct (eval spec §9.1; fixes the 404 lib URL)', () => {
  it('model-lib URL pins a commit SHA, not the mutable main branch', () => {
    expect(MODEL_LIB_URL).not.toContain('/main/');
    expect(MODEL_LIB_URL).toMatch(/\/[0-9a-f]{40}\//);
  });
  it('model-lib URL uses the web-llm 0.2.84 filename (q4f32_1_cs1k, not ctx4k)', () => {
    expect(MODEL_LIB_URL).toContain('Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm');
    expect(MODEL_LIB_URL).not.toContain('ctx4k');
  });
  it('records the pinned HF model revision', () => {
    expect(MODEL_HF_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });
});
