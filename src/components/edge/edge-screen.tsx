import { ChartNoAxesCombined, FilterX, Landmark } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { ENTRY_MODELS, TRADE_ORIGINS } from "@/domain/ledger";
import { MAX_LEDGER_ROWS } from "@/lib/performance-data";
import { SESSIONS } from "@/lib/trades-data";
import { Breakdowns } from "./breakdowns";
import { EdgeDefinitions } from "./definitions";
import type { EdgeData } from "./edge-data";
import { ExportMenu } from "./export-menu";
import { EdgeFilterBar, type FilterSelect } from "./filter-bar";
import { EdgeHeadline } from "./headline";
import {
  breakdownSections, calendarModel, curveData, dailyData, distributionBins, drawdownSampleLabel, exportLinks, exportUnavailable, headlineModel,
  isAllAccounts, MODEL_LABELS, noMatchDescription, ORIGIN_LABELS, periodLabel, resultsJournalLink, rSampleLabel, SESSION_LABELS, scopeLabel,
} from "./model";
import { EDGE_PATH, edgeHref, RANGE_LABELS, RANGE_PRESETS } from "./params";
import { EdgePendingRegion, EdgeTransition, PendingLink } from "./pending";
import { PerformanceCalendar } from "./performance-calendar";
import { accountFilterChip, activeFilterCount, filterQuery, linkFilterChips, unappliedNotice } from "./query";
import { ResultsCharts } from "./results-charts";

/**
 * EDGE (docs/V2_ARCHITECTURE.md §14.6): filter row → headline statistics → results over time → performance calendar
 * → breakdowns with drill-down links → calculation definitions. Server rendered; the filter row, the calendar and
 * the chart toggles are small client islands.
 */

export const EDGE_DESCRIPTION = "Deterministic statistics from your closed trades. Charts, calendar days and groups open the trades behind them.";

/** Phones: the page's sections, one tap away (the page is long in one column). */
const JUMPS = [
  { href: "#edge-results", label: "Results" },
  { href: "#edge-over-time", label: "Over time" },
  { href: "#edge-calendar", label: "Calendar" },
  { href: "#edge-breakdowns", label: "Breakdowns" },
] as const;

