import { vi, beforeEach, afterEach } from 'vitest';
import { throttleLatest } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttleLatest', () => {
  it('emits the first call immediately (leading edge)', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a');
  });

  it('coalesces calls inside the window and emits only the latest at the trailing edge', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a'); // leading
    push('ab');
    push('abc');
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('abc');
  });

  it('keeps emitting at most once per window under a sustained stream', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    // 50 calls over 500ms (one every 10ms) → 1 leading + 5 trailing windows
    for (let i = 1; i <= 50; i++) {
      push('x'.repeat(i));
      vi.advanceTimersByTime(10);
    }
    expect(emit.mock.calls.length).toBeLessThanOrEqual(6);
    expect(emit).toHaveBeenLastCalledWith('x'.repeat(50));
  });

  it('emits leading again after a full idle window', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a');
    vi.advanceTimersByTime(150); // idle past the window, nothing pending
    push('b');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('b');
  });

  it('flush() emits the pending value immediately', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a');
    push('ab');
    push.flush();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('ab');
    vi.advanceTimersByTime(200); // no double trailing emit afterwards
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a');
    vi.advanceTimersByTime(100);
    emit.mockClear();
    push.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it('cancel() drops the pending value without emitting', () => {
    const emit = vi.fn();
    const push = throttleLatest<string>(emit, 100);
    push('a');
    push('ab');
    push.cancel();
    vi.advanceTimersByTime(200);
    expect(emit).toHaveBeenCalledTimes(1); // only the leading 'a'
    expect(emit).toHaveBeenLastCalledWith('a');
  });
});
