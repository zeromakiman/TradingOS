"use client";

import { Info } from "lucide-react";
import { useId } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * How the Journal dates and groups trades (docs/V2_ARCHITECTURE.md §14.5), once per page beside the list's time zone.
 * A toggletip rather than a tooltip: it opens on click, tap and Enter alike, focus stays on the button, and the
 * sentence is also the button's description, so screen readers hear it without opening anything. The 16px text line
 * gets a 40px hit area (44px on touch, §13.5) from its `::after` extension.
 */
export function DateDefinition({ definition, note }: { definition: string; note: string | null }) {
  const id = useId();
  return (
    <span className="inline-flex items-center">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-describedby={`date-definition${id}`}
            className="relative inline-flex items-center gap-1 rounded-control font-medium text-2 after:absolute after:-inset-x-1.5 after:-inset-y-3 after:content-[''] hover:text-1 hover:underline hover:underline-offset-2 data-[state=open]:text-accent pointer-coarse:after:-inset-y-3.5"
          >
            <Info aria-hidden="true" className="size-3.5 flex-none" />
            How trades are dated
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 text-sm" aria-label="How trades are dated" onOpenAutoFocus={event => event.preventDefault()}>
          <p className="font-semibold text-1">How trades are dated</p>
          <p className="mt-1 text-2">{definition}</p>
          {note && <p className="mt-2 text-2">{note}</p>}
        </PopoverContent>
      </Popover>
      <span id={`date-definition${id}`} className="sr-only">
        {note ? `${definition} ${note}` : definition}
      </span>
    </span>
  );
}
