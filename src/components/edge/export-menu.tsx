"use client";

import { ChevronDown, Download } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PendingLink } from "./pending";

export type ExportMenuLink = { label: string; detail: string; href: string };

/** The action names its scope: the legacy CSV holds planned trades only. */
export const EXPORT_LABEL = "Export planned trades (CSV)";

/** What the legacy CSV contains, shown in the menu before any download. */
export const EXPORT_NOTE = "Closed planned trades with a locked plan, filtered by date range, model, session and instrument. Live-first and imported trades are not included.";

/** Why there is no CSV while the page shows live-first or imported trades only. */
export const EXPORT_BLOCKED_NOTE = "CSV export covers planned trades only.";

export type ExportMenuProps = {
  links: ExportMenuLink[];
  /** Set while an origin filter selects trades the CSV never contains: the page without that filter. */
  blockedClearHref?: string;
};

/**
 * CSV export (`/edge/export`, §1.2). A menu in every context, so what the file contains is read before downloading
 * (touch screens have no hover tooltip); the file covers one trading account, so All Accounts lists every account.
 * The items are plain links (file downloads, never client navigation).
 */
export function ExportMenu({ links, blockedClearHref }: ExportMenuProps) {
  const noteId = useId();
  if (links.length === 0) return null;
  if (blockedClearHref) {
    return (
      <div className="flex max-w-[20rem] flex-col items-start gap-1.5 md:items-end">
        <Button variant="secondary" disabled aria-describedby={noteId} icon={<Download aria-hidden="true" />}>
          {EXPORT_LABEL}
        </Button>
        <p id={noteId} className="t-caption md:text-right">
          <span className="block">{EXPORT_BLOCKED_NOTE}</span>{" "}
          <span className="block">
            {/* A 40px (44px on touch) target that keeps the caption's line height. */}
            <PendingLink
              href={blockedClearHref}
              prefetch={false}
              className="-my-3 inline-flex min-h-10 items-center font-medium text-accent underline-offset-2 hover:underline pointer-coarse:-my-3.5 pointer-coarse:min-h-11"
            >
              Remove the origin filter
            </PendingLink>{" "}
            to export.
          </span>
        </p>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" icon={<Download aria-hidden="true" />} iconEnd={<ChevronDown aria-hidden="true" />}>
          {EXPORT_LABEL}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[20rem]">
        <DropdownMenuLabel className="whitespace-normal">{EXPORT_NOTE}</DropdownMenuLabel>
        {links.map(link => (
          <DropdownMenuItem key={link.href} asChild>
            <a href={link.href} download>
              <span className="min-w-0 flex-1 truncate">{link.label}</span>
              <span className="menu-item-detail">{link.detail}</span>
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
