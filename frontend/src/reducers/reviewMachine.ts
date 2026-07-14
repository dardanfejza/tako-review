/**
 * The single explicit application state machine (FE §7). PURE: `reduce(state, event) → state`.
 * Unknown transitions are no-ops (the "wrong-button" guard — clicking history during REVIEWING,
 * etc. — never corrupts an in-flight run). RESULT is conceptually READY-with-a-review on screen.
 */
export type ReviewState =
  | 'PREFLIGHT'
  | 'CAPABLE'
  | 'UNSUPPORTED'
  | 'DOWNLOADING'
  | 'READY'
  | 'DL_CANCELLED'
  | 'DOWNLOAD_ERROR'
  | 'REVIEWING'
  | 'RESULT'
  | 'REVIEW_ERROR'
  | 'REVIEW_CANCELLED'
  | 'SAVE_FAILED'
  | 'DEVICE_LOST';

export type ReviewEventType =
  | 'PROBE_OK'
  | 'PROBE_FAIL'
  | 'REPROBE_OK'
  | 'REPROBE_FAIL'
  | 'LOAD_MODEL'
  | 'LOAD_COMPLETE'
  | 'DL_CANCEL'
  | 'DL_ERROR'
  | 'DL_RESUME'
  | 'DL_RETRY'
  | 'RUN_REVIEW'
  | 'GEN_COMPLETE'
  | 'GEN_ERROR'
  | 'GEN_CANCEL'
  | 'SAVE_FAILED'
  | 'SAVE_RETRY_OK'
  | 'NEW_REVIEW'
  | 'RESTORE'
  | 'DEVICE_LOST';

export interface ReviewEvent {
  type: ReviewEventType;
}

export const INITIAL_STATE: ReviewState = 'PREFLIGHT';

type Transitions = Partial<Record<ReviewEventType, ReviewState>>;

const TABLE: Record<ReviewState, Transitions> = {
  PREFLIGHT: { PROBE_OK: 'CAPABLE', PROBE_FAIL: 'UNSUPPORTED' },
  UNSUPPORTED: { REPROBE_OK: 'CAPABLE', REPROBE_FAIL: 'UNSUPPORTED' },
  CAPABLE: { LOAD_MODEL: 'DOWNLOADING' },
  DOWNLOADING: {
    LOAD_COMPLETE: 'READY',
    DL_CANCEL: 'DL_CANCELLED',
    DL_ERROR: 'DOWNLOAD_ERROR',
  },
  DL_CANCELLED: { DL_RESUME: 'DOWNLOADING', LOAD_MODEL: 'DOWNLOADING' },
  DOWNLOAD_ERROR: { DL_RETRY: 'DOWNLOADING', LOAD_MODEL: 'DOWNLOADING' },
  READY: { RUN_REVIEW: 'REVIEWING', RESTORE: 'READY', DEVICE_LOST: 'DEVICE_LOST' },
  REVIEWING: {
    GEN_COMPLETE: 'RESULT',
    GEN_ERROR: 'REVIEW_ERROR',
    GEN_CANCEL: 'REVIEW_CANCELLED',
    // "Home" / New review while a review streams: abandon it straight to READY. The caller
    // (ReviewWorkspace.onNewReview) calls engine.cancel() first so the worker actually stops;
    // the run loop's late cooperative GEN_CANCEL then lands on READY and is harmlessly ignored.
    NEW_REVIEW: 'READY',
    DEVICE_LOST: 'DEVICE_LOST',
  },
  RESULT: {
    SAVE_FAILED: 'SAVE_FAILED',
    NEW_REVIEW: 'READY',
    RESTORE: 'READY',
    // The real run entry (EngineProvider.run) dispatches RUN_REVIEW, not the old RUN_AGAIN —
    // accept it here so a re-run from a finished review actually re-enters REVIEWING (input lock,
    // Stop button, no concurrent runs, errors surfaced).
    RUN_REVIEW: 'REVIEWING',
    DEVICE_LOST: 'DEVICE_LOST',
  },
  REVIEW_ERROR: { NEW_REVIEW: 'READY', RUN_REVIEW: 'REVIEWING' },
  REVIEW_CANCELLED: { NEW_REVIEW: 'READY', RUN_REVIEW: 'REVIEWING' },
  // The New-review / Run / restore controls stay enabled while the save banner is up; without
  // these rows their dispatches were silent no-ops that stranded the machine in SAVE_FAILED.
  SAVE_FAILED: {
    SAVE_RETRY_OK: 'RESULT',
    NEW_REVIEW: 'READY',
    RESTORE: 'READY',
    RUN_REVIEW: 'REVIEWING',
  },
  DEVICE_LOST: { REPROBE_OK: 'CAPABLE', REPROBE_FAIL: 'UNSUPPORTED' },
};

export function reduce(state: ReviewState, event: ReviewEvent): ReviewState {
  const next = TABLE[state][event.type];
  if (next === undefined) {
    // Unknown transition = no-op (the wrong-button guard). Warn in dev so a future dead event
    // (a dispatch the current state silently swallows) surfaces instead of failing invisibly.
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[reviewMachine] ignored event "${event.type}" in state "${state}"`);
    }
    return state;
  }
  return next;
}
