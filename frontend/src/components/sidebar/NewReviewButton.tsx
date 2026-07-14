import { useTranslation } from 'react-i18next';
import styles from './NewReviewButton.module.css';

export interface NewReviewButtonProps {
  onClick: () => void;
  collapsed?: boolean;
}

/** Sleek ghost new-review action (sidebar restyle). Collapsed → icon-only, label kept for AT. */
export function NewReviewButton({ onClick, collapsed = false }: NewReviewButtonProps) {
  const { t } = useTranslation();
  const label = t('review.newReview');
  return (
    <button
      type="button"
      className={`${styles.newReview} ${collapsed ? styles.collapsed : ''}`}
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
    >
      <svg className={styles.icon} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {!collapsed && <span>{label}</span>}
    </button>
  );
}
