import { afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

/** Anonymous principal: /api/auth/me returns 401; the capability probe fails in jsdom (no WebGPU). */
function stubAnonymousFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    ),
  );
}

beforeEach(() => window.history.replaceState({}, '', '/'));
afterEach(() => vi.unstubAllGlobals());

describe('App (smoke)', () => {
  it('renders the app title heading', async () => {
    // The title lives outside the capability gate and is always visible.
    stubAnonymousFetch();
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /takoreview/i }),
    ).toBeInTheDocument();
  });

  it('redirects an unknown path to the workspace (catch-all route)', async () => {
    window.history.replaceState({}, '', '/totally/unknown/path');
    stubAnonymousFetch();
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /takoreview/i }),
    ).toBeInTheDocument();
  });
});
