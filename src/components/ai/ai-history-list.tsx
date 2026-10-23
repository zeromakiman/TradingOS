import { CircleAlert, CircleCheck, Hourglass } from "lucide-react";
import { formatDay, formatTime, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import type { AiHistoryRow, AiHistoryStatus, RevisionMarker } from "@/lib/ai-history";
import { cx } from "../ui/cx";
import { Disclosure } from "../ui/disclosure";
import { EmptyState } from "../ui/empty-state";
import { TechnicalDetails } from "../ui/technical-details";
import { dataToken, failureAccountingText, withKeys } from "./model";
import { AiTechnicalFields } from "./technical";

/**
 * Compact AI history (docs/V2_ARCHITECTURE.md §11.1): `Analyze Setup · Completed · 08:00` with the top finding;
 * failed rows give the reason and the accounting outcome in plain words. Codes, versions, provider, accounting and
 * ids sit in a collapsed Technical details element per row, which is part of the server HTML even while closed.
 */

/** A history row from src/lib/ai-history.ts; pre-trade rows carry `revision`, periodic rows `scopeLabel`. */
export type AiHistoryListRow = AiHistoryRow & { revision?: RevisionMarker; scopeLabel?: string };

export interface AiHistoryListProps {
  /** Newest first, as the ai-history loaders return them. */
  rows: readonly AiHistoryListRow[];
  /** Opens every Technical details element by default; defaults to the shell's developer-mode context. */
  developerMode?: boolean;
  timeDisplay?: TimeDisplay;
  /** Rows shown directly; older rows move into a "Show n earlier" disclosure. All rows by default. */
  limit?: number;
  /** Accessible name of the list. */
  label?: string;
  /** Empty-state title; nothing is rendered for an empty list when null. */
  emptyText?: string | null;
}

const STATUS_ICONS: Readonly<Record<AiHistoryStatus, { icon: typeof CircleCheck; className: string }>> = {
  COMPLETED: { icon: CircleCheck, className: "text-pos" },
  FAILED: { icon: CircleAlert, className: "text-warn" },
  IN_PROGRESS: { icon: Hourglass, className: "text-accent" },
};

function rowTime(row: AiHistoryListRow, display: TimeDisplay): { label: string; day: string | null; at: string } {
  const at = row.completedAt ?? row.requestedAt;
  try {
    return { label: `${row.operationLabel} · ${row.statusLabel} · ${formatTime(at, display)}`, day: formatDay(at, display), at };
  } catch {
    return { label: row.label, day: null, at };
  }
}

function contextText(row: AiHistoryListRow): string | null {
  if (row.revision) return row.revision.staleLabel ?? `Draft revision ${row.revision.number}`;
  return row.scopeLabel ?? null;
}

const TECHNICAL_ROW = "border-0 bg-transparent [&>summary]:min-h-10 [&>summary]:px-0 [&>summary]:text-xs [&>div]:px-0";

function HistoryRow({ row, developerMode, display }: { row: AiHistoryListRow; developerMode?: boolean; display: TimeDisplay }) {
  const { label, day, at } = rowTime(row, display);
  const context = contextText(row);
  const status = STATUS_ICONS[row.status];
  const Icon = status.icon;
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0" data-status={dataToken(row.status)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Icon aria-hidden="true" className={cx("size-4 flex-none", status.className)} />
        <span className="font-medium text-text">{label}</span>
        {(day || context) && (
          <span className="t-caption">
            {day && <time dateTime={at}>{day}</time>}
            {day && context && " · "}
            {context}
          </span>
        )}
      </p>
      {row.status === "COMPLETED" && row.headline && <p className="t-meta pl-6">{row.headline}</p>}
      {row.status === "FAILED" && (
        <div className="flex flex-col gap-0.5 pl-6">
          {row.failureReason && <p className="t-meta">{row.failureReason}</p>}
          <p className="t-caption">{failureAccountingText(row.technical)}</p>
        </div>
      )}
      {row.status === "IN_PROGRESS" && <p className="t-meta pl-6">Still running. Refresh to see the result.</p>}
      <TechnicalDetails developerMode={developerMode} className={cx("pl-6", TECHNICAL_ROW)}>
        <AiTechnicalFields technical={row.technical} status={row.status} />
      </TechnicalDetails>
    </li>
  );
}

export function AiHistoryList({ rows, developerMode, timeDisplay = STRATEGY_TIME, limit, label = "AI history", emptyText = "No AI history yet." }: AiHistoryListProps) {
  if (rows.length === 0) {
    return emptyText === null ? null : (
      <EmptyState compact title={emptyText} description="Each request you make is saved here, including attempts that did not complete." />
    );
  }
  const keyed = withKeys(rows, row => row.technical.requestId);
  const shown = limit === undefined || limit >= rows.length ? keyed : keyed.slice(0, Math.max(1, limit));
  const earlier = keyed.slice(shown.length);
  const list = (items: typeof keyed, name: string) => (
    <ol aria-label={name} className="flex flex-col">
      {items.map(({ key, value }) => (
        <HistoryRow key={key} row={value} developerMode={developerMode} display={timeDisplay} />
      ))}
    </ol>
  );
  return (
    <div className="flex flex-col gap-2">
      {list(shown, label)}
      {earlier.length > 0 && (
        <Disclosure summary={`Show ${earlier.length} earlier`} className="border-0 bg-transparent [&>summary]:px-0 [&>div]:px-0">
          {list(earlier, `${label}, earlier`)}
        </Disclosure>
      )}
    </div>
  );
}
