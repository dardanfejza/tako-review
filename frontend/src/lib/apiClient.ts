import type {
  MeResponse,
  ProfileUpdate,
  ReviewCreate,
  ReviewDetail,
  ReviewListPage,
  FeedbackCreate,
  FeedbackResponse,
  ProblemDetail,
} from '../types/api';

/**
 * Typed fetch wrapper for the same-origin /api boundary (FE §13, API §3). Sends the HttpOnly
 * cookie via `credentials: 'include'`. Non-2xx responses carry an RFC 9457 problem+json body;
 * we surface `detail` + `correlation_id` for the UI while the status drives the state machine
 * (e.g. 503 → SAVE_FAILED). 204 resolves without a body parse.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly problem?: ProblemDetail;

  constructor(status: number, problem?: ProblemDetail) {
    super(problem?.detail ?? `API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = problem?.detail;
    this.correlationId = problem?.correlation_id;
    this.problem = problem;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'include',
    ...rest,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(headers ?? {}) },
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let problem: ProblemDetail | undefined;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        problem = (await res.json()) as ProblemDetail;
      } catch {
        /* non-JSON error body — leave problem undefined */
      }
    }
    throw new ApiError(res.status, problem);
  }

  return (await res.json()) as T;
}

export const api = {
  getMe: () => apiFetch<MeResponse>('/api/auth/me'),
  guest: () => apiFetch<MeResponse>('/api/auth/guest', { method: 'POST' }),
  patchMe: (body: ProfileUpdate) =>
    apiFetch<MeResponse>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(body) }),
  logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),

  listReviews: (params: { limit?: number; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const q = qs.toString();
    return apiFetch<ReviewListPage>(`/api/reviews${q ? `?${q}` : ''}`);
  },
  getReview: (id: string) => apiFetch<ReviewDetail>(`/api/reviews/${encodeURIComponent(id)}`),
  createReview: (body: ReviewCreate) =>
    apiFetch<ReviewDetail>('/api/reviews', { method: 'POST', body: JSON.stringify(body) }),
  deleteReview: (id: string) =>
    apiFetch<void>(`/api/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  postFeedback: (body: FeedbackCreate) =>
    apiFetch<FeedbackResponse>('/api/feedback', { method: 'POST', body: JSON.stringify(body) }),
};
