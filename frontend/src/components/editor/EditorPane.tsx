import type { Ref, ReactNode } from 'react';
import { fileNameFrom } from '../../lib/reviewMeta';
import { CodeInput, type CodeInputVariant, type CodeInputHandle } from './CodeInput';
import { RunReviewButton } from './RunReviewButton';
import { SampleCodeButton } from './SampleCodeButton';
import styles from './EditorPane.module.css';

const LANG_CHIP: Record<string, { label: string; bg: string; fg: string }> = {
  python: { label: 'PY', bg: '#3776ab', fg: '#ffffff' },
  typescript: { label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  javascript: { label: 'JS', bg: '#f7df1e', fg: '#12151c' },
};

export interface EditorPaneProps {
  code: string;
  onCodeChange: (code: string) => void;
  language: string;
  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  validationError?: string | null;
  codeInputVariant?: CodeInputVariant;
  editorRef?: Ref<CodeInputHandle>;
  modelSelector?: ReactNode;
  /** 'card' (default) is the floating hero card; 'panel' is the full-height split panel
   *  with a file tab and no card chrome (workspace shell redesign). */
  variant?: 'card' | 'panel';
}

/**
 * Composes the editor controls and enforces the input-lock during REVIEWING (FE §7): the editor,
 * sample button, and Run are disabled while running, and a Stop affordance appears.
 */
export function EditorPane({
  code,
  onCodeChange,
  language,
  running,
  canRun,
  onRun,
  onCancel,
  validationError,
  codeInputVariant,
  editorRef,
  modelSelector,
  variant = 'card',
}: EditorPaneProps) {
  const panel = variant === 'panel';
  const chip = LANG_CHIP[language.toLowerCase()] ?? { label: 'TXT', bg: 'var(--panel-raised)', fg: 'var(--text-muted)' };
  return (
    <section className={`${styles.editorPane}${panel ? ' ' + styles.editorPanel : ''}`}>
      {panel && (
        <div className={styles.filetabRow}>
          <span className={styles.filetab}>
            <span className={styles.langChip} style={{ background: chip.bg, color: chip.fg }} aria-hidden="true">
              {chip.label}
            </span>
            {fileNameFrom(code, language)}
          </span>
        </div>
      )}
      <div className={styles.editorCard}>
        <CodeInput
          ref={editorRef}
          variant={codeInputVariant}
          value={code}
          onChange={onCodeChange}
          language={language}
          readOnly={running}
          onSubmit={canRun && !running ? onRun : undefined}
        />
        <div className={styles.editorActions}>
          <SampleCodeButton onSeed={onCodeChange} disabled={running} />
          {validationError && (
            <p role="alert" className={styles.validationError}>{validationError}</p>
          )}
          <span className={styles.spacer} />
          {modelSelector}
          <RunReviewButton onRun={onRun} onCancel={onCancel} running={running} disabled={!canRun} />
        </div>
      </div>
    </section>
  );
}
