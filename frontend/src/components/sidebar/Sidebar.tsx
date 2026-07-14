import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SidebarHeader } from './SidebarHeader';
import { SidebarFooter } from './SidebarFooter';
import { NewReviewButton } from './NewReviewButton';
import { HistoryList, type HistoryListProps } from './HistoryList';
import styles from './Sidebar.module.css';

export interface SidebarProps extends HistoryListProps {
  onNewReview: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  showBody: boolean;
  open?: boolean;
  onClose?: () => void;
}

/** Persistent app chrome: brand + new-review + history + identity (sidebar restyle, FE §6).
 *  Header/footer render in every state; the body (new-review + history) only when `showBody`.
 *
 *  Mobile drawer: when `open`, it is a keyboard-dismissable off-canvas drawer — a
 *  document-level Escape listener closes it, focus moves into the drawer on open and is restored to
 *  the trigger on close, and selecting a history item closes it. The desktop collapse toggle is
 *  hidden in drawer mode (it is meaningless when the sidebar is already full-width). */
export function Sidebar({
  onNewReview,
  collapsed,
  onToggleCollapse,
  showBody,
  open = false,
  onClose,
  onSelect,
  ...listProps
}: SidebarProps) {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Drawer keyboard support: Escape closes; focus moves inside on open and is
  // restored to whatever opened it on close, so keyboard / SR users are never stranded.
  useEffect(() => {
    if (!open || !onClose) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    // Move focus into the drawer (first focusable, falling back to the aside itself).
    const first = asideRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (first ?? asideRef.current)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  // Selecting a history item dismisses the drawer so the result is visible on mobile.
  const handleSelect = (id: string) => {
    onSelect(id);
    if (open && onClose) onClose();
  };

  const expand = () => {
    if (collapsed) onToggleCollapse();
  };
  return (
    <>
      {open && onClose && (
        <div className={styles.backdrop} role="presentation" onClick={onClose} />
      )}
      <aside
        ref={asideRef}
        className={`${styles.sidebar} ${collapsed ? styles.rail : ''} ${open ? styles.open : ''}`}
        aria-label={t('common.appName')}
        tabIndex={open ? -1 : undefined}
      >
        <SidebarHeader collapsed={collapsed} onToggleCollapse={onToggleCollapse} onHome={onNewReview} />
        {open && onClose && (
          <button type="button" className={styles.drawerClose} aria-label={t('common.close')} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {showBody && (
          <div className={styles.body}>
            <NewReviewButton onClick={onNewReview} collapsed={collapsed} />
            {collapsed ? (
              <button
                type="button"
                className={styles.historyIcon}
                aria-label={t('history.title')}
                onClick={expand}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <>
                <h2 className={styles.sidebarTitle}>{t('history.title')}</h2>
                <HistoryList {...listProps} onSelect={handleSelect} />
              </>
            )}
          </div>
        )}
        <SidebarFooter collapsed={collapsed} onExpand={expand} />
      </aside>
    </>
  );
}
