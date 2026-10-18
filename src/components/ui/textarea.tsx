"use client";

import { type ComponentProps, type InputEvent as ReactInputEvent, useCallback, useEffect, useRef } from "react";
import { cx } from "./cx";

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Grows with its content up to the CSS max height (default on). */
  autosize?: boolean;
};

const supportsFieldSizing = () => typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

export function Textarea({ autosize = true, className, onInput, ref, value, ...props }: TextareaProps) {
  const element = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const node = element.current;
    if (!autosize || !node || supportsFieldSizing()) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
  }, [autosize]);

  // Re-measure when a controlled value changes from outside (for example after a reset).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, not an input of `resize`.
  useEffect(resize, [resize, value]);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      element.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const handleInput = (event: ReactInputEvent<HTMLTextAreaElement>) => {
    resize();
    onInput?.(event);
  };

  return <textarea ref={setRef} className={cx("input", className)} value={value} onInput={handleInput} {...props} />;
}
