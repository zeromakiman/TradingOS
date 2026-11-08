import Decimal from "decimal.js";
import { formatAgainst, formatDecimal, formatMoneyUp, formatPrice, formatQuantity, formatR, stripZeros } from "./format";
import type { LedgerTrade } from "./ledger";

/**
 * Plan vs reality for a trade page (spec §8.5). Planned trades compare the locked plan with the
 * recorded execution; live-first and imported trades have no planned column: nothing is
 * fabricated. All comparisons are exact; display rounding agrees with each verdict.
 */

const D = Decimal.clone({ precision: 60 });
const Floor = D.clone({ rounding: Decimal.ROUND_FLOOR });
const Ceil = D.clone({ rounding: Decimal.ROUND_CEIL });

/**
 * `numerator ÷ denominator` for display next to a verdict that was decided by cross-multiplication
 * against a maximum: rounded down when the verdict passes and up when it fails, so the displayed
 * value can always agree with the verdict.
 */
function quotientBeside(passes: boolean, numerator: Decimal.Value, denominator: Decimal.Value): Decimal {
  return new (passes ? Floor : Ceil)(numerator).div(denominator);
}

export const NO_PLAN_RECORDED = "No pre-trade plan recorded";
const MODEL_LABELS: Record<string, string> = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE", OTHER: "Other" };

export type PlanVsRealityTrade = Pick<LedgerTrade,
  | "origin" | "currency" | "direction" | "entry_model" | "planned_entry" | "planned_stop" | "planned_target" | "planned_quantity"
  | "planned_risk" | "planned_rr" | "entry_price" | "quantity" | "initial_stop" | "initial_risk" | "actual_initial_risk"
  | "exit_price" | "net_pnl" | "realized_r">;

export interface PlanInstrument {
  tickSize: string;
  pipSize: string | null;
  quantityStep?: string | null;
  quantityUnit?: string | null;
}

export interface Slippage {
  /** Actual minus planned entry, in ticks (signed by price direction). */
  ticks: string;
  /** Same in pips; null without a pip size. */
  pips: string | null;
  /** ADVERSE: a long filled higher or a short filled lower than planned. */
  effect: "ADVERSE" | "FAVORABLE" | "NONE";
  label: string;
}

export interface SizeComparison {
  planned: string;
  actual: string;
  /** Display ratio actual ÷ planned, e.g. `4.00`. */
  ratio: string;
  oversized: boolean;
  label: string;
}

export type PlanRealityKey = "ENTRY" | "STOP" | "SIZE" | "RISK" | "TARGET" | "RR" | "MODEL";

export interface PlanRealityRow {
  key: PlanRealityKey;
  label: string;
  planned: string | null;
  actual: string | null;
  note: string | null;
  flag: "OVERSIZED" | null;
}

export interface PlanVsRealityOptions {
  /** Recorded equity of the plan, to express risk at stop as a percent of the account. */
  equity?: string | null;
  /** Maximum risk % of the plan's risk version, to compare risk at stop against. */
  maxRiskPercent?: string | null;
  /** Minimum RR of the plan's risk version; planned RR is then shown against it. */
  minRR?: string | null;
}

export type PlanVsReality =
  | { kind: "NO_PLAN"; message: string; rows: PlanRealityRow[] }
  | {
    kind: "PLANNED";
    rows: PlanRealityRow[];
    slippage: Slippage | null;
    size: SizeComparison | null;
    plannedRisk: string | null;
    /** Risk at the planned stop for the actual fill and size (money). */
    actualRisk: string | null;
    /** Display percent of equity for the actual risk, when equity is known (e.g. `2.00`). */
    riskAtStopPercent: string | null;
    realizedR: string | null;
    /** Net P&L ÷ actual risk at stop; differs from realized R when the size or fill deviates. */
    realizedRActualRisk: string | null;
  };

