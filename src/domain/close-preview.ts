import Decimal from "decimal.js";

/**
 * What a close will record, worked out before it is recorded (docs/V2_ARCHITECTURE.md §3.4–3.5), so the close
 * confirmation can show the result first: the database computes exactly these values from the same inputs.
 * - Planned trades, FULL_CLOSE_V1 (`close_journal_trade`): gross = (exit − entry) × direction ÷ tick size × tick value ×
 *   size; net = gross − fees; realized R = net ÷ the locked risk.
 * - Live-first and imported trades, UNPLANNED_CLOSE_V1 (`close_live_trade`): the same gross when the contract, entry,
 *   size and exit are known; otherwise the net P&L the trader reports. Realized R = net ÷ the risk basis (the reported
 *   risk amount, else the risk at the initial stop); none without one.
 * The outcome follows the sign of net, as stored. Exact decimals only (Decimal.js, never floating point). A value that
 * is not a decimal gives no preview rather than a wrong one. Pure: safe on server and client.
 */

const D = Decimal.clone({ precision: 60 });
const DECIMAL = /^-?\d+(\.\d+)?$/;

export interface ClosePosition {
  direction: "LONG" | "SHORT";
  entryPrice: string;
  quantity: string;
  tickSize: string;
  tickValue: string;
}

export type CloseOutcome = "WIN" | "LOSS" | "BREAKEVEN";

export interface ClosePreview {
  /** Null when the trader reports the net P&L. */
  grossPnl: string | null;
  netPnl: string;
  /** Exact quotient; null without a risk basis. */
  realizedR: string | null;
  outcome: CloseOutcome;
}

function decimal(value: string | null | undefined): Decimal | null {
  const text = value?.trim() ?? "";
  return DECIMAL.test(text) ? new D(text) : null;
}

function outcomeOf(net: Decimal): CloseOutcome {
  return net.gt(0) ? "WIN" : net.lt(0) ? "LOSS" : "BREAKEVEN";
}

function realizedR(net: Decimal, riskBasis: string | null): string | null {
  const basis = decimal(riskBasis);
  return basis?.gt(0) ? net.div(basis).toFixed() : null;
}

/** A close whose P&L is calculated from the exit price (planned trades, and live-first trades with every fact). */
export function calculatedClose(position: ClosePosition, exit: string, fees: string, riskBasis: string | null): ClosePreview | null {
  const [price, entry, quantity, tick, tickValue, cost] = [exit, position.entryPrice, position.quantity, position.tickSize, position.tickValue, fees || "0"].map(decimal);
  if (!price || !entry || !quantity || !tick || !tickValue || !cost || tick.lte(0)) return null;
  const gross = price.minus(entry).times(position.direction === "LONG" ? 1 : -1).div(tick).times(tickValue).times(quantity);
  const net = gross.minus(cost);
  return { grossPnl: gross.toFixed(), netPnl: net.toFixed(), realizedR: realizedR(net, riskBasis), outcome: outcomeOf(net) };
}

/** A live-first close with the net P&L the trader reports (signed money). */
export function reportedClose(netPnl: string, riskBasis: string | null): ClosePreview | null {
  const net = decimal(netPnl);
  if (!net) return null;
  return { grossPnl: null, netPnl: net.toFixed(), realizedR: realizedR(net, riskBasis), outcome: outcomeOf(net) };
}
