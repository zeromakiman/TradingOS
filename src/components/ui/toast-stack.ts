/** A toast as the stack sees it: `duration` null means it stays until the person dismisses it. */
export type StackedToast = { id: number; duration: number | null };

/** Toasts on screen, oldest first, and toasts waiting for room, in arrival order. */
export type ToastStack<T extends StackedToast> = { visible: T[]; queued: T[] };

export const MAX_VISIBLE_TOASTS = 4;

/**
 * The stack after a new toast arrives. A full stack makes room by removing its oldest timed
 * toast. Persistent toasts (errors by default) are only ever removed by the person, so while
 * every visible toast is persistent, new toasts wait in arrival order instead of disappearing.
 */
export function pushToast<T extends StackedToast>(stack: ToastStack<T>, toast: T, limit = MAX_VISIBLE_TOASTS): ToastStack<T> {
  if (stack.queued.length > 0) return { visible: stack.visible, queued: [...stack.queued, toast] };
  if (stack.visible.length < limit) return { visible: [...stack.visible, toast], queued: [] };
  const oldestTimed = stack.visible.findIndex((item) => item.duration !== null);
  if (oldestTimed === -1) return { visible: stack.visible, queued: [toast] };
  return { visible: [...stack.visible.filter((_, index) => index !== oldestTimed), toast], queued: [] };
}

/** The stack after a toast is dismissed or expires: waiting toasts take the free places in arrival order. */
export function removeToast<T extends StackedToast>(stack: ToastStack<T>, id: number, limit = MAX_VISIBLE_TOASTS): ToastStack<T> {
  const visible = stack.visible.filter((item) => item.id !== id);
  const queued = stack.queued.filter((item) => item.id !== id);
  const room = Math.max(0, limit - visible.length);
  return { visible: [...visible, ...queued.slice(0, room)], queued: queued.slice(room) };
}

/** How long an expired toast waits before checking again while the person is pointing at or focused in the stack. */
export const PAUSED_RECHECK_MS = 1000;

export type ToastTimers = {
  /** Call with the visible toasts whenever they change. */
  sync(visible: readonly StackedToast[]): void;
  /** Clears every pending countdown. */
  dispose(): void;
};

/**
 * Countdowns of timed toasts. A countdown starts when its toast becomes visible (a queued toast
 * has not been seen yet) and stops when the toast leaves. When it ends while `isPaused()` (the
 * pointer or focus is inside the stack), expiry waits and checks again, so a toast being read
 * never disappears.
 */
export function createToastTimers({ expire, isPaused }: { expire: (id: number) => void; isPaused: () => boolean }): ToastTimers {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const schedule = (id: number, delay: number) => {
    timers.set(
      id,
      setTimeout(() => {
        if (isPaused()) {
          schedule(id, PAUSED_RECHECK_MS);
          return;
        }
        timers.delete(id);
        expire(id);
      }, delay),
    );
  };
  return {
    sync(visible) {
      const shown = new Set(visible.map((item) => item.id));
      for (const [id, timer] of timers) {
        if (shown.has(id)) continue;
        clearTimeout(timer);
        timers.delete(id);
      }
      for (const item of visible) {
        if (item.duration !== null && !timers.has(item.id)) schedule(item.id, item.duration);
      }
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
