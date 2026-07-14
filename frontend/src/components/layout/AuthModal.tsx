import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import styles from './AuthModal.module.css';

const DISABLED_PROVIDERS = ['Google', 'Apple', 'Line'] as const;

/** Sign-in modal. GitHub is the only wired provider; Google/Apple/LINE are presentational
 *  placeholders (disabled, "coming soon"). Dismissable via Escape / close button / backdrop. */
export function AuthModal({ onGitHub, onClose }: { onGitHub: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose });

  return (
    <div className={styles.overlay}>
      <div data-backdrop className={styles.backdrop} role="presentation" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        <button type="button" className={styles.close} onClick={onClose}>
          {t('common.close')}
        </button>
        <h2 id="auth-modal-title" tabIndex={-1}>{t('auth.modalTitle')}</h2>

        <button type="button" className={styles.github} onClick={onGitHub}>
          {t('auth.continueWithGitHub')}
        </button>

        {DISABLED_PROVIDERS.map((p) => (
          <button key={p} type="button" className={styles.provider} disabled aria-disabled="true">
            <span>{t(`auth.continueWith${p}`)}</span>
            <span className={styles.soon}>{t('auth.providerComingSoon')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
