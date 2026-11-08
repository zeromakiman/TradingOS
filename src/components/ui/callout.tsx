import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export type CalloutTone = "info" | "positive" | "warning" | "negative" | "neutral";

const toneIcon = {
  info: Info,
  positive: CircleCheck,
  warning: TriangleAlert,
  negative: OctagonAlert,
  neutral: Info,
} as const;

export type CalloutProps = Omit<ComponentProps<"div">, "title"> & {
  tone?: CalloutTone;
  title?: ReactNode;
  /** Replaces the tone's default icon; `false` hides it. */
  icon?: ReactNode | false;
  /** Buttons or links shown under the body. */
  action?: ReactNode;
};

/**
 * Inline message with an icon, a title and a body. Pass `role="alert"` for errors that
 * appear after an action and `role="status"` for results announced politely.
 */
export function Callout({ tone = "info", title, icon, action, className, children, ...props }: CalloutProps) {
  const DefaultIcon = toneIcon[tone];
  const iconNode = icon === false ? null : (icon ?? <DefaultIcon aria-hidden="true" />);
  return (
    <div className={cx("callout", `callout-${tone}`, icon === false && "callout-plain", className)} data-tone={tone} {...props}>
      {iconNode}
      <div className="callout-content">
        {title && <p className="callout-title">{title}</p>}
        {children && <div className="callout-body">{children}</div>}
        {action && <div className="callout-actions">{action}</div>}
      </div>
    </div>
  );
}
