import { afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryProvider } from '../providers/QueryProvider';
import { useTelemetryPref } from './useTelemetryPref';
import { useAuth } from '../providers/AuthProvider';
import type { MeResponse } from '../types/api';

vi.mock('../providers/AuthProvider', () => ({ useAuth: vi.fn() }));
const mockUseAuth = vi.mocked(useAuth);

const MEMBER: MeResponse = {
  id: 'u1',
  is_guest: false,
  display_name: 'octocat',
  email: 'o@x.com',
  ui_language: 'en',
  telemetry_opt_out: true,
};

function setAuth(user: MeResponse | null) {
  mockUseAuth.mockReturnValue({
    user,
    isLoading: false,
    signInGitHub: vi.fn(),
    continueAsGuest: vi.fn(),
    signOut: vi.fn(),
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('useTelemetryPref (reconcile semantics — LocaleProvider pattern)', () => {
  it('reconciles a non-guest profile ONCE: a later local toggle is not clobbered on re-render', async () => {
    setAuth(MEMBER); // server: opted out
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...MEMBER, telemetry_opt_out: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { result, rerender } = renderHook(() => useTelemetryPref(), { wrapper });
    expect(result.current[0]).toBe(true); // server value adopted
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');

    act(() => result.current[1](false)); // local toggle wins from here on
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('false');

    rerender(); // same principal re-renders (e.g. cache refresh) — must NOT re-adopt server true
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('false');
  });

  it('re-arms the reconcile after sign-out: the next principal is adopted again', () => {
    setAuth(MEMBER);
    const { result, rerender } = renderHook(() => useTelemetryPref(), { wrapper });
    expect(result.current[0]).toBe(true);

    setAuth(null); // sign-out resets the once-per-principal guard
    rerender();
    setAuth({ ...MEMBER, id: 'u2', telemetry_opt_out: false });
    rerender();
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('false');
  });

  it('skips reconcile when the profile lacks the field (older payloads)', () => {
    localStorage.setItem('tako.telemetry_opt_out', 'true');
    const { telemetry_opt_out: _omitted, ...legacy } = MEMBER;
    setAuth(legacy as MeResponse);
    const { result } = renderHook(() => useTelemetryPref(), { wrapper });
    expect(result.current[0]).toBe(true); // local value untouched
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');
  });

  it('signed-out (null user): toggling writes localStorage only', () => {
    setAuth(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useTelemetryPref(), { wrapper });
    act(() => result.current[1](true));
    expect(localStorage.getItem('tako.telemetry_opt_out')).toBe('true');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
