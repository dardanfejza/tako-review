import { afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryProvider } from './QueryProvider';
import { AuthProvider, useAuth } from './AuthProvider';

function json(status: number, body: unknown, ct = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': ct } });
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>{children}</AuthProvider>
    </QueryProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Reset URL to plain / after each test so auth_error tests don't bleed.
  window.history.replaceState({}, '', '/');
});

describe('AuthProvider', () => {
  it('exposes a null user when anonymous (401 on /me)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { status: 401 }, 'application/problem+json')));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('continueAsGuest populates a guest principal', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === '/api/auth/guest'
        ? Promise.resolve(json(201, { id: 'g', is_guest: true, display_name: 'Guest', email: null, ui_language: null }))
        : Promise.resolve(json(401, { status: 401 }, 'application/problem+json')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.continueAsGuest());
    await waitFor(() => expect(result.current.user?.is_guest).toBe(true));
  });

  // --- auto-guest tests ---

  it('auto-establishes a guest session when /me resolves anonymous (no auth_error)', async () => {
    const guestBody = { id: 'g1', is_guest: true, display_name: 'Guest', email: null, ui_language: null };
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === '/api/auth/guest'
        ? Promise.resolve(json(201, guestBody))
        : Promise.resolve(json(401, { status: 401 }, 'application/problem+json')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth(), { wrapper });
    // Wait until the guest session is established (user becomes non-null).
    await waitFor(() => expect(result.current.user?.is_guest).toBe(true));
    // Exactly one POST /api/auth/guest call.
    const guestCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === '/api/auth/guest',
    );
    expect(guestCalls).toHaveLength(1);
  });

  it('does NOT auto-guest when ?auth_error is present in the URL at render', async () => {
    window.history.replaceState({}, '', '/?auth_error=github_error');
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === '/api/auth/guest'
        ? Promise.resolve(json(201, { id: 'g2', is_guest: true, display_name: 'Guest', email: null, ui_language: null }))
        : Promise.resolve(json(401, { status: 401 }, 'application/problem+json')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Give a tick for any spurious effect.
    await new Promise((r) => setTimeout(r, 50));
    const guestCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === '/api/auth/guest',
    );
    expect(guestCalls).toHaveLength(0);
  });

  it('does NOT auto-guest when the user already has a session', async () => {
    const meBody = { id: 'u1', is_guest: false, display_name: 'Alice', email: 'alice@example.com', ui_language: 'en' };
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(json(200, meBody)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe('u1'));
    await new Promise((r) => setTimeout(r, 50));
    const guestCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === '/api/auth/guest',
    );
    expect(guestCalls).toHaveLength(0);
  });

  it('does NOT auto-guest while /me is still loading', async () => {
    // Never resolve /me so isLoading stays true.
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAuth(), { wrapper });
    await new Promise((r) => setTimeout(r, 100));
    const guestCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === '/api/auth/guest',
    );
    expect(guestCalls).toHaveLength(0);
  });

  it('auto-guest fires exactly once even if effect deps change after mutation', async () => {
    const guestBody = { id: 'g3', is_guest: true, display_name: 'Guest', email: null, ui_language: null };
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      url === '/api/auth/guest'
        ? Promise.resolve(json(201, guestBody))
        : Promise.resolve(json(401, { status: 401 }, 'application/problem+json')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.is_guest).toBe(true));
    // Even after guest user is set, re-renders shouldn't fire another guest call.
    await new Promise((r) => setTimeout(r, 80));
    const guestCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args: unknown[]) => args[0] === '/api/auth/guest',
    );
    expect(guestCalls).toHaveLength(1);
  });
});