/**
 * Money at risk at the stop, rounded up to the cent so it is never understated (§6.6): the plan preview, the plan's
 * "Risk at stop" and the lock confirmation state the same amount the same way.
 */
function money(value: string | null, currency: string): string | null {
  return value === null ? null : formatMoneyUp(value, currency);
}

function signed(value: Decimal, text: string): string {
  return value.gt(0) ? `+${text}` : text;
}

/** Signed entry slippage in ticks and pips. */
export function entrySlippage(direction: "LONG" | "SHORT", plannedEntry: string, actualEntry: string, instrument: PlanInstrument): Slippage {
  const difference = new D(actualEntry).minus(plannedEntry);
  const ticks = difference.div(instrument.tickSize).toDecimalPlaces(4);
  const pips = instrument.pipSize === null ? null : difference.div(instrument.pipSize).toDecimalPlaces(4);
  const adverse = direction === "LONG" ? difference.gt(0) : difference.lt(0);
  const effect = difference.isZero() ? "NONE" : adverse ? "ADVERSE" : "FAVORABLE";
  const tickText = `${signed(ticks, ticks.toFixed())} ${ticks.abs().eq(1) ? "tick" : "ticks"}`;
  const pipText = pips === null ? "" : ` · ${signed(pips, formatDecimal(pips, 1))} ${pips.abs().eq(1) ? "pip" : "pips"}`;
  const label = effect === "NONE" ? "At the planned entry" : `${tickText}${pipText} (${effect === "ADVERSE" ? "worse" : "better"} than plan)`;
  return { ticks: ticks.toFixed(), pips: pips?.toFixed() ?? null, effect, label };
}

/** Actual vs planned size; the ratio display never reads `1.00×` for an oversized fill. */
export function sizeComparison(plannedQuantity: string, actualQuantity: string, quantityStep?: string | null, quantityUnit?: string | null): SizeComparison {
  const oversized = new D(actualQuantity).gt(plannedQuantity);
  const ratio = quotientBeside(!oversized, actualQuantity, plannedQuantity);
  const ratioText = formatAgainst(ratio, "1", "max", !oversized);
  const unit = quantityUnit?.trim() ? ` ${quantityUnit.trim().split(" (")[0]}` : "";
  const planned = formatQuantity(plannedQuantity, quantityStep);
  const actual = formatQuantity(actualQuantity, quantityStep);
  return { planned, actual, ratio: ratioText, oversized, label: `${actual} vs ${planned}${unit} (${ratioText}×)` };
}

/** Entry-form confirmation copy when the actual size exceeds the plan; null otherwise. */
export function sizeDeviationWarning(actualQuantity: string, plannedQuantity: string, quantityStep?: string | null): string | null {
  const size = sizeComparison(plannedQuantity, actualQuantity, quantityStep);
  if (!size.oversized) return null;
  return `Actual size ${size.actual} exceeds the plan's ${size.planned} (${size.ratio}×). This will be recorded as a size deviation.`;
}

function modelLabel(model: string | null): string | null {
  return model === null ? null : MODEL_LABELS[model] ?? model;
}

/** Planned RR never rounds up across a minimum: against the minimum when known, else truncated to 2 dp. */
function plannedRrText(plannedRr: string | null, minRR: string | null | undefined): string | null {
  if (plannedRr === null) return null;
  if (minRR) return `${formatAgainst(plannedRr, minRR, "min", new D(plannedRr).gte(minRR))}R`;
  return `${formatDecimal(new D(plannedRr).toDecimalPlaces(2, D.ROUND_DOWN))}R`;
}

function riskAtStopPercent(actualRisk: string | null, options: PlanVsRealityOptions): string | null {
  if (actualRisk === null || !options.equity || new D(options.equity).lte(0)) return null;
  const scaledRisk = new D(actualRisk).mul(100);
  if (!options.maxRiskPercent) return formatDecimal(scaledRisk.div(options.equity).toDecimalPlaces(2, D.ROUND_UP));
  // Never a compared quotient: risk × 100 ≤ maximum % × equity decides; the percent is display only.
  const passes = scaledRisk.lte(new D(options.maxRiskPercent).mul(options.equity));
  return formatAgainst(quotientBeside(passes, scaledRisk, options.equity), options.maxRiskPercent, "max", passes);
}

