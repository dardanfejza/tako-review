import { useTranslation } from 'react-i18next';
import { useAuthErrorParam } from './useAuthErrorParam';
import styles from './AuthErrorBanner.module.css';

/** OAuth error notice (FE §9), rendered in the main pane so it survives sidebar collapse. */
export function AuthErrorBanner() {
  const { t } = useTranslation();
  const { errorKey, dismiss } = useAuthErrorParam();
  if (!errorKey) return null;
  return (
    <p role="alert" className={styles.banner}>
      <span>{t(errorKey)}</span>
      <button type="button" className={styles.dismiss} onClick={dismiss}>
        {t('common.close')}
      </button>
    </p>
  );
}
