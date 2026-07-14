import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { REASON_TAGS, type Rating, type ReasonTag, type ReviewFeedback } from '../../types/api';
import styles from './FeedbackWidget.module.css';

const TAG_KEY: Record<ReasonTag, string> = {
  inaccurate: 'feedback.tagInaccurate',
  too_vague: 'feedback.tagTooVague',
  wrong_language: 'feedback.tagWrongLanguage',
  hallucinated: 'feedback.tagHallucinated',
};

export interface FeedbackWidgetProps {
  /** The saved review id (== session_id). null while saving or after a save failure. */
  reviewId: string | null;
  saving?: boolean;
  saveFailed?: boolean;
  currentFeedback?: ReviewFeedback | null;
  onVote: (rating: Rating, tags: ReasonTag[]) => void;
}

/**
 * 👍/👎 + reason tags (spec §5.4). Disabled until the review id exists (gated on a successful save);
 * append-only — a re-vote is just another onVote (latest wins, never a conflict). ≤4 tags.
 */
export function FeedbackWidget({
  reviewId,
  saving,
  saveFailed,
  currentFeedback,
  onVote,
}: FeedbackWidgetProps) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<ReasonTag[]>(currentFeedback?.reason_tags ?? []);
  // The useState initializer runs only on mount, so switching reviews from history (a new
  // `currentFeedback` on the SAME mounted widget) would otherwise keep the prior review's tag
  // selection — and submit review B with review A's tags. Resync on every feedback change.
  useEffect(() => setTags(currentFeedback?.reason_tags ?? []), [currentFeedback]);
  const enabled = reviewId !== null && !saving;

  const toggleTag = (tag: ReasonTag) => {
    const next = tags.includes(tag)
      ? tags.filter((x) => x !== tag)
      : tags.length < 4
        ? [...tags, tag]
        : tags;
    if (next === tags) return; // 4-tag cap reached, no change
    setTags(next);
    // Reason tags ride a rating (the backend feedback row requires one). Once the user has voted,
    // toggling a tag must PERSIST immediately — otherwise selecting "Inaccurate" after clicking
    // Helpful is only local state and is lost on reload/restore. Before any vote, the selection
    // stays pending until a rating is chosen (it then submits with these tags).
    if (currentFeedback?.rating) onVote(currentFeedback.rating, next);
  };

  return (
    <div className={styles.feedbackWidget}>
      <p>{t('feedback.prompt')}</p>
      <div className={styles.feedbackRatings}>
        <button
          type="button"
          className={styles.feedbackBtn}
          disabled={!enabled}
          aria-pressed={currentFeedback?.rating === 'up'}
          onClick={() => onVote('up', tags)}
        >
          {t('feedback.up')}
        </button>
        <button
          type="button"
          className={styles.feedbackBtn}
          disabled={!enabled}
          aria-pressed={currentFeedback?.rating === 'down'}
          onClick={() => onVote('down', tags)}
        >
          {t('feedback.down')}
        </button>
      </div>
      <fieldset className={styles.feedbackTags} disabled={!enabled}>
        {REASON_TAGS.map((tag) => (
          <label key={tag}>
            <input type="checkbox" checked={tags.includes(tag)} onChange={() => toggleTag(tag)} />
            {t(TAG_KEY[tag])}
          </label>
        ))}
      </fieldset>
      {reviewId === null && saveFailed && <p className={styles.hint}>{t('feedback.saveToEnable')}</p>}
      {reviewId === null && saving && <p className={styles.hint}>{t('common.loading')}</p>}
    </div>
  );
}
