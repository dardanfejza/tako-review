import { afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLocalStoragePref } from './useLocalStoragePref';

describe('useLocalStoragePref', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the default when unset, then persists updates', () => {
    localStorage.clear();
    const { result } = renderHook(() => useLocalStoragePref('k', false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('k')).toBe('true');
  });

  it('reads an existing stored value', () => {
    localStorage.setItem('k2', 'true');
    const { result } = renderHook(() => useLocalStoragePref('k2', false));
    expect(result.current[0]).toBe(true);
  });

  it('falls back to the default (no throw at render) when getItem throws — storage blocked', () => {
    // Safari Private Browsing / disabled storage: reading in the useState initializer throws.
    // Unguarded this white-screens the app; the hook must degrade to the default instead.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    let result!: ReturnType<typeof renderHook<ReturnType<typeof useLocalStoragePref>, unknown>>['result'];
    expect(() => {
      result = renderHook(() => useLocalStoragePref('blocked', true)).result;
    }).not.toThrow();
    expect(result.current[0]).toBe(true);
  });

  it('does not throw when setItem throws — write denied keeps the in-memory value', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { result } = renderHook(() => useLocalStoragePref('wkey', false));
    expect(() => act(() => result.current[1](true))).not.toThrow();
    expect(result.current[0]).toBe(true); // in-memory value still updated
  });
});