export function planVsReality(trade: PlanVsRealityTrade, instrument: PlanInstrument | null, options: PlanVsRealityOptions = {}): PlanVsReality {
  const tick = instrument?.tickSize ?? null;
  const step = instrument?.quantityStep ?? null;
  const price = (value: string | null) => (value === null ? null : formatPrice(value, tick));
  const quantity = (value: string | null) => (value === null ? null : formatQuantity(value, step));
  const realized = trade.realized_r === null ? null : formatR(trade.realized_r);

  if (trade.origin !== "PLANNED" || trade.planned_entry === null) {
    const row = (key: PlanRealityKey, label: string, actual: string | null): PlanRealityRow => ({ key, label, planned: null, actual, note: null, flag: null });
    return {
      kind: "NO_PLAN",
      message: NO_PLAN_RECORDED,
      rows: [
        row("ENTRY", "Entry", price(trade.entry_price)),
        row("STOP", "Stop", price(trade.initial_stop)),
        row("SIZE", "Size", quantity(trade.quantity)),
        row("RISK", "Risk at stop", money(trade.initial_risk, trade.currency)),
        row("TARGET", "Exit", price(trade.exit_price)),
        row("RR", "Realized R", realized),
        row("MODEL", "Model", modelLabel(trade.entry_model)),
      ],
    };
  }

  const slippage = instrument && trade.direction && trade.entry_price !== null ? entrySlippage(trade.direction, trade.planned_entry, trade.entry_price, instrument) : null;
  const size = trade.planned_quantity !== null && trade.quantity !== null ? sizeComparison(trade.planned_quantity, trade.quantity, step, instrument?.quantityUnit) : null;
  const actualRisk = trade.actual_initial_risk;
  const riskPercent = riskAtStopPercent(actualRisk, options);
  const realizedRActualRisk = trade.net_pnl !== null && actualRisk !== null && new D(actualRisk).gt(0) ? stripZeros(new D(trade.net_pnl).div(actualRisk).toDecimalPlaces(20)) : null;
  const executed = trade.entry_price !== null;
  return {
    kind: "PLANNED",
    rows: [
      { key: "ENTRY", label: "Entry", planned: price(trade.planned_entry), actual: price(trade.entry_price), note: slippage?.label ?? null, flag: null },
      { key: "STOP", label: "Stop", planned: price(trade.planned_stop), actual: executed ? price(trade.planned_stop) : null, note: "The locked stop stays the R basis.", flag: null },
      { key: "SIZE", label: "Size", planned: quantity(trade.planned_quantity), actual: quantity(trade.quantity), note: size ? `${size.ratio}× of plan` : null, flag: size?.oversized ? "OVERSIZED" : null },
      { key: "RISK", label: "Risk", planned: money(trade.planned_risk, trade.currency), actual: money(actualRisk, trade.currency), note: riskPercent ? `Risk at stop ${riskPercent}% of equity` : null, flag: null },
      { key: "TARGET", label: "Target → exit", planned: price(trade.planned_target), actual: price(trade.exit_price), note: null, flag: null },
      { key: "RR", label: "Planned RR → realized R", planned: plannedRrText(trade.planned_rr, options.minRR), actual: realized, note: null, flag: null },
      { key: "MODEL", label: "Model", planned: modelLabel(trade.entry_model), actual: executed ? modelLabel(trade.entry_model) : null, note: null, flag: null },
    ],
    slippage,
    size,
    plannedRisk: trade.planned_risk,
    actualRisk,
    riskAtStopPercent: riskPercent,
    realizedR: trade.realized_r,
    realizedRActualRisk,
  };
}
