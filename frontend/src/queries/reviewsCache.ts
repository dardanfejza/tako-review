import type { ReviewDetail, ReviewListItem, ReviewListPage } from '../types/api';
import { codeBytes, headerFrom, lineCount, snippetFrom } from '../lib/reviewMeta';

/** Shape TanStack Query stores for an infinite query. */
export interface InfiniteList {
  pages: ReviewListPage[];
  pageParams: unknown[];
}

/** Project a full review record down to the lightweight list item (API §5.3). */
export function toListItem(r: ReviewDetail): ReviewListItem {
  return {
    id: r.id,
    title: headerFrom(r.code_text),
    review_mode: r.review_mode,
    language: r.language,
    created_at: r.created_at,
    snippet: snippetFrom(r.code_text),
    code_bytes: codeBytes(r.code_text),
    line_count: lineCount(r.code_text),
  };
}

/** Prepend a freshly-created review to the first page (newest-first). */
export function prependToList(old: InfiniteList | undefined, item: ReviewListItem): InfiniteList {
  if (!old || old.pages.length === 0) {
    return { pages: [{ items: [item], next_cursor: null }], pageParams: [null] };
  }
  const [first, ...rest] = old.pages;
  const newFirst: ReviewListPage = {
    items: [item, ...first!.items],
    next_cursor: first!.next_cursor,
  };
  return { ...old, pages: [newFirst, ...rest] };
}

/** Optimistically drop a review id from every page (delete / stale-404 eviction). */
export function removeFromList(old: InfiniteList | undefined, id: string): InfiniteList | undefined {
  if (!old) return old;
  return {
    ...old,
    pages: old.pages.map((p) => ({ ...p, items: p.items.filter((it) => it.id !== id) })),
  };
}
