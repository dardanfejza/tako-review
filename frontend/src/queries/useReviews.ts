import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/apiClient';
import type { ReviewCreate, ReviewListPage } from '../types/api';
import { prependToList, removeFromList, toListItem, type InfiniteList } from './reviewsCache';

export const reviewKeys = {
  list: ['reviews'] as const,
  detail: (id: string) => ['reviews', id] as const,
};

/**
 * Keyset-paginated history list (API §5.3). next_cursor drives "load more".
 * `enabled` gates the fetch behind an established principal (caller passes `!!user`) so the list
 * doesn't 401 before the auto-guest session exists and then never refetch (LOW "reviews list 401s
 * before guest session"). When the session is established the query runs (and refetches on the
 * `enabled` flip).
 */
export function useReviewsInfinite(limit = 20, enabled = true) {
  return useInfiniteQuery({
    queryKey: reviewKeys.list,
    queryFn: ({ pageParam }) => api.listReviews({ limit, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: ReviewListPage) => last.next_cursor,
    enabled,
  });
}

/** Restore: full record incl. embedded feedback. No re-inference (FE §8.B). */
export function useReviewDetail(id: string | null) {
  return useQuery({
    queryKey: id ? reviewKeys.detail(id) : ['reviews', '__none__'],
    queryFn: () => api.getReview(id!),
    enabled: id !== null,
  });
}

/** Save flow: on 201 prepend to the history list cache (FE §3.1). */
export function useCreateReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewCreate) => api.createReview(body),
    onSuccess: (detail) => {
      qc.setQueryData<InfiniteList>(reviewKeys.list, (old) => prependToList(old, toListItem(detail)));
    },
  });
}

/** Optimistic delete with rollback on error (FE §8.B). */
export function useDeleteReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteReview(id),
    onMutate: async (id) => {
      // `exact: true`: the list key ['reviews'] is a PREFIX of every detail key ['reviews', id],
      // so a non-exact cancel would abort an in-flight restore fetch (LOW "delete prefix-cancels
      // an in-flight restore"). Cancel only the list query.
      await qc.cancelQueries({ queryKey: reviewKeys.list, exact: true });
      const prev = qc.getQueryData<InfiniteList>(reviewKeys.list);
      qc.setQueryData<InfiniteList>(reviewKeys.list, (old) => removeFromList(old, id));
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(reviewKeys.list, ctx.prev);
    },
  });
}
