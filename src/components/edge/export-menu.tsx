"use client";

import { ChevronDown, Download } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type ExportMenuLink = { label: string; detail: string; href: string };

/** The action names what the file holds. */
export const EXPORT_LABEL = "Export closed trades (CSV)";

/** What the CSV contains, shown in the menu before any download. */
export const EXPORT_NOTE = "The closed trades on this page (planned, live-first and imported), with its filters. Money stays in each account's currency, never converted.";

export type ExportMenuProps = {
  /** The file of the page's scope first; in All Accounts, then one file per account. */
  links: ExportMenuLink[];
  /**
   * Set when no complete file can be offered (more closed trades match than one export reads): why, and what to do.
   * The action is then shown unavailable with this note instead of the links.
   */
  unavailable?: string;
};

/**
 * CSV export (`/edge/export`, §1.2). A menu in every context, so what the file contains is read before downloading
 * (touch screens have no hover tooltip; screen readers hear the note as the menu's description). The items are plain
 * links (file downloads, never client navigation). A download that the server refuses would fail silently, so a file
 * that cannot be served is never offered: the disabled action says why in visible words linked to it.
 */
export function ExportMenu({ links, unavailable }: ExportMenuProps) {
  const noteId = useId();
  if (unavailable) {
    return (
      <div className="flex max-w-[20rem] flex-col items-start gap-1.5 md:items-end">
        <Button variant="secondary" disabled aria-describedby={noteId} icon={<Download aria-hidden="true" />}>
          {EXPORT_LABEL}
        </Button>
        <p id={noteId} className="t-caption md:text-right">
          {unavailable}
        </p>
      </div>
    );
  }
  if (links.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" icon={<Download aria-hidden="true" />} iconEnd={<ChevronDown aria-hidden="true" />}>
          {EXPORT_LABEL}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[20rem]" aria-describedby={noteId}>
        <DropdownMenuLabel id={noteId} className="whitespace-normal">{EXPORT_NOTE}</DropdownMenuLabel>
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
