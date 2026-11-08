import { TriangleAlert } from "lucide-react";
import { StatusPill } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@/components/ui/table";
import { NO_PLAN_RECORDED, type PlanRealityRow } from "@/domain/plan-vs-reality";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { unitWord } from "./copy";
import { EntryDetailsForm } from "./entry-details-form";
import type { DetailField } from "./form-model";
import { entryDefaults, entryLine, missingEntryFields, type PositionFact, positionFacts, positionRecordedLine, skipSlotNote, whenLabel } from "./model";
import { RecordEntryForm } from "./record-entry-form";
import { TRADE_TARGETS } from "./reveal";
import { SkipTradeButton } from "./review-controls";
import { WorkspaceSection } from "./section";
import type { TradeExtras } from "./workspace-data";

/**
 * Execution section (docs/V2_ARCHITECTURE.md §3.4–3.5, §8.2, §8.5, §14.4). A locked plan shows the record-entry form,
 * prefilled from the plan, and "Skip this trade…". An executed planned trade shows its fill and the Plan vs reality
 * table (slippage in ticks and pips, size ratio with the Oversized flag, risk at the stop, target vs exit, planned RR vs
 * realized R). A live-first or imported position shows what was recorded, "No pre-trade plan recorded" in place of a
 * plan column (nothing is fabricated), and, while live, "Add entry details" for what is still missing. Server component.
 */

export interface ExecutionSectionProps {
  detail: TradeDetail;
  extras: TradeExtras;
  now: string;
  display: TimeDisplay;
  /** Idempotency key of "Add entry details". */
  entryDetailsKey: string;
}

function contractOf(detail: TradeDetail) {
  return { tickSize: detail.instrument?.tickSize ?? null, quantityStep: detail.instrument?.quantityStep ?? null, unit: unitWord(detail.instrument?.quantityUnit) };
}

function RecordEntry({ detail, now, display }: ExecutionSectionProps) {
  const ledger = detail.technical.ledger;
  const contract = contractOf(detail);
  const defaults = entryDefaults(detail);
  return (
    <WorkspaceSection id="execution" title="Execution" meta="Waiting for entry. The fill is recorded against the locked plan.">
      <div id={TRADE_TARGETS.recordEntry} className="scroll-mt-24">
        <RecordEntryForm
          tradeId={detail.tradeId}
          defaults={defaults}
          planned={{ entry: defaults.entry || null, quantity: defaults.quantity || null, quantityExact: ledger.planned_quantity }}
          contract={contract}
          locked={ledger.locked_at ? { at: ledger.locked_at, label: whenLabel(ledger.locked_at, now, display) } : null}
          display={display}
          nowIso={now}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-4">
        <p className="t-meta">Not taking this trade?</p>
        <SkipTradeButton tradeId={detail.tradeId} slotNote={skipSlotNote(detail, now)} />
      </div>
    </WorkspaceSection>
  );
}

function Cell({ value, unit }: { value: string | null; unit?: string }) {
  if (value === null) {
    return (
      <span className="text-text-3">
        —<span className="sr-only">not recorded</span>
      </span>
    );
  }
  return <span className="num">{unit ? `${value} ${unit}` : value}</span>;
}

function RowNote({ row }: { row: PlanRealityRow }) {
  if (!row.note && row.flag !== "OVERSIZED") return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {row.note && <span>{row.note}</span>}
      {row.flag === "OVERSIZED" && (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" className="size-3.5" />}>
          Oversized
        </StatusPill>
      )}
    </span>
  );
}

function rowView(row: PlanRealityRow, unit: string, open: boolean) {
  return {
    sizeUnit: row.key === "SIZE" ? unit || undefined : undefined,
    // Exit and realized R exist once the trade is closed.
    pendingClose: open && row.actual === null && (row.key === "TARGET" || row.key === "RR"),
  };
}

/**
 * Plan vs reality (§8.5) for an executed planned trade: a table where the section is wide enough, and on narrow
 * screens a compact list (planned → actual, the note below) instead of one tall card per row. Values never wrap; each
 * row's note (slippage, size ratio, risk at the stop) sits under its actual value, where it explains the difference.
 */
