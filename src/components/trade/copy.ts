/**
 * Words of the trade workspace (docs/V2_ARCHITECTURE.md §2.3, §5.3, §8.5, §14.4, §15). Every backend value the page
 * shows goes through one of these maps, so no enum spelling (`OB_FIRST_TOUCH`, `USER_REPORTED`) reaches default UI.
 * Pure module: safe in server and client components.
 */

export const DIRECTION_LABELS: Readonly<Record<"LONG" | "SHORT", string>> = Object.freeze({ LONG: "Long", SHORT: "Short" });

export const MODEL_LABELS: Readonly<Record<"OB_FIRST_TOUCH" | "OTE" | "OTHER", string>> = Object.freeze({
  OB_FIRST_TOUCH: "OB first touch",
  OTE: "OTE",
  OTHER: "Other model",
});

export const NEWS_LABELS: Readonly<Record<"UNKNOWN" | "CLEAR" | "RESTRICTED", string>> = Object.freeze({
  UNKNOWN: "Not checked",
  CLEAR: "Checked · clear",
  RESTRICTED: "Restricted window",
});

export const OUTCOME_LABELS: Readonly<Record<"WIN" | "LOSS" | "BREAKEVEN", string>> = Object.freeze({ WIN: "Win", LOSS: "Loss", BREAKEVEN: "Breakeven" });

export const PNL_SOURCE_LABELS: Readonly<Record<"CALCULATED" | "USER_REPORTED" | "IMPORTED", string>> = Object.freeze({
  CALCULATED: "Calculated from the recorded prices and size",
  USER_REPORTED: "Reported by you",
  IMPORTED: "Imported from the platform",
});

export const RISK_BASIS_LABELS: Readonly<Record<"USER_REPORTED" | "DERIVED", string>> = Object.freeze({
  USER_REPORTED: "Risk amount you recorded",
  DERIVED: "From the recorded entry, stop and size",
});

export const GRADES = ["A+", "A", "B", "C", "INVALID"] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_LABELS: Readonly<Record<Grade, string>> = Object.freeze({ "A+": "A+", A: "A", B: "B", C: "C", INVALID: "Invalid" });

export const LIQUIDITY_CONTEXTS = ["ARL_HIGH", "ARL_LOW", "PDH", "PDL", "PWH", "PWL", "KZ_HIGH", "KZ_LOW", "EQUAL_HIGHS", "EQUAL_LOWS", "OTHER"] as const;
export type LiquidityContext = (typeof LIQUIDITY_CONTEXTS)[number];
/** Same short words as the timeline's tag summary (src/domain/timeline.ts), with the abbreviations spelled out once. */
export const LIQUIDITY_LABELS: Readonly<Record<LiquidityContext, string>> = Object.freeze({
  ARL_HIGH: "Asian range high",
  ARL_LOW: "Asian range low",
  PDH: "PDH · previous day high",
  PDL: "PDL · previous day low",
  PWH: "PWH · previous week high",
  PWL: "PWL · previous week low",
  KZ_HIGH: "Kill zone high",
  KZ_LOW: "Kill zone low",
  EQUAL_HIGHS: "Equal highs",
  EQUAL_LOWS: "Equal lows",
  OTHER: "Other liquidity",
});

export const MSS_TIMEFRAMES = ["M15", "M5", "M3"] as const;
export type MssTimeframe = (typeof MSS_TIMEFRAMES)[number];

export const TRADE_COPY = Object.freeze({
  exitPriceLabel: "Average exit price (all partials)",
  exitPriceHint: "One price for the whole position. Partial closes stay in the journal.",
  thesisBand: "Before entry",
  noThesis: "No thesis was recorded with this plan.",
  lockedPlanNote: "Locked plans can't be edited. Later changes are recorded in the journal.",
  entryDetailsOnce: "Each missing detail can be added once. Recorded details can't be changed later.",
  connectionLost: "The change didn't reach Trading OS. Nothing was saved. Check your connection and try again.",
  invalid: "Some values need attention. Check the highlighted fields.",
  technicalSummary: "Technical details",
});

export function directionLabel(direction: "LONG" | "SHORT" | null | undefined): string | null {
  return direction ? DIRECTION_LABELS[direction] : null;
}

export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  return Object.hasOwn(MODEL_LABELS, model) ? MODEL_LABELS[model as keyof typeof MODEL_LABELS] : "Other model";
}

export function liquidityLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return Object.hasOwn(LIQUIDITY_LABELS, value) ? LIQUIDITY_LABELS[value as LiquidityContext] : "Other liquidity";
}

export function gradeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return Object.hasOwn(GRADE_LABELS, value) ? GRADE_LABELS[value as Grade] : null;
}

/** The first word of an instrument's quantity unit ("lots" of "lots (100,000 units)"). */
export function unitWord(quantityUnit: string | null | undefined): string {
  const unit = quantityUnit?.trim();
  return unit ? unit.split(" (")[0] : "";
}

export interface SkipDialogCopy {
  title: string;
  description: string;
  confirmLabel: string;
  /** The button that closes the dialog: never "Cancel", which would read like cancelling the plan. */
  cancelLabel: string;
}

/**
 * Words of the skip or cancel confirmation of a locked plan; the title and the confirm button follow the choice.
 * `slotNote` names the trading day whose trade limit the plan keeps counting toward (`skipSlotNote` in model.ts).
 */
export function skipDialogCopy(status: "SKIPPED" | "CANCELLED", slotNote: string): SkipDialogCopy {
  const cancelling = status === "CANCELLED";
  return {
    title: cancelling ? "Cancel this plan?" : "Skip this trade?",
    description: `The locked plan stays in your history with your reason. ${slotNote}`,
    confirmLabel: cancelling ? "Cancel plan" : "Skip trade",
    cancelLabel: "Keep plan",
  };
}
