import type { ComponentProps } from "react";
import { cx } from "./cx";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd className={cx("kbd", className)} {...props} />;
}

/** A key combination such as Ctrl + K; `label` is the spoken form ("Control K"). */
export function KbdCombo({ keys, label, className }: { keys: string[]; label?: string; className?: string }) {
  return (
    <span className={cx("kbd-combo", className)}>
      {label && <span className="sr-only">{label}</span>}
      {keys.map((key) => (
        <Kbd key={key} aria-hidden={label ? true : undefined}>
          {key}
        </Kbd>
      ))}
    </span>
  );
}
