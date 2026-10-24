import { Disclosure } from "@/components/ui/disclosure";
import { TechnicalDetails } from "@/components/ui/technical-details";
import type { TradeDetail } from "@/lib/trades-data";
import { TRADE_TARGETS } from "./reveal";

/**
 * Technical details of the trade (docs/V2_ARCHITECTURE.md §0.9, §13.9): ids, versions, lifecycle facts, evidence
 * hashes and storage paths, and the raw stored risk reports and ledger row. Collapsed at the bottom of the page and
 * opened by Developer mode; nothing here is needed to complete a workflow. Server component.
 */

/** Stored checks shown in full; older ones are listed by id only. */
const REPORT_LIMIT = 10;

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "Not serializable";
  }
}

function Pre({ value }: { value: unknown }) {
  return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-sunken p-3">{json(value)}</pre>;
}

export function TechnicalSection({ detail, developerMode }: { detail: TradeDetail; developerMode: boolean }) {
  const technical = detail.technical;
  const ledger = technical.ledger;
  const ids: [string, string | null][] = [
    ["trade", technical.tradeId],
    ["account", technical.accountId],
    ["origin", technical.origin],
    ["lifecycle", ledger.lifecycle],
    ["draft check", ledger.draft_check],
    ["plan", technical.planId],
    ["latest proposal", technical.latestProposalId],
    ["proposals", technical.proposalIds.join(", ") || null],
    ["latest check evaluation", technical.latestCheckEvaluationId],
    ["strategy version", [ledger.strategy_version, technical.strategyVersionId].filter(Boolean).join(" · ") || null],
    ["risk plan version", [ledger.risk_plan_version, technical.riskPlanVersionId].filter(Boolean).join(" · ") || null],
    ["instrument version", technical.instrumentVersionId],
    ["calculation version", ledger.calculation_version],
    ["pnl source", ledger.pnl_source],
    ["duplicated from", technical.duplicatedFrom],
    ["migrated from", technical.migratedFrom],
    ["legacy decision", ledger.legacy_decision],
  ];
  const checks = technical.checks.slice(-REPORT_LIMIT).reverse();
  const older = technical.checks.length - checks.length;
  return (
    <section id={TRADE_TARGETS.technical} aria-label="Technical details of this trade" className="scroll-mt-20">
      <TechnicalDetails developerMode={developerMode}>
        <div className="flex flex-col gap-4 font-mono text-xs">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            {ids.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-text-3">{label}</dt>
                <dd className="break-all text-text">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          {technical.evidence.length > 0 && (
            <Disclosure summary={`Evidence records · ${technical.evidence.length}`}>
              <ul className="flex flex-col gap-1.5">
                {technical.evidence.map(item => (
                  <li key={item.id} className="break-all">
                    {item.kind} {item.id} · sha256 {item.sha256} · {item.storagePath}
                    {item.captureMethod ? ` · ${item.captureMethod}` : ""}
                    {item.storedPhase ? ` · phase ${item.storedPhase}` : ""}
                    {item.stateAtCreation ? ` · state ${item.stateAtCreation}` : ""}
                    {item.copiedFrom ? ` · copied from ${item.copiedFrom}` : ""}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {technical.planReport !== null && (
            <Disclosure summary="Risk report at lock">
              <Pre value={technical.planReport} />
            </Disclosure>
          )}
          {checks.length > 0 && (
            <Disclosure summary={`Stored risk checks · ${technical.checks.length}`}>
              <div className="flex flex-col gap-3">
                {checks.map(check => (
                  <div key={check.evaluationId} className="flex flex-col gap-1">
                    <p className="break-all">
                      {check.evaluationId} · {check.recordedAt}
                    </p>
                    <Pre value={check.report} />
                  </div>
                ))}
                {older > 0 && <p>{older} older checks are not shown here; they are part of the data export.</p>}
              </div>
            </Disclosure>
          )}
          <Disclosure summary="Ledger row">
            <Pre value={ledger} />
          </Disclosure>
        </div>
      </TechnicalDetails>
    </section>
  );
}
