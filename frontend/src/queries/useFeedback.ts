import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/apiClient';
import type { FeedbackCreate, ReviewDetail } from '../types/api';
import { reviewKeys } from './useReviews';

/**
 * Append-only feedback (FE §8.C). A re-vote is simply another POST (latest wins, never 409).
 * On success, patch ONLY the cached detail's embedded `feedback` field via setQueryData rather
 * than invalidating the whole detail query: an invalidate refetches a new detail object, whose
 * identity change re-fires ReviewWorkspace's restore effect and wipes in-progress edits
 * (regression: HIGH "voting re-fires restore effect"). Surgically updating the cache keeps the
 * vote reflected without a refetch.
 */
export function useFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedbackCreate) => api.postFeedback(body),
    onSuccess: (_r, vars) => {
      qc.setQueryData<ReviewDetail>(reviewKeys.detail(vars.session_id), (old) =>
        old ? { ...old, feedback: { rating: vars.rating, reason_tags: vars.reason_tags } } : old,
      );
    },
  });
}
