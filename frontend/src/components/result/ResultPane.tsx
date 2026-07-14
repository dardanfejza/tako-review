import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownReview } from './MarkdownReview';
import { TimingBadge } from './TimingBadge';
import { ChunkProgress } from './ChunkProgress';
import { FeedbackWidget } from './FeedbackWidget';
import type { Rating, ReasonTag, ReviewFeedback, Timing } from '../../types/api';
import type { LineRange } from '../../lib/lineNumber';
import styles from './ResultPane.module.css';

export interface ResultPaneProps {
  content: string;
  timing?: Timing | null;
  chunk?: { index: number; total: number };
  reviewId: string | null;
  /** True while generation is streaming (FE §7). Gates the busy status and defers feedback. */
  running?: boolean;
  /** True when the run was stopped early, leaving partial output (FE §7). */
  cancelled?: boolean;
  saving?: boolean;
  saveFailed?: boolean;
  currentFeedback?: ReviewFeedback | null;
  onVote: (rating: Rating, tags: ReasonTag[]) => void;
  onCitationClick?: (range: LineRange) => void;
}

/**
 * The result surface (FE §6): chunk progress, timing, sanitized review, and feedback.
 *
 * a11y: the streaming markdown is NOT wrapped in aria-live — react-markdown re-parses
 * the whole tree on every token, which would make a screen reader re-announce the entire review for
 * minutes. Instead a single visually-hidden role="status" announces only start ("Reviewing…") and
 * completion, and the markdown container carries aria-busy while streaming. The feedback widget is
 * deferred until generation finishes (no point voting on a partial stream), and a stopped run badges
 * its output as a partial result.
 */
export function ResultPane({
  content,
  timing,
  chunk,
  reviewId,
  running,
  cancelled,
  saving,
  saveFailed,
  currentFeedback,
  onVote,
  onCitationClick,
}: ResultPaneProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reset the "Copied" affordance when the content changes (a new / restored review).
  useEffect(() => {
    setCopied(false);
    return () => clearTimeout(copiedTimer.current);
  }, [content]);

  const onCopy = () => {
    void navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  // SR announcement: only the transition matters, not the streamed tokens.
  const announce = running
    ? t('review.running')
    : content
      ? t('review.complete')
      : '';
  // Deferred until generation finishes (no voting on a partial stream). The widget itself handles
  // the disabled / save-to-enable states while the save settles.
  const showFeedback = !running && content.length > 0;
  const showCopy = !running && content.length > 0;

  return (
    <section className={styles.resultPane}>
      <p className={styles.srStatus} role="status">
        {announce}
      </p>
      {chunk && <ChunkProgress index={chunk.index} total={chunk.total} />}
      {cancelled && content.length > 0 && (
        <p className={styles.stoppedBadge}>{t('review.stoppedPartial')}</p>
      )}
      {/* The review text takes the slack; copy/feedback/timing pin to the bottom */}
      <div className={styles.reviewBody}>
        {running && content.length === 0 ? (
          <p className={styles.reviewing}>{t('review.running')}</p>
        ) : (
          <div aria-busy={running ? true : undefined}>
            <MarkdownReview content={content} onCitationClick={onCitationClick} />
          </div>
        )}
      </div>
      {showCopy && (
        <div className={styles.resultActions}>
          <button type="button" className={styles.copyBtn} onClick={onCopy}>
            {copied ? t('review.copied') : t('review.copy')}
          </button>
        </div>
      )}
      {showFeedback && (
        <FeedbackWidget
          reviewId={reviewId}
          saving={saving}
          saveFailed={saveFailed}
          currentFeedback={currentFeedback}
          onVote={onVote}
        />
      )}
      {timing && <TimingBadge timing={timing} />}
    </section>
  );
}
