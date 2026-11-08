import Decimal from "decimal.js";

/**
 * Client-side checks of the Accounts forms, mirroring the server actions' input rules (src/app/actions/accounts.ts), so
 * a malformed number gets its field message at once and never reaches the server. The server validates again.
 * Values stay strings; positivity is judged with Decimal, never with floating point.
 */

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const DECIMAL = /^\d{1,12}(\.\d{1,8})?$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;
const WHOLE = /^\d{1,3}$/;

export type FieldRule =
  | { kind: "money"; message: string; optional?: boolean }
  | { kind: "decimal"; message: string; optional?: boolean; max?: string }
  | { kind: "text"; message: string; max: number; optional?: boolean }
  | { kind: "symbol"; message: string }
  | { kind: "whole"; message: string; min: number; max: number };

function positive(value: string): boolean {
  return new Decimal(value).gt(0);
}

function fieldValue(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
}

export function checkField(value: string, rule: FieldRule): boolean {
  if (value === "") return rule.kind !== "symbol" && rule.kind !== "whole" && rule.optional === true;
  switch (rule.kind) {
    case "money":
      return MONEY.test(value) && positive(value);
    case "decimal":
      return DECIMAL.test(value) && positive(value) && (rule.max === undefined || new Decimal(value).lte(rule.max));
    case "text":
      return value.length <= rule.max;
    case "symbol":
      return SYMBOL.test(value.toUpperCase());
    case "whole":
      return WHOLE.test(value) && Number.parseInt(value, 10) >= rule.min && Number.parseInt(value, 10) <= rule.max;
  }
}

/** Field messages of the fields that break their rule (empty when the form can be sent). */
export function checkForm(form: FormData, rules: Readonly<Record<string, FieldRule>>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [field, rule] of Object.entries(rules)) {
    if (!checkField(fieldValue(form, field), rule)) errors[field] = rule.message;
  }
  return errors;
}

export const MONEY_COPY = (label: string) => `${label} must be a positive amount with up to 2 decimals.`;
export const DECIMAL_COPY = (label: string) => `${label} must be a positive number with up to 8 decimals.`;
