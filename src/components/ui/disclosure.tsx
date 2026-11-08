import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type DisclosureProps = Omit<ComponentProps<"details">, "children"> & {
  summary: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
};

/**
 * Native `<details>` disclosure: keyboard accessible without JavaScript, and its content is
 * part of the server HTML even while collapsed.
 */
export function Disclosure({ summary, children, className, bodyClassName, ...props }: DisclosureProps) {
  return (
    <details className={cx("disclosure", className)} {...props}>
      <summary className="disclosure-summary">
        <ChevronRight aria-hidden="true" className="disclosure-chevron" />
        <span>{summary}</span>
      </summary>
      <div className={cx("disclosure-body", bodyClassName)}>{children}</div>
    </details>
  );
}
