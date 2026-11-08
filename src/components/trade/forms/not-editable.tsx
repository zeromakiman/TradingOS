import { ChevronLeft, Lock } from "lucide-react";
import Link from "next/link";
import { StatusPill } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { EDIT_TITLE } from "./copy";
import type { NotEditable } from "./types";

/**
 * `/trades/[id]/edit` for a trade that is not an editable draft (docs/V2_ARCHITECTURE.md §2.5): the plan fields of a
 * locked plan, a live-first trade or a discarded draft can't change, and the page says why in plain words instead of
 * showing a form that would be refused.
 */

export const NOT_EDITABLE_TITLE = "This trade can't be edited";

export function NotEditableView({ data }: { data: NotEditable }) {
  const tradeHref = `/trades/${data.tradeId}`;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        eyebrow={
          <Link href={tradeHref} className="inline-flex min-h-10 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
            <ChevronLeft aria-hidden="true" className="size-4" />
            {data.title}
          </Link>
        }
        title={EDIT_TITLE}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusPill tone={data.stateTone}>{data.stateLabel}</StatusPill>
          </span>
        }
      />
      <div className="card">
        <EmptyState
          icon={<Lock />}
          headingLevel={2}
          title={NOT_EDITABLE_TITLE}
          description={data.reason}
          actions={
            <Link href={tradeHref} className={buttonClasses({ variant: "primary" })}>
              Open the trade
            </Link>
          }
        />
      </div>
    </div>
  );
}
