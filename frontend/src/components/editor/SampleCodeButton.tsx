import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SAMPLE_CATALOG, pickSampleIndex } from './sampleCatalog';
import styles from './SampleCodeButton.module.css';

/**
 * Canonical one-click sample (spec §5.2) — the first catalog entry, kept exported
 * for ReviewWorkspace's CapabilityGate onTrySample seed.
 */
export const SAMPLE_CODE = SAMPLE_CATALOG[0]!.code;

export function SampleCodeButton({
  onSeed,
  disabled,
}: {
  onSeed: (code: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const lastIndexRef = useRef<number | null>(null);
  return (
    <button
      type="button"
      className={styles.sampleCode}
      disabled={disabled}
      onClick={() => {
        const index = pickSampleIndex(lastIndexRef.current);
        lastIndexRef.current = index;
        onSeed(SAMPLE_CATALOG[index]!.code);
      }}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path
          d="M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13M6 8h5M6 11h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
      {t('review.sampleCode')}
    </button>
  );
}
