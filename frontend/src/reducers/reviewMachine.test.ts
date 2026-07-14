import { afterEach, vi } from 'vitest';
import { reduce, INITIAL_STATE } from './reviewMachine';

describe('reviewMachine (normative transition table — FE §7)', () => {
  it('starts at PREFLIGHT', () => {
    expect(INITIAL_STATE).toBe('PREFLIGHT');
  });

  it.each([
    ['PREFLIGHT', 'PROBE_OK', 'CAPABLE'],
    ['PREFLIGHT', 'PROBE_FAIL', 'UNSUPPORTED'],
    ['UNSUPPORTED', 'REPROBE_OK', 'CAPABLE'],
    ['CAPABLE', 'LOAD_MODEL', 'DOWNLOADING'],
    ['DOWNLOADING', 'LOAD_COMPLETE', 'READY'],
    ['DOWNLOADING', 'DL_CANCEL', 'DL_CANCELLED'],
    ['DOWNLOADING', 'DL_ERROR', 'DOWNLOAD_ERROR'],
    ['DL_CANCELLED', 'DL_RESUME', 'DOWNLOADING'],
    ['DL_CANCELLED', 'LOAD_MODEL', 'DOWNLOADING'],
    ['DOWNLOAD_ERROR', 'DL_RETRY', 'DOWNLOADING'],
    ['READY', 'RUN_REVIEW', 'REVIEWING'],
    ['READY', 'RESTORE', 'READY'],
    ['REVIEWING', 'GEN_COMPLETE', 'RESULT'],
    ['REVIEWING', 'GEN_ERROR', 'REVIEW_ERROR'],
    ['REVIEWING', 'GEN_CANCEL', 'REVIEW_CANCELLED'],
    // "Home"/New review while a review streams abandons it straight to READY (the caller cancels
    // the engine first so the worker actually stops).
    ['REVIEWING', 'NEW_REVIEW', 'READY'],
    ['REVIEW_ERROR', 'NEW_REVIEW', 'READY'],
    ['REVIEW_CANCELLED', 'NEW_REVIEW', 'READY'],
    ['RESULT', 'SAVE_FAILED', 'SAVE_FAILED'],
    ['SAVE_FAILED', 'SAVE_RETRY_OK', 'RESULT'],
    ['RESULT', 'NEW_REVIEW', 'READY'],
    ['RESULT', 'RESTORE', 'READY'],
    // The real run entry dispatches RUN_REVIEW (not the deleted RUN_AGAIN); a re-run from a
    // finished review must re-enter REVIEWING so inputs lock and Stop is offered (regression: #2).
    ['RESULT', 'RUN_REVIEW', 'REVIEWING'],
    // SAVE_FAILED is no longer a trap: the always-enabled New-review / Run / restore controls
    // dispatch out of it instead of silently no-op'ing (regression: MED "SAVE_FAILED trap state").
    ['SAVE_FAILED', 'NEW_REVIEW', 'READY'],
    ['SAVE_FAILED', 'RESTORE', 'READY'],
    ['SAVE_FAILED', 'RUN_REVIEW', 'REVIEWING'],
    ['READY', 'DEVICE_LOST', 'DEVICE_LOST'],
    ['REVIEWING', 'DEVICE_LOST', 'DEVICE_LOST'],
    ['DEVICE_LOST', 'REPROBE_OK', 'CAPABLE'],
    ['DEVICE_LOST', 'REPROBE_FAIL', 'UNSUPPORTED'],
  ] as const)('%s --%s--> %s', (from, event, to) => {
    expect(reduce(from, { type: event })).toBe(to);
  });

  it('treats unknown/guarded transitions as no-ops (wrong-button safety)', () => {
    expect(reduce('READY', { type: 'GEN_COMPLETE' })).toBe('READY');
    expect(reduce('DOWNLOADING', { type: 'RUN_REVIEW' })).toBe('DOWNLOADING');
    expect(reduce('RESULT', { type: 'GEN_CANCEL' })).toBe('RESULT');
  });

  describe('dev warning on ignored events (surfaces future dead transitions)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('warns when an event is ignored in dev', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // vitest runs with import.meta.env.DEV === true; an ignored event should warn.
      reduce('READY', { type: 'GEN_COMPLETE' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ignored event "GEN_COMPLETE" in state "READY"'),
      );
    });

    it('does not warn on a valid transition', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      reduce('READY', { type: 'RUN_REVIEW' });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
