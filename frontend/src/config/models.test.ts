import { MODELS, DEFAULT_MODEL_ID, type ModelOption } from './models';

describe('models config', () => {
  it('exports at least one model', () => {
    expect(MODELS.length).toBeGreaterThan(0);
  });

  it('every model has id and label strings', () => {
    MODELS.forEach((m: ModelOption) => {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
    });
  });

  it('first model is Qwen2.5-Coder-1.5B (id qwen25-coder)', () => {
    expect(MODELS[0]).toEqual({ id: 'qwen25-coder', label: 'Qwen2.5-Coder-1.5B' });
  });

  it('DEFAULT_MODEL_ID is present in the list', () => {
    expect(MODELS.some((m) => m.id === DEFAULT_MODEL_ID)).toBe(true);
  });
});
