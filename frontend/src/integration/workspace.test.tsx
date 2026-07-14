import { afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryProvider } from '../providers/QueryProvider';
import { AuthProvider } from '../providers/AuthProvider';
import { LocaleProvider } from '../providers/LocaleProvider';
import { EngineProvider } from '../providers/EngineProvider';
import { ReviewWorkspace } from '../routes/ReviewWorkspace';
import { createMockEngineClient, type MockConfig } from '../inference/mockEngineClient';
import type { CapabilityProbeDeps } from '../hooks/useCapabilityProbe';
import '../i18n';

function resp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const GUEST = { id: 'g', is_guest: true, display_name: 'Guest', email: null, ui_language: null };

const REVIEW_DETAIL = {
  id: 'rev-1',
  user_id: 'g',
  created_at: '2026-06-09T00:00:00Z',
  title: 'snippet.py',
  language: 'python',
  review_mode: 'bugs',
  model_version: 'm',
  prompt_version: 'p',
  code_text: 'def snippet():\n    return 1',
  code_hash: 'h',
  review_output: '## Summary\nok',
  timing: { load_ms: 0, ttft_ms: 0, total_ms: 1000, tokens_prompt: 1, tokens_completion: 1, tok_per_sec: 10 },
  client_id: 'c',
  device_class: 'webgpu;chrome',
  feedback: null,
};

const OK_PROBE: CapabilityProbeDeps = {
  secureContext: true,
  browser: 'chrome',
  navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => ({}) }) } },
};

function renderWorkspace(opts: {
  engineConfig?: MockConfig;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  probeDeps?: CapabilityProbeDeps;
  cached?: boolean;
  cacheCheck?: () => Promise<boolean>;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => opts.fetchImpl(String(url), init)),
  );
  const engineClient = createMockEngineClient(
    opts.engineConfig ?? {
      loadReports: [{ progress: 1, text: 'done' }],
      tokens: ['## Summary\n', 'ok'],
      usage: { prompt_tokens: 1, completion_tokens: 1, extra: { e2e_latency_s: 1, decode_tokens_per_s: 10 } },
    },
  );
  const cacheCheck = opts.cacheCheck ?? (async () => opts.cached ?? false);
  function Tree({ children }: { children: ReactNode }) {
    // MemoryRouter: the unsupported-gate modal links to /preflight via react-router <Link>, which
    // needs a Router context (mirrors PreflightPage.test.tsx).
    return (
      <MemoryRouter>
        <QueryProvider>
          <AuthProvider>
            <LocaleProvider>
              <EngineProvider clientFactory={() => engineClient} cacheCheck={cacheCheck}>{children}</EngineProvider>
            </LocaleProvider>
          </AuthProvider>
        </QueryProvider>
      </MemoryRouter>
    );
  }
  return render(
    <Tree>
      <ReviewWorkspace probeDeps={opts.probeDeps ?? OK_PROBE} codeInputVariant="textarea" />
    </Tree>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear(); // the collapse toggle persists to localStorage — reset so each test starts expanded
});

