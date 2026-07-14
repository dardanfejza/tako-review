import { prependToList, removeFromList, toListItem, type InfiniteList } from './reviewsCache';
import type { ReviewDetail } from '../types/api';

function detail(id: string): ReviewDetail {
  return {
    id,
    user_id: 'u',
    created_at: 'x',
    title: `t-${id}`,
    language: 'python',
    review_mode: 'bugs',
    model_version: 'm',
    prompt_version: 'p',
    code_text: '',
    code_hash: '',
    review_output: '',
    timing: { load_ms: 0, ttft_ms: 0, total_ms: 0, tokens_prompt: 0, tokens_completion: 0, tok_per_sec: 0 },
    client_id: null,
    device_class: null,
    feedback: null,
  };
}

describe('reviews cache helpers (optimistic list updates — FE §3.1/§8.B)', () => {
  it('prepends a new review to the first page, preserving its cursor', () => {
    const old: InfiniteList = {
      pages: [{ items: [toListItem(detail('a'))], next_cursor: 'c' }],
      pageParams: [null],
    };
    const next = prependToList(old, toListItem(detail('b')));
    expect(next.pages[0]!.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(next.pages[0]!.next_cursor).toBe('c');
  });

  it('creates an initial page when the cache is empty', () => {
    const next = prependToList(undefined, toListItem(detail('b')));
    expect(next.pages[0]!.items.map((i) => i.id)).toEqual(['b']);
  });

  it('removes a review by id across pages', () => {
    const old: InfiniteList = {
      pages: [{ items: [toListItem(detail('a')), toListItem(detail('b'))], next_cursor: null }],
      pageParams: [null],
    };
    expect(removeFromList(old, 'a')!.pages[0]!.items.map((i) => i.id)).toEqual(['b']);
  });
});
