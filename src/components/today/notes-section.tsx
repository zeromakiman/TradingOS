import { ChevronRight, NotebookPen } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { NOTES_ALL_ACCOUNTS_COPY, NOTES_ARCHIVED_COPY, NOTES_TITLE } from "./copy";
import { NotesEditor } from "./notes-editor";
import type { NotesView } from "./types";

/**
 * Today's plan · notes (docs/V2_ARCHITECTURE.md §14.1): the V1 daily context, optional and collapsible. It opens by
 * itself once something is written, so the day's bias and levels stay in view; notes are kept per trading account, so
 * All Accounts links to each account's notes.
 */

export function NotesSection({ notes }: { notes: NotesView }) {
  if (notes.mode === "all") {
    return (
      <section aria-labelledby="today-notes-title" className="card flex flex-col gap-3 p-4 md:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-8 flex-none place-items-center rounded-control bg-surface-sunken text-3 [&_svg]:size-4">
            <NotebookPen aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="today-notes-title" className="text-base font-semibold text-1">
              {NOTES_TITLE}
            </h2>
            <p className="t-meta">{NOTES_ALL_ACCOUNTS_COPY}</p>
          </div>
        </div>
        {/* Account names run up to 100 characters: a chip never gets wider than the card and a long name ends in an
            ellipsis (the whole name stays the link's text, so its accessible name, and its tooltip). */}
        {notes.accounts.length > 0 && (
          <ul className="flex min-w-0 flex-wrap gap-2 sm:pl-11" aria-label="Write today's plan for">
            {notes.accounts.map(account => (
              <li key={account.href} className="max-w-full min-w-0">
                <Link href={account.href} prefetch={false} className={buttonClasses({ variant: "secondary", size: "sm", className: "max-w-full" })}>
                  <span className="truncate" title={account.label}>
                    {account.label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  const written = notes.narrative.trim() !== "";
  return (
    <section aria-labelledby="today-notes-title">
      <details open={written} className="card group">
        {/* Only phrasing and heading content inside <summary>: the grid stacks the title over its status line. */}
        <summary className="grid min-h-14 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 md:px-5 [&::-webkit-details-marker]:hidden">
          <span className="row-span-2 grid size-8 place-items-center rounded-control bg-surface-sunken text-3 [&_svg]:size-4">
            <NotebookPen aria-hidden="true" />
          </span>
          <h2 id="today-notes-title" className="col-start-2 text-base leading-6 font-semibold text-1">
            {NOTES_TITLE}
          </h2>
          <span className="col-start-2 t-meta truncate">{notes.savedLabel ?? "Not written yet: bias, key levels, scenarios and what to avoid."}</span>
          <ChevronRight aria-hidden="true" className="col-start-3 row-span-2 row-start-1 size-4 text-3 transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-border px-4 pt-3 pb-4 md:px-5">
          {notes.archived ? (
            <div className="flex flex-col gap-2">
              <p className="t-meta">{NOTES_ARCHIVED_COPY}</p>
              {written && <p className="text-sm whitespace-pre-wrap text-1">{notes.narrative}</p>}
            </div>
          ) : (
            <NotesEditor accountId={notes.accountId} narrative={notes.narrative} />
          )}
        </div>
      </details>
    </section>
  );
}
