import { useEffect, type RefObject } from 'react';

/**
 * Elements that can receive focus. The mount-time focus target uses this full set (so a labelling
 * `<h2 tabindex="-1">` can be the landing spot — spec §5.2), while Tab cycling uses the TABBABLE
 * subset below, which excludes `tabindex="-1"` so programmatic-only targets are never tab-stops.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]';

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

function tabbable(container: HTMLElement): HTMLElement[] {
  return focusable(container).filter((el) => el.getAttribute('tabindex') !== '-1');
}

export interface FocusTrapOptions {
  /** Called when Escape is pressed inside the trap. Omit for a non-dismissable modal. */
  onClose?: () => void;
}

/**
 * Traps keyboard focus inside the element referenced by `ref` (spec §5.2 a11y). On mount it moves
 * focus to the first focusable descendant so keyboard / screen-reader users land inside the dialog
 * rather than behind it. Tab / Shift+Tab wrap at the first and last tabbable elements so focus can
 * never escape to the content behind an `aria-modal` dialog. Escape invokes `onClose` if provided.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, { onClose }: FocusTrapOptions = {}) {
  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    // Remember what had focus before the trap opened so it can be restored on close — otherwise
    // dismissing an aria-modal dialog drops focus to <body>.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    focusable(container)[0]?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (!container) return;
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const stops = tabbable(container);
      if (stops.length === 0) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !container.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to the opener on close — otherwise dismissing the dialog drops focus to
      // <body>. Guard on the opener still being in the document (it may have been
      // unmounted) and on focus not having been deliberately moved elsewhere outside the trap;
      // during React teardown the trap's own nodes are already detached, so `document.body` (the
      // post-unmount default) counts as "still effectively inside" and restoration proceeds.
      const active = document.activeElement;
      const focusLeftIntentionally =
        active !== null &&
        active !== document.body &&
        !container.contains(active) &&
        active !== previouslyFocused;
      if (previouslyFocused?.isConnected && !focusLeftIntentionally) {
        previouslyFocused.focus();
      }
    };
  }, [ref, onClose]);
}
