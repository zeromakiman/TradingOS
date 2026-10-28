"use client";

import { type ComponentProps, type InputEvent as ReactInputEvent, useCallback, useEffect, useRef } from "react";
import { cx } from "./cx";

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Grows with its content up to the CSS max height (default on). */
  autosize?: boolean;
};

const supportsFieldSizing = () => typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/**
 * Touch screens (§13.5: 44px targets): the vertical padding grows just enough that one line of text, its padding and
 * the 1px borders reach 44px at either type size (`1lh` is the field's line height). Padding, not a minimum height:
 * a 44px minimum would replace a taller field's own minimum (the 88px default, a 128px notes field) on touch screens,
 * and a one-line field such as the journal composer (`min-h-10`) would otherwise stay 42px. Desktop density is unchanged.
 */
export const TEXTAREA_TOUCH_TARGET = "pointer-coarse:py-[max(0.5rem,calc((2.75rem_-_1lh)/2_-_1px))]";

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

  return <textarea ref={setRef} className={cx("input", TEXTAREA_TOUCH_TARGET, className)} value={value} onInput={handleInput} {...props} />;
}
