"use client";

import { CircleCheck, Info, OctagonAlert, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "./button";
import { cx } from "./cx";
import { createToastTimers, pushToast, removeToast, type ToastStack, type ToastTimers } from "./toast-stack";

export type ToastTone = "neutral" | "positive" | "negative" | "warning" | "info";

export type ToastOptions = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  action?: { label: string; href: string };
  /** Milliseconds before the toast hides; `null` keeps it until dismissed. Errors stay by default. */
  duration?: number | null;
};

type ToastRecord = Omit<ToastOptions, "duration"> & { id: number; duration: number | null };

type ToastApi = {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 6000;
const EMPTY_STACK: ToastStack<ToastRecord> = { visible: [], queued: [] };

const toneIcon = {
  neutral: Info,
  info: Info,
  positive: CircleCheck,
  warning: TriangleAlert,
  negative: OctagonAlert,
} as const;

/**
 * Hosts the toast stack and its polite live region; mount it once near the root (AppShell does).
 * At most four toasts show at once: a new one replaces the oldest timed toast, and a toast that
 * stays until dismissed (errors by default) is never pushed out (see `pushToast`).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState(EMPTY_STACK);
  const nextId = useRef(1);
  const paused = useRef(false);
  const dismiss = useCallback((id: number) => setStack((current) => removeToast(current, id)), []);
  const [timers] = useState<ToastTimers>(() => createToastTimers({ expire: dismiss, isPaused: () => paused.current }));

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    const duration = options.duration === undefined ? (options.tone === "negative" ? null : DEFAULT_DURATION) : options.duration;
    setStack((current) => pushToast(current, { ...options, id, duration }));
    return id;
  }, []);

  useEffect(() => {
    timers.sync(stack.visible);
  }, [timers, stack.visible]);

  useEffect(() => () => timers.dispose(), [timers]);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  const setPaused = (value: boolean) => {
    paused.current = value;
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        className="toast-viewport"
        aria-label="Notifications"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <ol aria-live="polite" aria-relevant="additions text" className="toast-list">
          {stack.visible.map((item) => (
            <ToastItem key={item.id} toast={item} onDismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  const tone = toast.tone ?? "neutral";
  const Icon = toneIcon[tone];
  return (
    <li className={cx("toast", `toast-${tone}`)}>
      <Icon aria-hidden="true" className="toast-icon" />
      <div className="min-w-0">
        <p className="toast-title">{toast.title}</p>
        {toast.description && <p className="toast-description">{toast.description}</p>}
        {toast.action && (
          <Link href={toast.action.href} className="toast-action" onClick={() => onDismiss(toast.id)}>
            {toast.action.label}
          </Link>
        )}
      </div>
      <IconButton label="Dismiss notification" icon={<X />} size="sm" onClick={() => onDismiss(toast.id)} />
    </li>
  );
}

/** `toast({ title, description?, tone?, action?, duration? })` and `dismiss(id)`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider> (AppShell provides one).");
  return api;
}

/** Like `useToast`, but null outside a ToastProvider, for components that also render outside the shell. */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}