function SectionJumps() {
  return (
    <nav aria-label="Sections of this page" className="-mx-4 -mt-2 overflow-x-auto px-4 md:hidden">
      <ul className="flex w-max gap-2">
        {JUMPS.map(jump => (
          <li key={jump.href}>
            <a href={jump.href} className={buttonClasses({ variant: "secondary", size: "sm", className: "pointer-coarse:min-h-11" })}>
              {jump.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function filterSelects(data: EdgeData): FilterSelect[] {
  const { query, instruments } = data;
  return [
    {
      name: "model", label: "Model", value: query.model ?? "",
      options: [{ value: "", label: "All models" }, ...ENTRY_MODELS.map(model => ({ value: model, label: MODEL_LABELS[model] }))],
    },
    {
      name: "session", label: "Entry session", value: query.session ?? "",
      options: [{ value: "", label: "All sessions" }, ...SESSIONS.map(session => ({ value: session, label: SESSION_LABELS[session] }))],
    },
    {
      name: "origin", label: "Origin", value: query.origin ?? "",
      options: [{ value: "", label: "All origins" }, ...TRADE_ORIGINS.map(origin => ({ value: origin, label: ORIGIN_LABELS[origin] }))],
    },
    {
      name: "instrument", label: "Instrument", value: query.instrument ?? "",
      options: [{ value: "", label: "All instruments" }, ...instruments.map(symbol => ({ value: symbol, label: symbol }))],
    },
  ];
}

function Notices({ data }: { data: EdgeData }) {
  // A V1 link's options EDGE does not apply (the last 30 trades, trades without an entry time): said, never dropped silently.
  const unapplied = unappliedNotice(data.query);
  if (!data.query.invalid.length && !data.truncated && !unapplied) return null;
  return (
    <div className="flex flex-col gap-2">
      {data.query.invalid.length > 0 && (
        <Callout tone="warning" role="status">
          Some filters in this link couldn't be read and were ignored.
        </Callout>
      )}
      {unapplied && (
        <Callout tone="warning" role="status">
          {unapplied}
        </Callout>
      )}
      {data.truncated && (
        <Callout tone="warning" title="Results are incomplete">
          Only the first {MAX_LEDGER_ROWS.toLocaleString("en-US")} closed trades are included. Narrow the date range for complete statistics.
        </Callout>
      )}
    </div>
  );
}

export function EdgeScreen({ data }: { data: EdgeData }) {
  const { context, query, view } = data;
  // The page without the origin filter (the origin comparison needs every origin).
  const withoutOrigin = edgeHref({ ...query, origin: undefined, month: undefined });
  const exportMenu = view && view.closedCount > 0 ? <ExportMenu links={exportLinks(data)} unavailable={exportUnavailable(data)} /> : undefined;
  const header = <PageHeader eyebrow={scopeLabel(context, query)} title="EDGE" description={EDGE_DESCRIPTION} actions={exportMenu} />;

  if (!view) {
    return (
      <>
        {header}
        <EmptyState
          icon={<Landmark />}
          headingLevel={2}
          title="Create your first trading account"
          description="EDGE measures the closed trades of your trading accounts. Add an account, then plan or record trades."
          actions={
            <Link href="/accounts/new" className={buttonClasses({ variant: "primary" })}>
              Create trading account
            </Link>
          }
        />
      </>
    );
  }

  const filtered = activeFilterCount(query) > 0;
  const all = isAllAccounts(context);
  const calendar = calendarModel(data, filterQuery(query));
  const filterBar = (
    <EdgeFilterBar
      // Remounts with every new filter state, so the controls always show what the URL says (also after "Reset").
      key={filterQuery(query)}
      state={{
        range: query.range, closedFrom: query.closedFrom, closedTo: query.closedTo, model: query.model, session: query.session, origin: query.origin,
        instrument: query.instrument, weekday: query.weekday, strategyVersionId: query.strategyVersionId, riskPlanVersionId: query.riskPlanVersionId,
        result: query.result, calendar: query.calendar, currency: query.currency,
      }}
      rangeOptions={RANGE_PRESETS.map(preset => ({ value: preset, label: RANGE_LABELS[preset] }))}
      selects={filterSelects(data)}
      accountFilter={accountFilterChip(query, context)}
      linkFilters={linkFilterChips(query, data.versionNames)}
    />
  );

  return (
    <EdgeTransition>
      {header}
      <div className="flex flex-col gap-6">
        {filterBar}
        <EdgePendingRegion className="flex flex-col gap-6">
          <Notices data={data} />
          {view.closedCount === 0 ? (
            filtered ? (
              <EmptyState
                icon={<FilterX />}
                headingLevel={2}
                title="No closed trades match these filters."
                description={noMatchDescription(query, data.now)}
                actions={
                  <PendingLink href={EDGE_PATH} className={buttonClasses({ variant: "secondary" })}>
                    Reset filters
                  </PendingLink>
                }
              />
            ) : (
              <EmptyState
                icon={<ChartNoAxesCombined />}
                headingLevel={2}
                title="No closed trades yet."
                description="Record or plan a trade; results appear here after you close it."
                actions={
                  <>
                    <Link href="/trades/new" className={buttonClasses({ variant: "primary" })}>
                      Plan Trade
                    </Link>
                    <Link href="/trades/live/new" className={buttonClasses({ variant: "secondary" })}>
                      Record Live Trade
                    </Link>
                  </>
                }
              />
            )
          ) : (
            <>
              <SectionJumps />
              <EdgeHeadline id="edge-results" model={headlineModel(view, all)} period={periodLabel(query, data.now)} journal={resultsJournalLink(data)} />
              <section id="edge-over-time" aria-labelledby="edge-over-time-title" className="flex scroll-mt-20 flex-col gap-3">
                <SectionHeader id="edge-over-time-title" title="Results over time" description="Click a point, bar or bin to open the trades behind it." />
                <ResultsCharts
                  curve={curveData(view, data.rows, context)}
                  daily={dailyData(view, data.rows)}
                  bins={distributionBins(view, data.rows)}
                  rSample={rSampleLabel(view, all)}
                  drawdownSample={drawdownSampleLabel(view)}
                  distributionSample={`${view.distribution.count} ${view.distribution.count === 1 ? "trade" : "trades"} with recorded risk · 0.5R bins`}
                />
              </section>
              {calendar && (
                <section id="edge-calendar" aria-label="Performance calendar" className="scroll-mt-20">
                  <Card>
                    <CardBody>
                      <PerformanceCalendar
                        key={`${calendar.month}|${calendar.baseQuery}`}
                        model={calendar}
                        initialMode={query.calendar}
                        initialCurrency={query.currency ?? null}
                        initialDay={query.day ?? null}
                      />
                    </CardBody>
                  </Card>
                </section>
              )}
              <section id="edge-breakdowns" aria-labelledby="edge-breakdowns-title" className="flex scroll-mt-20 flex-col gap-3">
                <SectionHeader
                  id="edge-breakdowns-title"
                  title="Breakdowns"
                  description="Net R by condition. Every group shows its own sample, and no group is called better below 30 trades."
                />
                <Breakdowns
                  sections={breakdownSections(view, data.rows, context, query.origin ? { label: ORIGIN_LABELS[query.origin], clearHref: withoutOrigin } : undefined)}
                />
              </section>
              <EdgeDefinitions rows={data.rows.length} truncated={data.truncated} />
            </>
          )}
        </EdgePendingRegion>
      </div>
    </EdgeTransition>
  );
}
