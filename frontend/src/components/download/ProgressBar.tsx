import { useTranslation } from 'react-i18next';
import styles from './ProgressBar.module.css';

/** Determinate progress bar with progressbar a11y semantics (FE §10). `value` is 0..1. */
export function ProgressBar({ value }: { value: number }) {
  const { t } = useTranslation();
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={styles.progressBar}
      role="progressbar"
      aria-label={t('download.progressLabel')}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={styles.progressFill} style={{ width: `${pct}%` }} />
    </div>
  );
}
