import Decimal from "decimal.js";
import type { ReactNode } from "react";
import { formatMoneyExact } from "@/domain/format";
import type { AiHistoryTechnical } from "@/lib/ai-history";
import { type SourceChipModel, withKeys } from "./model";

/**
 * Technical fields of an AI request (docs/V2_ARCHITECTURE.md §13.9): ids, versions, provider and model, accounting
 * and token usage. Rendered only inside a collapsed Technical details disclosure, never in default UI.
 */

function micros(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value)) return null;
  return `${value} µ€ (${formatMoneyExact(new Decimal(value).div(1_000_000).toFixed(), "EUR")})`;
}

function count(value: number | null): string | null {
  return value === null ? null : String(value);
}

function FieldList({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {withKeys(rows, ([label]) => label).map(({ key, value: [label, value] }) => (
        <div key={key} className="contents">
          <dt className="text-3">{label}</dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Request fields of one history row; `status` is the stored request status (`COMPLETED`, `FAILED`, `IN_PROGRESS`). */
export function AiTechnicalFields({ technical, status }: { technical: AiHistoryTechnical; status: string }) {
  const rows: [string, string | null][] = [
    ["Status", status],
    ["Request id", technical.requestId],
    ["Operation", technical.operation],
    ["Operation version", technical.operationVersion],
    ["Contract version", technical.contract],
    ["Provider", technical.provider],
    ["Model", technical.model],
    ["Error code", technical.errorCode],
    ["Reservation id", technical.reservationId],
    ["Reserved", micros(technical.reservedMicros)],
    ["Charged (estimate)", micros(technical.chargedMicros)],
    ["Usage disposition", technical.disposition],
    ["Input tokens", count(technical.inputTokens)],
    ["Output tokens", count(technical.outputTokens)],
    ["Response id", technical.responseId],
  ];
  return <FieldList rows={rows.filter((row): row is [string, string] => row[1] !== null)} />;
}

/** Friendly citation label → canonical citation id. */
export function CitationIds({ citations }: { citations: readonly SourceChipModel[] }) {
  const rows = citations.filter(chip => chip.technicalId).map(chip => [chip.label, chip.technicalId ?? ""] as const);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-semibold">Citations</p>
      <FieldList rows={rows} />
    </div>
  );
}
