export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS: ModelOption[] = [
  // `id` is the internal/persisted option value; `label` is the visible model name.
  { id: 'qwen25-coder', label: 'Qwen2.5-Coder-1.5B' },
];

export const DEFAULT_MODEL_ID = 'qwen25-coder';
