import { useTranslation } from 'react-i18next';
import styles from './RunReviewButton.module.css';

/**
 * The single circular action button at the editor's bottom-right (FE §6), chat-style:
 * idle = filled circle with an up-arrow ("send" affordance, accessible name review.run);
 * running = outlined circle with a square stop glyph + a soft pulse (the loading state,
 * accessible name review.stop). One slot, two states — Run is never shown while running.
 */
export function RunReviewButton({
  onRun,
  onCancel,
  running,
  disabled,
}: {
  onRun: () => void;
  onCancel: () => void;
  running: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (running) {
    return (
      <button
        type="button"
        className={`${styles.circle} ${styles.stop}`}
        onClick={onCancel}
        aria-label={t('review.stop')}
        title={t('review.stop')}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.circle} ${styles.send}`}
      onClick={onRun}
      disabled={disabled}
      aria-label={t('review.run')}
      title={t('review.run')}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path
          d="M8 12.5V3.5M3.75 7.75L8 3.5l4.25 4.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
