import { useTranslation } from 'react-i18next';
import styles from './ChunkProgress.module.css';

/** "Reviewing section 2 of 5" during map/reduce (FE §4.6). Renders nothing for a single chunk. */
export function ChunkProgress({ index, total }: { index: number; total: number }) {
  const { t } = useTranslation();
  if (total <= 1) return null;
  return (
    <p className={styles.chunkProgress} aria-live="polite">
      {t('review.chunkProgress', { index, total })}
    </p>
  );
}
