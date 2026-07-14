import { useTranslation } from 'react-i18next';
import type { Timing } from '../../types/api';
import styles from './TimingBadge.module.css';

/** "reviewed in 4.2s · 38 tok/s" (spec §5.3), straight from the mapUsage timing object. The wire
 *  fields are optional (a generation with no WebLLM usage omits them rather than faking 0), so
 *  display coalesces missing measurements to 0 per the api.ts Timing contract. */
export function TimingBadge({ timing }: { timing: Timing }) {
  const { t } = useTranslation();
  return (
    <span className={styles.timingBadge}>
      {t('review.timing', {
        seconds: ((timing.total_ms ?? 0) / 1000).toFixed(1),
        tokensPerSec: timing.tok_per_sec ?? 0,
      })}
    </span>
  );
}
