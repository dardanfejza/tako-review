import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../providers/AuthProvider';
import { AuthModal } from './AuthModal';
import { Tooltip } from './Tooltip';
import styles from './AuthMenu.module.css';

export interface AuthMenuProps {
  collapsed?: boolean;
  onExpand?: () => void;
}

/** Footer identity + account popover (FE §9, sidebar restyle). Branches on is_guest. */
export function AuthMenu({ collapsed = false, onExpand }: AuthMenuProps) {
  const { t } = useTranslation();
  const { user, signInGitHub, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const isGuest = user === null || user.is_guest;
  const name = user && !user.is_guest ? user.display_name : t('auth.guestBadge');
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  if (collapsed) {
    return (
      <button type="button" className={styles.avatarButton} aria-label={t('sidebar.account')} onClick={onExpand}>
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
      </button>
    );
  }

  return (
    <div className={styles.root} ref={rootRef}>
      {menuOpen && (
        <div className={styles.menu} role="menu">
          {isGuest ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setModalOpen(true);
              }}
            >
              {t('auth.signIn')}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                signOut();
              }}
            >
              {t('auth.signOut')}
            </button>
          )}
        </div>
      )}
      {/* Guests get a persistence pitch on hover/focus; suppressed while the menu is open */}
      <Tooltip label={t('auth.signInTooltip')} disabled={!isGuest || menuOpen}>
        <button
          type="button"
          className={styles.identity}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('sidebar.account')}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className={styles.avatar} aria-hidden="true">{initial}</span>
          <span className={styles.name}>{name}</span>
          <svg className={styles.chev} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </Tooltip>
      {modalOpen && <AuthModal onGitHub={signInGitHub} onClose={() => setModalOpen(false)} />}
    </div>
  );
}
