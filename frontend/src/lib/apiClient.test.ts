import { afterEach, vi } from 'vitest';
import { api, ApiError } from './apiClient';

function res(status: number, body?: unknown, contentType = 'application/json'): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': contentType },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('apiClient', () => {
  it('getMe returns MeResponse and sends credentials: include', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res(200, { id: 'u', is_guest: false, display_name: 'octocat', email: null, ui_language: 'en' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const me = await api.getMe();
    expect(me.display_name).toBe('octocat');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/me');
    expect((init as RequestInit).credentials).toBe('include');
  });

  it('throws ApiError with the status on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res(401, { status: 401, detail: 'no session' }, 'application/problem+json')),
    );
    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
  });

  it('parses RFC 9457 problem+json detail + correlation_id and preserves status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        res(503, { status: 503, detail: 'db down', correlation_id: '01ABC' }, 'application/problem+json'),
      ),
    );
    const err = await api.createReview({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).detail).toBe('db down');
    expect((err as ApiError).correlationId).toBe('01ABC');
  });

  it('deleteReview resolves undefined on 204 (no body parse)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(204)));
    await expect(api.deleteReview('id')).resolves.toBeUndefined();
  });

  it('listReviews builds the keyset querystring', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, { items: [], next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.listReviews({ limit: 20, cursor: 'abc' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/reviews?limit=20&cursor=abc');
  });

  it('postFeedback returns FeedbackResponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(res(201, { id: 'f', session_id: 's', rating: 'up', created_at: 't' })),
    );
    const fb = await api.postFeedback({ session_id: 's', rating: 'up', reason_tags: [] });
    expect(fb.id).toBe('f');
  });
});
