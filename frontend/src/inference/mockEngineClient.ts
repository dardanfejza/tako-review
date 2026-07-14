import type {
  EngineClient,
  LoadProgress,
  ChatMessage,
  GenOptions,
  GenResult,
  CancelSignal,
} from './types';
import type { WebLLMUsage } from '../lib/telemetry';

export interface MockConfig {
  loadReports?: LoadProgress[];
  tokens?: string[];
  usage?: WebLLMUsage;
  failOnGenerate?: Error;
  loaded?: boolean;
  /** Optional async gap between tokens, for tests that need to observe streaming. */
  onBeforeToken?: (index: number) => void | Promise<void>;
}

/**
 * Test/dev double implementing the EngineClient seam (FE §4.1). Streams scripted tokens and
 * honors the cooperative cancel signal exactly like the real worker-backed client.
 *
 * Extended with `lastGenOpts` to allow tests to assert on the opts passed to `generate()`,
 * including the optional `seed` field added for reproducible eval runs (eval §7).
 */
export interface MockEngineClient extends EngineClient {
  /** The most recent GenOptions passed to generate(); undefined before the first call. */
  lastGenOpts: GenOptions | undefined;
}

export function createMockEngineClient(config: MockConfig = {}): MockEngineClient {
  let loaded = config.loaded ?? false;
  let lastGenOpts: GenOptions | undefined;

  return {
    get lastGenOpts() {
      return lastGenOpts;
    },

    async load(onProgress: (p: LoadProgress) => void): Promise<void> {
      for (const report of config.loadReports ?? [{ progress: 1, text: 'Loaded' }]) {
        onProgress(report);
      }
      loaded = true;
    },

    async generate(
      _messages: ChatMessage[],
      opts: GenOptions,
      onToken: (delta: string) => void,
      signal: CancelSignal,
    ): Promise<GenResult> {
      lastGenOpts = opts;
      if (config.failOnGenerate) throw config.failOnGenerate;
      let text = '';
      const tokens = config.tokens ?? ['Hello'];
      for (let i = 0; i < tokens.length; i++) {
        if (signal.cancelled) break;
        await config.onBeforeToken?.(i);
        const t = tokens[i]!;
        text += t;
        onToken(t);
      }
      return { text, usage: config.usage };
    },

    isLoaded: () => loaded,
    dispose: () => {
      loaded = false;
    },
  };
}
