import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useLocale } from '../../providers/LocaleProvider';
import styles from './SettingsModal.module.css';

export interface SettingsModalProps {
  onClose: () => void;
  /** Telemetry opt-out is owned (and reconciled) by the always-mounted SettingsMenu so the
   *  server→local sync isn't gated on the dialog being open; the modal is a controlled view. */
  optedOut: boolean;
  onOptedOutChange: (next: boolean) => void;
}

/**
 * Dedicated settings dialog (replaces the cramped footer popover). Reuses AuthModal's
 * overlay + backdrop + focus-trap pattern (role=dialog, dismissable via Escape / close /
 * backdrop). Hosts the per-user preferences — UI language (LocaleProvider) and usage-metrics
 * opt-out (lifted to SettingsMenu).
 */
export function SettingsModal({ onClose, optedOut, onOptedOutChange }: SettingsModalProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose });

  return (
    <div className={styles.overlay}>
      <div
        data-backdrop
        className={styles.backdrop}
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      />
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('common.close')}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <h2 id="settings-modal-title" tabIndex={-1}>{t('settings.title')}</h2>

        {/* Language */}
        <div className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>{t('settings.languageLabel')}</span>
            <span className={styles.rowHint}>{t('settings.languageHint')}</span>
          </div>
          <div className={styles.segmented} role="group" aria-label={t('settings.languageLabel')}>
            <button
              type="button"
              className={locale === 'en' ? styles.segActive : styles.seg}
              aria-pressed={locale === 'en'}
              onClick={() => setLocale('en')}
            >
              English
            </button>
            <button
              type="button"
              className={locale === 'ja' ? styles.segActive : styles.seg}
              aria-pressed={locale === 'ja'}
              onClick={() => setLocale('ja')}
            >
              日本語
            </button>
          </div>
        </div>

        {/* Usage metrics */}
        <label className={styles.row}>
          <div className={styles.rowText}>
            <span className={styles.rowLabel}>{t('settings.telemetryLabel')}</span>
            <span className={styles.rowHint}>{t('settings.telemetryHint')}</span>
          </div>
          <input
            type="checkbox"
            className={styles.switch}
            checked={!optedOut}
            onChange={(e) => onOptedOutChange(!e.target.checked)}
            aria-label={t('settings.telemetryLabel')}
          />
        </label>
      </div>
    </div>
  );
}
