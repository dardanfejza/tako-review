import type { WebLLMUsage } from '../lib/telemetry';

/**
 * The ONLY inference surface the rest of the app imports (FE §4.1). The real implementation
 * (createEngineClient) drives WebLLM in a Web Worker; tests inject a mock. Keeping this a pure
 * type module means nothing here pulls @mlc-ai/web-llm into the CI graph.
 */
export interface LoadProgress {
  progress: number; // 0..1
  text: string;
  cacheHit?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenOptions {
  temperature: number;
  top_p: number;
  repetition_penalty: number;
  frequency_penalty: number;
  logit_bias?: Record<string, number>;
  seed?: number;
}

/** App-level cooperative cancel (FE §5.1) — create() takes no AbortSignal at 0.2.84. */
export interface CancelSignal {
  cancelled: boolean;
}

export interface GenResult {
  text: string;
  usage?: WebLLMUsage;
}

export interface EngineClient {
  load(onProgress: (p: LoadProgress) => void): Promise<void>;
  generate(
    messages: ChatMessage[],
    opts: GenOptions,
    onToken: (delta: string) => void,
    signal: CancelSignal,
  ): Promise<GenResult>;
  isLoaded(): boolean;
  dispose(): void | Promise<void>;
}

/** Factory shape — real or mock — so EngineProvider can be given either. */
export type EngineClientFactory = () => EngineClient | Promise<EngineClient>;
