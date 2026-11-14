import { TradeRowMenu } from "@/components/trade/trade-row-menu";
import { cx } from "@/components/ui/cx";
import { JOURNAL_COLUMNS, TradeRow } from "./trade-row";
import type { TradeGroupView } from "./types";

/**
 * The Journal list: trades grouped by trade date (docs/V2_ARCHITECTURE.md §14.5). How trades are dated is explained
 * once per page, beside the time zone above the list (date-definition.tsx), so the day headers stay plain headings.
 */

function ColumnHeader() {
  return (
    <div aria-hidden="true" className={cx("hidden pr-14 pl-4 pb-1.5 text-xs font-medium text-3 @min-[60rem]:grid @min-[60rem]:gap-x-3", JOURNAL_COLUMNS)}>
      <span className="col-span-2">Trade</span>
      <span>Model</span>
      <span className="text-right">Planned risk</span>
      <span className="text-right">Realized R</span>
      <span className="text-right">P&amp;L</span>
      <span className="pl-3">State</span>
      <span>Tags</span>
      <span className="sr-only">AI review</span>
    </div>
  );
}

function GroupHeader({ group }: { group: TradeGroupView }) {
  const zone = group.zone && <span className="font-normal text-3"> ({group.zone})</span>;
  return (
    <div className="flex items-baseline gap-3 px-1">
      <h3 id={`journal-day-${group.day}`} className="text-sm font-semibold text-1">
        {group.relative ? (
          <>
            {group.relative}
            <span className="font-normal text-2"> · {group.label}</span>
          </>
        ) : (
          group.label
        )}
        {zone}
      </h3>
      <span className="ml-auto text-xs text-3">{group.countLabel}</span>
    </div>
  );
}

export function TradeList({ groups }: { groups: TradeGroupView[] }) {
  return (
    <div className="@container flex flex-col gap-5">
      <ColumnHeader />
      {groups.map(group => (
        <section key={group.day} aria-labelledby={`journal-day-${group.day}`} className="flex flex-col gap-2">
          <GroupHeader group={group} />
          <ol className="card divide-y divide-border overflow-hidden">
            {group.rows.map(row => (
              <li key={row.key} className="flex items-stretch">
                <div className="min-w-0 flex-1">
                  <TradeRow row={row} />
                </div>
                {/* Open and Delete trade (0020); the row itself links to the trade. */}
                <div className="flex w-10 flex-none items-start justify-center pt-2 pr-1 @min-[60rem]:items-center @min-[60rem]:pt-0">
                  <TradeRowMenu tradeId={row.tradeId} href={row.href} label={[row.symbol, row.direction].filter(Boolean).join(" · ")} open={row.open} />
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
