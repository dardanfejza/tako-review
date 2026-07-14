import { afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMediaQuery } from './useMediaQuery';

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('useMediaQuery', () => {
  it('returns true when the query matches, and cleans up on unmount', () => {
    stubMatchMedia(true);
    const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 900px)'));
    expect(result.current).toBe(true);
    unmount();
  });

  it('returns false when the query does not match', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 900px)'));
    expect(result.current).toBe(false);
  });
});
