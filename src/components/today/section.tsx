import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import type { ValueText, ValueTone } from "./types";

/** Layout pieces shared by Today's sections (server components). */

export function TodaySection({
  id, title, count, description, aside, children, className,
}: {
  /** Id of the heading (`aria-labelledby` of the section). */
  id: string;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  /** Right side of the header: a summary or a link. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-0.5">
        <div className="min-w-0">
          <h2 id={id} className="flex items-center gap-2 text-base font-semibold text-1">
            {title}
            {count !== undefined && (
              <>
                {" "}
                <CountBadge count={count} />
              </>
            )}
          </h2>
          {description && <p className="t-meta">{description}</p>}
        </div>
        {aside && <div className="t-meta flex flex-wrap items-center gap-x-3 gap-y-1">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** A section's empty state in one line: what will appear here and when. */
export function InlineEmpty({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="card flex items-start gap-3 px-4 py-3 md:px-5">
      <span aria-hidden="true" className="grid size-8 flex-none place-items-center rounded-pill bg-surface-sunken text-3 [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium text-1">{title}</p>
        <p className="t-meta">{description}</p>
      </div>
    </div>
  );
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex min-w-6 items-center justify-center rounded-pill border border-border bg-surface-sunken px-1.5 text-xs leading-5 font-semibold text-2 num">
      {count}
    </span>
  );
}

export const VALUE_TONE_CLASS: Readonly<Record<ValueTone, string>> = {
  pos: "text-pos",
  neg: "text-neg",
  neutral: "text-1",
  muted: "text-3",
};

/** A formatted value in its semantic colour (the sign or the words already carry the meaning). */
export function Value({ value, className }: { value: ValueText; className?: string }) {
  return <span className={cx("num", VALUE_TONE_CLASS[value.tone], className)}>{value.text}</span>;
}
