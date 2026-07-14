import { afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryProvider } from '../providers/QueryProvider';
import { useMe } from './useAuth';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}

afterEach(() => vi.unstubAllGlobals());

describe('useMe', () => {
  it('returns the MeResponse on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'u', is_guest: true, display_name: 'Guest', email: null, ui_language: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const { result } = renderHook(() => useMe(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.display_name).toBe('Guest');
  });

  it('maps 401 to a null (signed-out) principal rather than erroring', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: 401 }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        }),
      ),
    );
    const { result } = renderHook(() => useMe(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
