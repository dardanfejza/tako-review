import { createMockEngineClient } from './mockEngineClient';
import { DEFAULT_GEN_OPTIONS } from '../config/sampling';
import type { CancelSignal } from './types';

describe('createMockEngineClient', () => {
  it('reports progress on load and flips isLoaded', async () => {
    const client = createMockEngineClient({ loadReports: [{ progress: 0.5, text: 'half' }] });
    const reports: number[] = [];
    expect(client.isLoaded()).toBe(false);
    await client.load((p) => reports.push(p.progress));
    expect(reports).toEqual([0.5]);
    expect(client.isLoaded()).toBe(true);
  });

  it('streams tokens in order and stops when the signal is cancelled', async () => {
    const client = createMockEngineClient({ tokens: ['a', 'b', 'c'] });
    const seen: string[] = [];
    const signal: CancelSignal = { cancelled: false };
    const res = await client.generate(
      [],
      DEFAULT_GEN_OPTIONS,
      (d) => {
        seen.push(d);
        if (seen.length === 2) signal.cancelled = true;
      },
      signal,
    );
    expect(seen).toEqual(['a', 'b']);
    expect(res.text).toBe('ab');
  });

  it('throws the configured failure', async () => {
    const client = createMockEngineClient({ failOnGenerate: new Error('gen boom') });
    await expect(
      client.generate([], DEFAULT_GEN_OPTIONS, () => {}, { cancelled: false }),
    ).rejects.toThrow('gen boom');
  });

  it('passes seed through to generate opts', async () => {
    const client = createMockEngineClient({ tokens: ['ok'] });
    await client.generate([], { temperature: 0.2, top_p: 0.9, repetition_penalty: 1, frequency_penalty: 0, seed: 7 }, () => {}, { cancelled: false });
    expect(client.lastGenOpts?.seed).toBe(7);
  });
});