describe('ReviewWorkspace integration', () => {
  it('runs a review end-to-end: load → run → render → save → feedback enabled', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        if (url.startsWith('/api/feedback')) return resp(201, { id: 'f', session_id: 'rev-1', rating: 'up', created_at: 't' });
        return resp(404, { status: 404 });
      },
    });

    // Probe ok → CAPABLE → Load model
    await user.click(await screen.findByRole('button', { name: /load model/i }));
    // Loaded → editor available
    const editor = await screen.findByRole('textbox');
    await user.type(editor, 'def f(): return 1/0');
    await user.click(screen.getByRole('button', { name: /run review/i }));

    // Result rendered + feedback enabled after the 201 save
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful' })).toBeEnabled());

    // The saved review is prepended to history (header derived from code_text → the def name)
    expect(screen.getByText('snippet')).toBeInTheDocument();

    // Feedback POST succeeds (append-only)
    await user.click(screen.getByRole('button', { name: 'Helpful' }));
  });

  it('keeps the review on a save failure (503), then re-enables feedback after retry', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    renderWorkspace({
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') {
          postCount += 1;
          return postCount === 1 ? resp(503, { status: 503, detail: 'db down' }) : resp(201, REVIEW_DETAIL);
        }
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));

    // Save failed: banner shown, review still rendered, feedback disabled
    expect(await screen.findByText(/couldn.t save this review/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeDisabled();

    // Retry → 201 → feedback enabled
    await user.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful' })).toBeEnabled());
  });

  it('re-running from SAVE_FAILED leaves the trap state and clears the banner (MED: SAVE_FAILED trap)', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    renderWorkspace({
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') {
          postCount += 1;
          return postCount === 1 ? resp(503, { status: 503, detail: 'db down' }) : resp(201, REVIEW_DETAIL);
        }
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    // First save fails → SAVE_FAILED banner.
    expect(await screen.findByText(/couldn.t save this review/i)).toBeInTheDocument();

    // Re-run from SAVE_FAILED. Before the reducer fix RUN_REVIEW was a no-op here (trap); now it
    // re-enters REVIEWING, the second save 201s, and the banner is gone.
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await waitFor(() => expect(screen.queryByText(/couldn.t save this review/i)).toBeNull());
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  });

  it('recovers from a mid-session GPU loss instead of dead-ending', async () => {
    const user = userEvent.setup();
    let loseDevice = () => {};
    let deviceCalls = 0;
    const lostFirst = new Promise<{ reason?: string }>((res) => {
      loseDevice = () => res({ reason: 'destroyed' });
    });
    const lossProbe: CapabilityProbeDeps = {
      secureContext: true,
      browser: 'chrome',
      navigator: {
        gpu: {
          requestAdapter: async () => ({
            info: { vendor: 'apple' },
            requestDevice: async () => {
              deviceCalls += 1;
              // Only the first device "loses" the GPU; the re-probe gets a healthy one.
              return { lost: deviceCalls === 1 ? lostFirst : new Promise<{ reason?: string }>(() => {}) };
            },
          }),
        },
      },
    };
    renderWorkspace({
      probeDeps: lossProbe,
      fetchImpl: async (url) => {
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews')) return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });

    // Load the model → READY (editor visible).
    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await screen.findByRole('textbox');

    // The GPU device is lost mid-session.
    await act(async () => {
      loseDevice();
    });

    // Not a dead end: the machine re-probes and returns to CAPABLE, re-offering "Load model".
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /load model/i })).toBeInTheDocument(),
    );
  });

  it('blocks oversized code with the too-large alert before running inference', async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    renderWorkspace({
      // A client whose generate must never be reached: the size pre-check fires first.
      engineConfig: { loadReports: [{ progress: 1, text: 'done' }], tokens: ['x'] },
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') {
          generate();
          return resp(201, REVIEW_DETAIL);
        }
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    const editor = await screen.findByRole('textbox');
    await user.click(editor);
    await user.paste('a'.repeat(300_000)); // line-numbered bytes exceed the 256 KB cap
    await user.click(screen.getByRole('button', { name: /run review/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large to review/i);
    // No POST happened → inference was never attempted on the doomed input.
    expect(generate).not.toHaveBeenCalled();
  });

  it('blocks with the unsupported modal when WebGPU is absent, offering the guest path', async () => {
    renderWorkspace({
      probeDeps: { secureContext: true, navigator: {} },
      fetchImpl: async (url) =>
        url.startsWith('/api/auth/me') ? resp(401, { status: 401 }) : resp(404, { status: 404 }),
    });
    expect(await screen.findByText(/does not support webgpu/i)).toBeInTheDocument();
    // The unsupported gate is a non-blocking role="region" (NOT a focus-trapping aria-modal dialog —
    // §8 HIGH fix: a session-long trap would lock keyboard/SR users out of the still-visible chrome).
    // The guest path is scoped to the region (the footer AuthMenu is the always-visible identity control).
    const gate = screen.getByRole('region', { name: /webgpu is required/i });
    expect(within(gate).getByRole('button', { name: /continue as guest/i })).toBeInTheDocument();
    // The title stays visible outside the gate
    expect(screen.getByRole('heading', { name: /takoreview/i })).toBeInTheDocument();
  });

  it('a citation in the review jumps the editor to the cited line', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      engineConfig: {
        loadReports: [{ progress: 1, text: 'done' }],
        tokens: ['Bug on ', 'line 2', ' here.'],
        usage: { prompt_tokens: 1, completion_tokens: 1, extra: { e2e_latency_s: 1, decode_tokens_per_s: 10 } },
      },
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    const editor = await screen.findByRole('textbox');
    await user.click(editor);
    await user.paste('alpha\nbeta\ngamma'); // paste avoids the textarea's Enter-to-submit
    await user.click(screen.getByRole('button', { name: /run review/i }));

    // The cited line renders as a clickable button; clicking it focuses the editor at line 2's start.
    await user.click(await screen.findByRole('button', { name: 'line 2' }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toHaveFocus();
    expect(textarea.selectionStart).toBe('alpha\n'.length); // start of line 2 ("beta")
  });

  it('ignores the collapsed pref on a narrow viewport so the drawer shows full content', async () => {
    localStorage.setItem('tako.sidebar.collapsed', 'true');
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true, // narrow
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderWorkspace({
      fetchImpl: async (url) => {
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews')) return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    // The footer account name shows only when the sidebar is *effectively* expanded (the rail shows
    // just an avatar); on a narrow viewport the drawer must show full content despite the collapse pref.
    expect(await screen.findByText('Guest')).toBeInTheDocument();
  });

  it('keeps the save-failed Retry reachable even when the collapse pref is set', async () => {
    localStorage.setItem('tako.sidebar.collapsed', 'true');
    const user = userEvent.setup();
    let postCount = 0;
    renderWorkspace({
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') {
          postCount += 1;
          return postCount === 1 ? resp(503, { status: 503, detail: 'db down' }) : resp(201, REVIEW_DETAIL);
        }
        return resp(404, { status: 404 });
      },
    });
    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    // SAVE_FAILED forces the body open despite the pref, so the history-list banner + Retry show.
    expect(await screen.findByText(/couldn.t save this review/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('opens the off-canvas drawer and toggles desktop collapse (no top bar)', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      fetchImpl: async (url) => {
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews')) return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    // Floating drawer-open button (mobile affordance; no top bar to host it).
    const drawer = await screen.findByRole('button', { name: /open sidebar/i });
    expect(drawer).toHaveAttribute('aria-expanded', 'false');
    await user.click(drawer);
    expect(drawer).toHaveAttribute('aria-expanded', 'true');
    // Desktop collapse toggle (in the sidebar header) flips to the rail's "Expand" control.
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('auto-loads the model on page load when it is already cached (no Load model click)', async () => {
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    // Cached → the model loads straight through to the editor; no Load-model button is shown.
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load model/i })).toBeNull();
  });

  it('falls back to the manual Load-model button when the cache probe fails', async () => {
    renderWorkspace({
      cacheCheck: async () => {
        throw new Error('cache unavailable');
      },
      fetchImpl: async (url) => {
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews')) return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    // A throwing probe degrades to "not cached": the explicit button is still offered.
    expect(await screen.findByRole('button', { name: /load model/i })).toBeInTheDocument();
  });

  it('shows the hero ("Let\'s Code") when model is loaded but no review has been run', async () => {
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    await screen.findByRole('textbox');
    expect(screen.getByRole('heading', { name: /let's code/i })).toBeInTheDocument();
  });

  it('hides the hero heading and shows the result pane after Run Review', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });
    await screen.findByRole('textbox');
    await user.type(screen.getByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await screen.findByRole('heading', { name: 'Summary' });
    expect(screen.queryByRole('heading', { name: /let's code/i })).toBeNull();
  });

  it('restores the hero after clicking New Review', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });
    await screen.findByRole('textbox');
    await user.type(screen.getByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await screen.findByRole('heading', { name: 'Summary' });
    await user.click(screen.getByRole('button', { name: /new review/i }));
    expect(screen.getByRole('heading', { name: /let's code/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
  });

  it('expand jumps to the split layout with an empty result pane; New Review restores the hero', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });
    await screen.findByRole('textbox');
    // Expand before any review: hero heading leaves the a11y tree, split divider + empty hint show.
    await user.click(screen.getByRole('button', { name: /expand workspace/i }));
    expect(screen.queryByRole('heading', { name: /let's code/i })).toBeNull();
    expect(screen.getByRole('separator', { name: /resize panels/i })).toBeInTheDocument();
    expect(screen.getByText(/your review will appear here/i)).toBeInTheDocument();
    // The expand affordance itself is gone once split.
    expect(screen.queryByRole('button', { name: /expand workspace/i })).toBeNull();
    // New Review returns to the centered hero.
    await user.click(screen.getByRole('button', { name: /new review/i }));
    expect(screen.getByRole('heading', { name: /let's code/i })).toBeInTheDocument();
    expect(screen.queryByText(/your review will appear here/i)).toBeNull();
  });

  it('renders no model selector — one model ships, so the dead picker was removed', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });
    // A one-option dropdown would imply a choice that doesn't exist; the model-swap seam lives in
    // config/models.ts + the EngineClient instead. Assert no model picker in hero OR split state.
    await screen.findByRole('textbox');
    expect(screen.queryByRole('combobox', { name: /model/i })).toBeNull();
    await user.type(screen.getByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await screen.findByRole('heading', { name: 'Summary' });
    expect(screen.queryByRole('combobox', { name: /model/i })).toBeNull();
  });

  it('editing a restored review then running keeps the edit and creates a new entry (no reset)', async () => {
    const user = userEvent.setup();
    const DETAIL_A = { ...REVIEW_DETAIL, id: 'rev-A', title: 'orig.py', code_text: '1  old_code = 1', review_output: '## Summary\noriginal' };
    let posted = false;
    renderWorkspace({
      cached: true, // auto-load so the editor is available without a manual click
      engineConfig: {
        loadReports: [{ progress: 1, text: 'done' }],
        tokens: ['## Summary\n', 'new'],
        usage: { prompt_tokens: 1, completion_tokens: 1, extra: { e2e_latency_s: 1, decode_tokens_per_s: 10 } },
      },
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url === '/api/reviews/rev-A') return resp(200, DETAIL_A);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [{ id: 'rev-A', title: 'orig.py', review_mode: 'bugs', language: 'python', created_at: '2026-06-09T00:00:00Z', snippet: 'old_code = 1', code_bytes: 11, line_count: 1 }], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') {
          posted = true;
          return resp(201, { ...DETAIL_A, id: 'rev-B', review_output: '## Summary\nnew' });
        }
        return resp(404, { status: 404 });
      },
    });

    await screen.findByRole('textbox'); // cached → auto-loaded
    // The disclaimer card is visible on the pristine hero...
    expect(screen.getByText(/Verify suggestions before relying/i)).toBeInTheDocument();
    // Restore the saved review → editor hydrates with the original code.
    await user.click(await screen.findByRole('button', { name: /orig\.py/i }));
    // ...and dismisses on opening a history item, not only on Run (regression).
    await waitFor(() => expect(screen.queryByText(/Verify suggestions before relying/i)).toBeNull());
    const editor = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    // Restored editor shows RAW code — the stored "1  " line-number prefix is stripped (not duplicated).
    await waitFor(() => expect(editor.value).toContain('old_code = 1'));
    expect(editor.value).not.toContain('1  old_code');
    // Edit (no newline → no Enter-to-submit) and run.
    await user.type(editor, ' edited');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await screen.findByRole('heading', { name: 'Summary' });
    // The edit survived (not reset to the original restored code), and a new entry was POSTed.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('edited');
    expect(posted).toBe(true);
  });

  it('clicking the brand (home) during a review stops it and returns to the hero', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const onBeforeToken = async (i: number) => {
      if (i === 0) await gate; // hold the first token so we stay in REVIEWING
    };
    renderWorkspace({
      engineConfig: {
        loadReports: [{ progress: 1, text: 'done' }],
        tokens: ['## Summary\n', 'ok'],
        usage: { prompt_tokens: 1, completion_tokens: 1, extra: { e2e_latency_s: 1, decode_tokens_per_s: 10 } },
        onBeforeToken,
      },
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });
    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    // Mid-review: Stop is shown, the editor is locked.
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    // Click the brand → home: the run is aborted (engine.cancel sets the abort signal) and the
    // machine returns to the editable hero (post-model-load READY state).
    await user.click(screen.getByRole('button', { name: /takoreview/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /stop/i })).toBeNull());
    expect(screen.getByRole('heading', { name: /let's code/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    release(); // unblock the held generation so the worker promise can settle
  });

  it('re-running from a finished review re-enters REVIEWING: editor locks and Stop appears (#2 RUN_AGAIN dead event)', async () => {
    const user = userEvent.setup();
    // Hold the FIRST run's first token so we can observe the streaming/REVIEWING state, then release.
    let release1 = () => {};
    const gate1 = new Promise<void>((r) => { release1 = r; });
    let release2 = () => {};
    const gate2 = new Promise<void>((r) => { release2 = r; });
    let runIndex = 0;
    const onBeforeToken = async (i: number) => {
      if (i !== 0) return; // only hold the first token of each run
      const which = runIndex;
      runIndex += 1;
      await (which === 0 ? gate1 : gate2);
    };
    renderWorkspace({
      engineConfig: {
        loadReports: [{ progress: 1, text: 'done' }],
        tokens: ['## Summary\n', 'ok'],
        usage: { prompt_tokens: 1, completion_tokens: 1, extra: { e2e_latency_s: 1, decode_tokens_per_s: 10 } },
        onBeforeToken,
      },
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));

    // First run is REVIEWING: editor is read-only and a Stop control is shown.
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    // Finish the first run → RESULT.
    await act(async () => { release1(); });
    await screen.findByRole('heading', { name: 'Summary' });
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('readonly');

    // Re-run from RESULT. Before the fix this dispatched RUN_REVIEW into a RESULT row that didn't
    // accept it → the machine never entered REVIEWING (no lock, no Stop). Now it must.
    await user.click(screen.getByRole('button', { name: /run review/i }));
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    await act(async () => { release2(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /stop/i })).toBeNull());
  });

  it('a feedback vote does not wipe in-progress editor edits (HIGH: voting re-fires restore effect)', async () => {
    const user = userEvent.setup();
    const DETAIL_A = { ...REVIEW_DETAIL, id: 'rev-A', title: 'orig.py', code_text: '1  old_code = 1', review_output: '## Summary\noriginal', feedback: null };
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url === '/api/reviews/rev-A') return resp(200, DETAIL_A);
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [{ id: 'rev-A', title: 'orig.py', review_mode: 'bugs', language: 'python', created_at: '2026-06-09T00:00:00Z', snippet: 'old_code = 1', code_bytes: 11, line_count: 1 }], next_cursor: null });
        if (url.startsWith('/api/feedback')) return resp(201, { id: 'f', session_id: 'rev-A', rating: 'up', created_at: 't' });
        return resp(404, { status: 404 });
      },
    });

    await screen.findByRole('textbox');
    // Restore rev-A → editor hydrates, feedback enabled (saved review).
    await user.click(await screen.findByRole('button', { name: /orig\.py/i }));
    const editor = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('old_code = 1'));
    // Edit the restored code in place.
    await user.type(editor, ' edited');
    expect(editor.value).toContain('edited');
    // Vote. The old onSuccess invalidated the whole detail query; the refetched object's identity
    // change re-fired the restore effect and reset the editor back to the stored code.
    await user.click(await screen.findByRole('button', { name: 'Helpful' }));
    // Vote registered (aria-pressed flips), and the edit must survive it (no re-hydrate).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('edited');
  });

  it('rolls back an optimistic vote and shows a hint when the feedback POST fails (LOW: onVote no rollback)', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url.startsWith('/api/reviews') && method === 'GET') return resp(200, { items: [], next_cursor: null });
        if (url === '/api/reviews' && method === 'POST') return resp(201, REVIEW_DETAIL);
        if (url.startsWith('/api/feedback')) return resp(503, { status: 503, detail: 'db down' });
        return resp(404, { status: 404 });
      },
    });

    await user.click(await screen.findByRole('button', { name: /load model/i }));
    await user.type(await screen.findByRole('textbox'), 'x = 1');
    await user.click(screen.getByRole('button', { name: /run review/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Helpful' })).toBeEnabled());

    // Vote → the POST fails. The optimistic aria-pressed must roll back and a hint must show,
    // so a failed vote doesn't read as a registered one.
    await user.click(screen.getByRole('button', { name: 'Helpful' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'false'),
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('surfaces an error when a history restore fails instead of failing silently (§8: errors.notFound)', async () => {
    const user = userEvent.setup();
    renderWorkspace({
      cached: true,
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url === '/api/reviews/rev-gone') return resp(404, { status: 404 }); // restore target is gone
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [{ id: 'rev-gone', title: 'gone.py', review_mode: 'bugs', language: 'python', created_at: '2026-06-09T00:00:00Z', snippet: 'x = 1', code_bytes: 5, line_count: 1 }], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });

    await screen.findByRole('textbox');
    await user.click(await screen.findByRole('button', { name: /gone\.py/i }));
    // The restore detail 404s → the workspace shows the "no longer available" alert (no silent fail).
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it('optimistically removes a deleted review and rolls it back when the DELETE fails', async () => {
    const user = userEvent.setup();
    const deleteShouldFail = true;
    renderWorkspace({
      cached: true, // auto-load → READY so the sidebar body (history items) renders
      fetchImpl: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.startsWith('/api/auth/me')) return resp(200, GUEST);
        if (url === '/api/reviews/rev-D' && method === 'DELETE')
          return deleteShouldFail ? resp(503, { status: 503 }) : resp(204, {});
        if (url.startsWith('/api/reviews') && method === 'GET')
          return resp(200, { items: [{ id: 'rev-D', title: 'doomed.py', review_mode: 'bugs', language: 'python', created_at: '2026-06-09T00:00:00Z', snippet: 'x = 1', code_bytes: 5, line_count: 1 }], next_cursor: null });
        return resp(404, { status: 404 });
      },
    });

    // The row is present (restore button is named after the title).
    expect(await screen.findByRole('button', { name: /doomed\.py/i })).toBeInTheDocument();
    // Delete → confirm. The optimistic remove fires; the 503 rolls it back so the row reappears.
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /doomed\.py/i })).toBeInTheDocument(),
    );
  });
});
