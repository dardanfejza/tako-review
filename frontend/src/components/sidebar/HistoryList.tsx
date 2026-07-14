import { useTranslation } from 'react-i18next';
import type { ReviewListItem } from '../../types/api';
import { HistoryItem } from './HistoryItem';
import styles from './HistoryList.module.css';

export interface HistoryListProps {
  items: ReviewListItem[];
  isLoading?: boolean;
  isError?: boolean;
  saveFailed?: boolean;
  hasMore?: boolean;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
  onRetrySave?: () => void;
  onRetryLoad?: () => void;
}

/** History list with empty / loading / load-error / save-failed / load-more states (FE §5.1). */
export function HistoryList({
  items,
  isLoading,
  isError,
  saveFailed,
  hasMore,
  selectedId,
  onSelect,
  onDelete,
  onLoadMore,
  onRetrySave,
  onRetryLoad,
}: HistoryListProps) {
  const { t } = useTranslation();
  // A failed LIST fetch (e.g. offline at load) must not degrade silently to "No reviews yet" —
  // that read like the user simply had no history. Surface it with a Retry, mirroring saveFailed.
  const loadFailed = !!isError && items.length === 0;
  return (
    <div className={styles.historyList}>
      {saveFailed && (
        <div className={styles.saveFailedBanner} role="alert">
          <span>{t('history.saveFailed')}</span>
          {onRetrySave && (
            <button type="button" onClick={onRetrySave}>
              {t('common.retry')}
            </button>
          )}
        </div>
      )}
      {loadFailed && (
        <div className={styles.saveFailedBanner} role="alert">
          <span>{t('history.loadFailed')}</span>
          {onRetryLoad && (
            <button type="button" onClick={onRetryLoad}>
              {t('common.retry')}
            </button>
          )}
        </div>
      )}
      {isLoading && items.length === 0 && <p className={styles.historyLoading}>{t('common.loading')}</p>}
      {!isLoading && !loadFailed && items.length === 0 && (
        <p className={styles.historyEmpty}>{t('history.empty')}</p>
      )}
      {items.length > 0 && (
        <ul>
          {items.map((it) => (
            <HistoryItem
              key={it.id}
              item={it}
              selected={it.id === selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      {hasMore && (
        <button type="button" className={styles.loadMore} onClick={onLoadMore}>
          {t('history.loadMore')}
        </button>
      )}
    </div>
  );
}
