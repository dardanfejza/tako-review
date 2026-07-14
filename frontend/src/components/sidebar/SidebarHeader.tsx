import { useTranslation } from 'react-i18next';
import { OCTOPUS_PATH_D } from '../../creatures/octopusPath';
import styles from './SidebarHeader.module.css';

export interface SidebarHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Clicking the brand (logo + name) returns to the home/hero state (= New review). */
  onHome: () => void;
}

/** Sidebar brand + collapse toggle (sidebar restyle). The brand is a button that returns home;
 *  it keeps the app title as its accessible name (h1) so the title landmark survives in both
 *  states (visually hidden in the rail, where only the logo shows). */
export function SidebarHeader({ collapsed, onToggleCollapse, onHome }: SidebarHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.header} ${collapsed ? styles.collapsed : ''}`}>
      <button type="button" className={styles.brandButton} onClick={onHome} title={t('common.appName')}>
        <span className={styles.logo} aria-hidden="true">
          <svg viewBox="-4 -4 108 132">
            <path fillRule="evenodd" fill="var(--brand)" d={OCTOPUS_PATH_D} />
          </svg>
        </span>
        <h1 className={styles.brand}>{t('common.appName')}</h1>
      </button>
      <button
        type="button"
        className={styles.toggle}
        aria-label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
        aria-expanded={!collapsed}
        onClick={onToggleCollapse}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  );
}