export function PlanVsRealityTable({ rows, unit, open }: { rows: readonly PlanRealityRow[]; unit: string; open: boolean }) {
  return (
    <div data-plan-vs-reality="">
      <div className="hidden @lg:block">
        <Table caption="Plan vs reality">
          <TableHead>
            <TableRow>
              <TableHeaderCell className="w-px">
                <span className="sr-only">Measure</span>
              </TableHeaderCell>
              <TableHeaderCell className="w-px">Planned</TableHeaderCell>
              <TableHeaderCell>Actual</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(row => {
              const view = rowView(row, unit, open);
              return (
                <TableRow key={row.key} data-row={row.key.toLowerCase()}>
                  <th scope="row" className="ui-table-td whitespace-nowrap text-left align-top font-medium text-text-2">
                    {row.label}
                  </th>
                  <TableCell className="whitespace-nowrap pr-8 align-top">
                    <Cell value={row.planned} unit={view.sizeUnit} />
                  </TableCell>
                  <TableCell className="align-top">
                    <span className="flex flex-col gap-0.5">
                      <span className="whitespace-nowrap">
                        {view.pendingClose ? <span className="text-text-3">After close</span> : <Cell value={row.actual} unit={view.sizeUnit} />}
                      </span>
                      {(row.note || row.flag) && (
                        <span className="t-meta">
                          <RowNote row={row} />
                        </span>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="@lg:hidden">
        <h3 className="mb-1 text-sm font-semibold text-text">Plan vs reality</h3>
        <dl className="flex flex-col divide-y divide-border">
          {rows.map(row => {
            const view = rowView(row, unit, open);
            return (
              <div key={row.key} className="flex flex-col gap-0.5 py-2.5">
                <dt className="t-caption">{row.label}</dt>
                <dd className="flex flex-wrap items-baseline gap-x-2 text-text">
                  <span className="text-text-3">Plan</span>
                  <Cell value={row.planned} unit={view.sizeUnit} />
                  <span aria-hidden="true" className="text-text-3">
                    →
                  </span>
                  <span className="sr-only">, actual</span>
                  {view.pendingClose ? <span className="text-text-3">after close</span> : <Cell value={row.actual} unit={view.sizeUnit} />}
                </dd>
                {(row.note || row.flag) && (
                  <dd className="t-meta">
                    <RowNote row={row} />
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function PlannedExecution({ detail, now, display }: ExecutionSectionProps) {
  const pvr = detail.planVsReality;
  const unit = unitWord(detail.instrument?.quantityUnit);
  return (
    <WorkspaceSection id="execution" title="Execution" meta={<span className="num">{entryLine(detail, now, display)}</span>}>
      {pvr.kind === "PLANNED" ? (
        <PlanVsRealityTable rows={pvr.rows} unit={unit} open={detail.state.lifecycle === "LIVE"} />
      ) : (
        <p className="t-meta">{pvr.message}</p>
      )}
      {pvr.kind === "PLANNED" && pvr.size?.oversized && (
        <p className="t-caption">Realized R stays based on the locked risk, although the size above plan put more money at risk at the stop.</p>
      )}
    </WorkspaceSection>
  );
}

function FactGrid({ facts, label }: { facts: readonly PositionFact[]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-6 gap-y-3 @md:grid-cols-3 @2xl:grid-cols-4">
      {facts.map(fact => (
        <div key={fact.label} className="min-w-0">
          <dt className="t-caption">{fact.label}</dt>
          <dd className={cx("break-words", fact.value === null ? "text-text-3" : "num font-medium text-text")}>{fact.value ?? "Not recorded"}</dd>
          {fact.hint && <dd className="t-caption">{fact.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

function LiveFirstExecution({ detail, extras, now, display, entryDetailsKey }: ExecutionSectionProps) {
  const live = detail.state.lifecycle === "LIVE";
  // A risk amount is only missing while no reported amount, and no stop with entry, size and contract, gives a risk basis.
  const missing: DetailField[] = missingEntryFields(detail);
  // When the position was recorded, and which details were completed later: a later stop or risk amount sets the basis
  // of realized R, so when it was recorded is part of the decision history.
  const recorded = positionRecordedLine(extras.positionRecords, now, display);
  return (
    <WorkspaceSection id="execution" title="Execution" meta={NO_PLAN_RECORDED}>
      <div className="flex flex-col gap-3">
        <FactGrid facts={positionFacts(detail, now, display, extras.positionRecords)} label="Recorded position" />
        {recorded && <p className="t-caption num">{recorded}</p>}
      </div>
      {live && missing.length > 0 && (
        <div id={TRADE_TARGETS.entryDetails} className="scroll-mt-24 rounded-card border border-border bg-surface-sunken p-3 sm:p-4">
          <EntryDetailsForm
            tradeId={detail.tradeId}
            requestKey={entryDetailsKey}
            fields={missing}
            instruments={extras.instruments}
            manageInstrumentsHref={`/accounts/${detail.account.id}/manage?tab=instruments`}
            symbol={detail.symbol}
            contract={contractOf(detail)}
            currency={detail.account.currency}
            recorded={{ at: detail.createdAt, label: whenLabel(detail.createdAt, now, display) }}
            display={display}
          />
        </div>
      )}
      {!live && missing.length > 0 && <p className="t-caption">Entry details can't be added after the close.</p>}
    </WorkspaceSection>
  );
}

export function ExecutionSection(props: ExecutionSectionProps) {
  const { detail } = props;
  const lifecycle = detail.state.lifecycle;
  if (detail.origin !== "PLANNED") return <LiveFirstExecution {...props} />;
  if (lifecycle === "LOCKED") return <RecordEntry {...props} />;
  if (detail.execution) return <PlannedExecution {...props} />;
  return null;
}
