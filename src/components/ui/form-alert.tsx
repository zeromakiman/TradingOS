"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { Callout } from "./callout";

export type FormAlertProps = {
  tone: "error" | "success";
  title?: ReactNode;
  children: ReactNode;
  /** Moves focus to an error when it appears, so keyboard and screen-reader users land on it. */
  focusOnMount?: boolean;
  id?: string;
  className?: string;
};

/**
 * Result of a form submission: errors use `role="alert"` and receive focus; successes use
 * `role="status"` (polite). Link fields to the message with `aria-describedby={id}`.
 */
export function FormAlert({ tone, title, children, focusOnMount = tone === "error", id, className }: FormAlertProps) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnMount) element.current?.focus();
  }, [focusOnMount]);

  return (
    <Callout
      ref={element}
      id={id}
      tabIndex={-1}
      role={tone === "error" ? "alert" : "status"}
      tone={tone === "error" ? "negative" : "positive"}
      title={title}
      className={className}
    >
      {children}
    </Callout>
  );
}
