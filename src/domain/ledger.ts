import { z } from "zod";
import { isCalendarDay, isInstant } from "./time-display";

/**
 * Row contract of the `public.trade_ledger` view (spec §3.12): one row per trade, numeric
 * columns as exact text (`trim_scale`), never JavaScript numbers. Live-first and imported
 * trades carry null `planned_*` values: nothing is fabricated. Select exactly
 * `LEDGER_COLUMNS` so the strict schema can detect drift between the view and this contract.
 */

export const LEDGER_COLUMNS = [
  "id", "account_id", "origin", "created_at", "duplicated_from", "migrated_from", "currency",
  "revision_count", "latest_revision", "latest_proposal_id", "latest_revision_at", "latest_check_decision", "latest_check_at", "latest_check_evaluation_id",
  "plan_id", "locked_at", "plan_trading_day", "strategy_version_id", "strategy_version", "risk_plan_version_id", "risk_plan_version",
  "symbol", "instrument_version_id", "direction", "entry_model",
  "planned_entry", "planned_stop", "planned_target", "requested_risk_percent", "planned_rr", "planned_quantity", "planned_risk",
  "entry_price", "entered_at", "entry_time_known", "entry_recorded_at", "quantity", "initial_stop", "initial_risk", "actual_initial_risk", "oversize",
  "exit_price", "exited_at", "close_recorded_at", "fees", "gross_pnl", "net_pnl", "realized_r", "outcome", "calculation_version", "pnl_source",
  "disposition", "disposition_reason", "legacy_decision", "discarded_at",
  "lifecycle", "draft_check", "review_completed_at",
  "setup_grade", "liquidity_context", "mss_timeframe", "tags", "tag_source",
  "evidence_count", "cover_evidence_id", "cover_evidence_kind", "journal_count", "ai_review_count",
] as const;
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];

export const TRADE_ORIGINS = ["PLANNED", "LIVE_FIRST", "IMPORTED"] as const;
export type TradeOrigin = (typeof TRADE_ORIGINS)[number];
export const LIFECYCLES = ["DRAFT", "LOCKED", "LIVE", "CLOSED", "REVIEWED", "SKIPPED", "CANCELLED", "DISCARDED"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const DRAFT_CHECKS = ["UNCHECKED", "BLOCKED", "APPROVED"] as const;
export type DraftCheck = (typeof DRAFT_CHECKS)[number];
export const ENTRY_MODELS = ["OB_FIRST_TOUCH", "OTE", "OTHER"] as const;
export type EntryModel = (typeof ENTRY_MODELS)[number];
export const SETUP_GRADES = ["A+", "A", "B", "C", "INVALID"] as const;
export const LIQUIDITY_CONTEXTS = ["ARL_HIGH", "ARL_LOW", "PDH", "PDL", "PWH", "PWL", "KZ_HIGH", "KZ_LOW", "EQUAL_HIGHS", "EQUAL_LOWS", "OTHER"] as const;
export const MSS_TIMEFRAMES = ["M15", "M5", "M3"] as const;

const numericText = z.string().regex(/^-?\d+(\.\d+)?$/, "Expected exact decimal text.");
const instant = z.string().refine(isInstant, "Expected a timestamp with an explicit timezone.");
const calendarDay = z.string().refine(isCalendarDay, "Expected a YYYY-MM-DD day.");
const count = z.number().int().nonnegative();

export const ledgerRow = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  origin: z.enum(TRADE_ORIGINS),
  created_at: instant,
  duplicated_from: z.uuid().nullable(),
  migrated_from: z.enum(["V1_PLAN", "V1_PROPOSAL"]).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),

  revision_count: count,
  latest_revision: z.number().int().positive().nullable(),
  latest_proposal_id: z.uuid().nullable(),
  latest_revision_at: instant.nullable(),
  latest_check_decision: z.enum(["APPROVED", "BLOCKED"]).nullable(),
  latest_check_at: instant.nullable(),
  latest_check_evaluation_id: z.uuid().nullable(),

  plan_id: z.uuid().nullable(),
  locked_at: instant.nullable(),
  plan_trading_day: calendarDay.nullable(),
  strategy_version_id: z.uuid().nullable(),
  strategy_version: z.string().nullable(),
  risk_plan_version_id: z.uuid().nullable(),
  risk_plan_version: z.string().nullable(),

  symbol: z.string().min(1).nullable(),
  instrument_version_id: z.uuid().nullable(),
  direction: z.enum(["LONG", "SHORT"]).nullable(),
  entry_model: z.enum(ENTRY_MODELS).nullable(),

  planned_entry: numericText.nullable(),
  planned_stop: numericText.nullable(),
  planned_target: numericText.nullable(),
  requested_risk_percent: numericText.nullable(),
  planned_rr: numericText.nullable(),
  planned_quantity: numericText.nullable(),
  planned_risk: numericText.nullable(),

  entry_price: numericText.nullable(),
  entered_at: instant.nullable(),
  entry_time_known: z.boolean(),
  entry_recorded_at: instant.nullable(),
  quantity: numericText.nullable(),
  initial_stop: numericText.nullable(),
  /** R denominator: plan nominal for planned trades, risk basis for unplanned trades. */
  initial_risk: numericText.nullable(),
  actual_initial_risk: numericText.nullable(),
  oversize: z.boolean().nullable(),

  exit_price: numericText.nullable(),
  exited_at: instant.nullable(),
  close_recorded_at: instant.nullable(),
  fees: numericText.nullable(),
  gross_pnl: numericText.nullable(),
  net_pnl: numericText.nullable(),
  realized_r: numericText.nullable(),
  outcome: z.enum(["WIN", "LOSS", "BREAKEVEN"]).nullable(),
  calculation_version: z.enum(["FULL_CLOSE_V1", "UNPLANNED_CLOSE_V1"]).nullable(),
  pnl_source: z.enum(["CALCULATED", "USER_REPORTED", "IMPORTED"]).nullable(),

  disposition: z.enum(["SKIPPED", "CANCELLED"]).nullable(),
  disposition_reason: z.string().nullable(),
  legacy_decision: z.enum(["TAKEN", "SKIPPED"]).nullable(),
  discarded_at: instant.nullable(),

  lifecycle: z.enum(LIFECYCLES),
  draft_check: z.enum(DRAFT_CHECKS).nullable(),
  review_completed_at: instant.nullable(),

  setup_grade: z.enum(SETUP_GRADES).nullable(),
  liquidity_context: z.enum(LIQUIDITY_CONTEXTS).nullable(),
  mss_timeframe: z.enum(MSS_TIMEFRAMES).nullable(),
  /** Effective tags; a trade without any tag set reads as an empty list. */
  tags: z.array(z.string()).nullable().transform(tags => tags ?? []),
  tag_source: z.enum(["V2", "V1"]).nullable(),

  evidence_count: count,
  cover_evidence_id: z.uuid().nullable(),
  cover_evidence_kind: z.enum(["V2", "LEGACY"]).nullable(),
  journal_count: count,
  ai_review_count: count,
}).strict();

export type LedgerTrade = z.output<typeof ledgerRow>;

export function parseLedgerRows(rows: readonly unknown[]): LedgerTrade[] {
  return rows.map(row => ledgerRow.parse(row));
}
