"use server";
import Decimal from "decimal.js";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { ACCOUNT_COOKIE, ALL_ACCOUNTS_VALUE, LAST_ACCOUNT_COOKIE, setContextCookie } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { loadLatestObservation } from "@/lib/workspace";
import {
  type ActionState, actionError, actionSuccess, FAILED_COPY, formFlag, formOptional, formText, INVALID_COPY, invalidField, rpcErrorCopy, type RpcErrorLike,
  SQL_ERROR_COPY,
} from "./state";

/**
 * Trading-account server actions (docs/V2_ARCHITECTURE.md §3.2, §3.9–3.10, §8.4, §9, §14.9). Schema gate first, zod
 * validation with field copy, one RPC with the user's session, revalidation of the account pages and the shell.
 *
 * Form contracts (FormData field names):
 * - createTradingAccount: requestKey, name, currency, accountType, platform, broker?, startingBalance?, balance, equity → { accountId }
 * - updateProfile: accountId and any of displayName, broker, platform, accountType, startingBalance (a present empty
 *   broker or starting balance clears it)
 * - archiveAccount / restoreAccount: accountId
 * - createInstrument: accountId, symbol, quantityUnit, tickSize, pipSize?, tickValue, quantityStep, minimumQuantity → { instrumentId }
 * - recordAccountValues: accountId, balance, equity
 * - confirmAccountValuesUnchanged: accountId, observationId? (the values shown; refused when newer ones exist)
 * - addExternalLoss: accountId, amount, note?, requestKey · removeExternalLoss: entryId, reason?
 * - createRiskPolicyVersion: accountId, maxRiskPercent, defaultRiskPercent, maxDailyTrades, minRR, rrPolicy, newsPolicy,
 *   dailyRiskCap?, dailyLossCap?, immediate (checkbox), reason? (required for an immediate change)
 */

const D = Decimal.clone({ precision: 60 });
const uuid = z.uuid();
const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "JPY", "AUD", "CAD", "NZD", "SGD", "HKD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "ZAR", "MXN"] as const;
const ACCOUNT_TYPES = ["DEMO", "EVALUATION", "FUNDED", "PERSONAL", "OTHER"] as const;
const PLATFORMS = ["MANUAL", "CTRADER", "MT5", "MT4", "TRADINGVIEW", "OTHER"] as const;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const DECIMAL = /^\d{1,12}(\.\d{1,8})?$/;

// `abort` stops at a failed format check: the refinements below parse the value and must only see well-formed numbers.
const money = z.string().trim().regex(MONEY, { abort: true }).refine(value => new D(value).gt(0));
const decimal = z.string().trim().regex(DECIMAL, { abort: true }).refine(value => new D(value).gt(0));

const COPY = {
  requestKey: "Reload the page and submit the form again.",
  accountId: "This trading account isn't available. Reload the page.",
  name: "Name the account (1 to 100 characters).",
  displayName: "Name the account (1 to 100 characters).",
  currency: "Choose the account currency.",
  accountType: "Choose the account type.",
  platform: "Choose the platform.",
  broker: "Keep the broker name to 100 characters.",
  startingBalance: "Starting balance must be a positive amount with up to 2 decimals.",
  balance: "Balance must be a positive amount with up to 2 decimals.",
  equity: "Equity must be a positive amount with up to 2 decimals.",
  symbol: "Use 1 to 20 capital letters, digits or . _ / - for the symbol.",
  quantityUnit: "Describe the size unit (1 to 60 characters), for example \"lots (100,000 EUR)\".",
  tickSize: "Tick size must be a positive number with up to 8 decimals.",
  pipSize: "Pip size must be a positive number with up to 8 decimals.",
  tickValue: "Tick value must be a positive amount in the account currency, with up to 8 decimals.",
  quantityStep: "Size step must be a positive number with up to 8 decimals.",
  minimumQuantity: "Minimum size must be a positive number with up to 8 decimals.",
  amount: "Amount must be a positive amount with up to 2 decimals.",
  note: "Keep the note to 500 characters.",
  entryId: "That external loss isn't available. Reload the page.",
  reason: "Keep the reason to 500 characters.",
  maxRiskPercent: "Maximum risk must be more than 0% and at most 100%, with up to 8 decimals.",
  defaultRiskPercent: "Default risk must be more than 0% and not above the maximum.",
  maxDailyTrades: "Trades per day must be a whole number from 1 to 100.",
  minRR: "Minimum RR must be more than 0 and at most 100, with up to 8 decimals.",
  rrPolicy: "Choose whether a low RR blocks or warns.",
  newsPolicy: "Choose whether restricted news blocks or warns.",
  dailyRiskCap: "Daily risk cap must be a positive amount with up to 2 decimals.",
  dailyLossCap: "Daily loss limit must be a positive amount with up to 2 decimals.",
  immediateReason: "An immediate change needs a reason of at least 5 characters.",
  observationId: "Reload the page to confirm the latest account values.",
} as const satisfies Record<string, string>;

type CopyKey = keyof typeof COPY;

function fieldErrors(error: z.ZodError, fallback: CopyKey): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? fallback);
    errors[key] = Object.hasOwn(COPY, key) ? COPY[key as CopyKey] : COPY[fallback];
  }
  return errors;
}

function rpcFailure<T>(error: RpcErrorLike, fields: readonly string[] = [], overrides: Readonly<Record<string, string>> = {}): ActionState<T> {
  const message = rpcErrorCopy(error, overrides);
  if (message === FAILED_COPY) operationalFailure("database_write_failed");
  const field = invalidField(error, fields);
  return actionError(message, field && Object.hasOwn(COPY, field) ? { [field]: COPY[field as CopyKey] } : undefined);
}

function unexpected<T>(error: unknown): ActionState<T> {
  unstable_rethrow(error);
  operationalFailure("database_write_failed");
  return actionError(FAILED_COPY);
}

function revalidateAccount(accountId: string, shell = false): void {
  if (shell) revalidatePath("/", "layout");
  revalidatePath("/accounts");
  revalidatePath(`/accounts/${accountId}`);
  revalidatePath(`/accounts/${accountId}/manage`);
  revalidatePath("/today");
  revalidatePath("/settings");
}

// ---------------------------------------------------------------------------------------------------------
// Accounts and profiles (§3.2, §9).
// ---------------------------------------------------------------------------------------------------------
const createInput = z.object({
  requestKey: uuid, name: z.string().trim().min(1).max(100), currency: z.enum(CURRENCIES), accountType: z.enum(ACCOUNT_TYPES), platform: z.enum(PLATFORMS),
  broker: z.string().trim().max(100).optional(), startingBalance: money.optional(), balance: money, equity: money,
});

export async function createTradingAccount(_prev: ActionState<{ accountId: string }>, form: FormData): Promise<ActionState<{ accountId: string }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = createInput.safeParse({
      requestKey: formText(form, "requestKey"), name: formText(form, "name"), currency: formText(form, "currency"), accountType: formText(form, "accountType"),
      platform: formText(form, "platform"), broker: formOptional(form, "broker"), startingBalance: formOptional(form, "startingBalance"),
      balance: formText(form, "balance"), equity: formText(form, "equity"),
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "name"));
    const { requestKey, ...account } = input.data;
    const payload = Object.fromEntries(Object.entries(account).filter(([, value]) => value !== undefined));
    const { data, error } = await session.db.rpc("create_trading_account", { p_request_key: requestKey, p_input: payload });
    if (error) return rpcFailure(error, ["name", "currency", "accountType", "platform", "broker", "startingBalance", "balance", "equity"]);
    const accountId = uuid.parse(data);
    await setContextCookie(LAST_ACCOUNT_COOKIE, accountId);
    revalidateAccount(accountId, true);
    return actionSuccess("Trading account created with the ICT V1.0 strategy and Risk Plan V1.0.", { accountId });
  } catch (error) {
    return unexpected(error);
  }
}

const PROFILE_FIELDS = ["displayName", "broker", "platform", "accountType", "startingBalance"] as const;
const profileInput = z.object({
  accountId: uuid,
  displayName: z.string().trim().min(1).max(100).optional(),
  broker: z.string().trim().max(100).nullable().optional(),
  platform: z.enum(PLATFORMS).optional(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  startingBalance: money.nullable().optional(),
});

export async function updateProfile(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    // Only fields present in the form change; a present but empty broker or starting balance clears it.
    const present = Object.fromEntries(PROFILE_FIELDS.filter(key => form.has(key)).map(key => {
      const value = formOptional(form, key);
      return [key, value ?? (key === "broker" || key === "startingBalance" ? null : "")];
    }));
    const input = profileInput.safeParse({ accountId: formText(form, "accountId"), ...present });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "displayName"));
    const { accountId, ...changes } = input.data;
    if (!Object.keys(changes).length) return actionError("Change at least one detail of the profile.");
    const { error } = await session.db.rpc("update_account_profile", { p_account_id: accountId, p_input: changes });
    if (error) return rpcFailure(error, [...PROFILE_FIELDS]);
    revalidateAccount(accountId, true);
    return actionSuccess("Profile saved. Earlier versions stay in the history.");
  } catch (error) {
    return unexpected(error);
  }
}

async function setStatus(form: FormData, status: "ACTIVE" | "ARCHIVED"): Promise<ActionState> {
  const session = await writableSession();
  if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
  const accountId = uuid.safeParse(formText(form, "accountId")?.toLowerCase());
  if (!accountId.success) return actionError(INVALID_COPY, { accountId: COPY.accountId });
  const { error } = await session.db.rpc("update_account_profile", { p_account_id: accountId.data, p_input: { status } });
  if (error) return rpcFailure(error);
  if (status === "ARCHIVED") {
    // An archived account can't stay the working context or the default of new trades (§9.2).
    const jar = await cookies();
    if (jar.get(ACCOUNT_COOKIE)?.value === accountId.data) await setContextCookie(ACCOUNT_COOKIE, ALL_ACCOUNTS_VALUE);
    if (jar.get(LAST_ACCOUNT_COOKIE)?.value === accountId.data) jar.delete(LAST_ACCOUNT_COOKIE);
  }
  revalidateAccount(accountId.data, true);
  return actionSuccess(status === "ARCHIVED" ? "Account archived. It takes no new trades; its history stays." : "Account restored. It can take new trades again.");
}

export async function archiveAccount(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    return await setStatus(form, "ARCHIVED");
  } catch (error) {
    return unexpected(error);
  }
}

export async function restoreAccount(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    return await setStatus(form, "ACTIVE");
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Instruments (§3.2).
// ---------------------------------------------------------------------------------------------------------
const instrumentInput = z.object({
  accountId: uuid, symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._/-]{0,19}$/), quantityUnit: z.string().trim().min(1).max(60),
  tickSize: decimal, pipSize: decimal.optional(), tickValue: decimal, quantityStep: decimal, minimumQuantity: decimal,
});

export async function createInstrument(_prev: ActionState<{ instrumentId: string }>, form: FormData): Promise<ActionState<{ instrumentId: string }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = instrumentInput.safeParse({
      accountId: formText(form, "accountId"), symbol: formText(form, "symbol"), quantityUnit: formText(form, "quantityUnit"), tickSize: formText(form, "tickSize"),
      pipSize: formOptional(form, "pipSize"), tickValue: formText(form, "tickValue"), quantityStep: formText(form, "quantityStep"),
      minimumQuantity: formText(form, "minimumQuantity"),
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "symbol"));
    const { accountId, ...instrument } = input.data;
    const payload = Object.fromEntries(Object.entries(instrument).filter(([, value]) => value !== undefined));
    const { data, error } = await session.db.rpc("create_instrument_version", { p_account_id: accountId, p_input: payload });
    if (error) return rpcFailure(error, ["symbol", "quantityUnit", "tickSize", "pipSize", "tickValue", "quantityStep", "minimumQuantity"]);
    const instrumentId = uuid.parse(data);
    revalidateAccount(accountId);
    revalidatePath("/trades/new");
    revalidatePath("/trades/live/new");
    return actionSuccess(`${instrument.symbol} saved. New plans use this version; earlier trades keep theirs.`, { instrumentId });
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Account values and external losses (§3.2, §3.9, §8.4).
// ---------------------------------------------------------------------------------------------------------
const valuesInput = z.object({ accountId: uuid, balance: money, equity: money });

export async function recordAccountValues(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = valuesInput.safeParse({ accountId: formText(form, "accountId"), balance: formText(form, "balance"), equity: formText(form, "equity") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "balance"));
    const { error } = await session.db.rpc("record_account_values", { p_account_id: input.data.accountId, p_balance: input.data.balance, p_equity: input.data.equity });
    if (error) return rpcFailure(error, ["balance", "equity"], { INVALID_INPUT: "Balance and equity must be positive amounts with up to 2 decimals." });
    revalidateAccount(input.data.accountId);
    return actionSuccess("Account values recorded for today.");
  } catch (error) {
    return unexpected(error);
  }
}

export async function confirmAccountValuesUnchanged(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = z.object({ accountId: uuid, observationId: uuid.optional() })
      .safeParse({ accountId: formText(form, "accountId"), observationId: formOptional(form, "observationId")?.toLowerCase() });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "accountId"));
    const latest = await loadLatestObservation(session.db, session.user.id, input.data.accountId);
    if (!latest) return actionError("No account values were recorded yet. Enter the balance and equity.");
    if (input.data.observationId && latest.id !== input.data.observationId) {
      return actionError("Account values changed since this page loaded. Reload and confirm again.", { observationId: COPY.observationId });
    }
    const { error } = await session.db.rpc("record_account_values", { p_account_id: input.data.accountId, p_balance: latest.balance, p_equity: latest.equity });
    if (error) return rpcFailure(error);
    revalidateAccount(input.data.accountId);
    return actionSuccess("Balance confirmed for today.");
  } catch (error) {
    return unexpected(error);
  }
}

const lossInput = z.object({ accountId: uuid, amount: money, note: z.string().trim().max(500).optional(), requestKey: uuid });

export async function addExternalLoss(_prev: ActionState<{ entryId: string }>, form: FormData): Promise<ActionState<{ entryId: string }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = lossInput.safeParse({ accountId: formText(form, "accountId"), amount: formText(form, "amount"), note: formOptional(form, "note"), requestKey: formText(form, "requestKey") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "amount"));
    const { data, error } = await session.db.rpc("add_external_loss", {
      p_account_id: input.data.accountId, p_amount: input.data.amount, p_note: input.data.note ?? null, p_request_key: input.data.requestKey,
    });
    if (error) return rpcFailure(error, ["amount", "note"]);
    const entryId = uuid.parse(data);
    revalidateAccount(input.data.accountId);
    return actionSuccess("External loss added to today's losses.", { entryId });
  } catch (error) {
    return unexpected(error);
  }
}

export async function removeExternalLoss(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = z.object({ entryId: uuid, reason: z.string().trim().max(500).optional() }).safeParse({ entryId: formText(form, "entryId"), reason: formOptional(form, "reason") });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "entryId"));
    const entry = await session.db.from("external_loss_entries").select("account_id").eq("id", input.data.entryId).eq("user_id", session.user.id).maybeSingle();
    if (entry.error) return actionError(FAILED_COPY);
    const accountId = entry.data ? z.object({ account_id: z.uuid() }).parse(entry.data).account_id : null;
    if (!accountId) return actionError(SQL_ERROR_COPY.EXTERNAL_LOSS_NOT_FOUND);
    const { error } = await session.db.rpc("remove_external_loss", { p_entry_id: input.data.entryId, p_reason: input.data.reason ?? null });
    if (error) return rpcFailure(error);
    revalidateAccount(accountId);
    return actionSuccess("External loss removed. The removal is kept in the history.");
  } catch (error) {
    return unexpected(error);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Risk policy (§3.10, §14.9).
// ---------------------------------------------------------------------------------------------------------
const policyInput = z.object({
  accountId: uuid,
  maxRiskPercent: decimal.refine(value => new D(value).lte(100)),
  defaultRiskPercent: decimal,
  maxDailyTrades: z.coerce.number().int().min(1).max(100),
  minRR: decimal.refine(value => new D(value).lte(100)),
  rrPolicy: z.enum(["BLOCK", "WARN"]),
  newsPolicy: z.enum(["BLOCK", "WARN"]),
  dailyRiskCap: money.optional(),
  dailyLossCap: money.optional(),
  immediate: z.boolean(),
  reason: z.string().trim().max(500).optional(),
}).superRefine((value, ctx) => {
  if (new D(value.defaultRiskPercent).gt(value.maxRiskPercent)) ctx.addIssue({ code: "custom", path: ["defaultRiskPercent"], message: "default above maximum" });
  if (value.immediate && (value.reason ?? "").length < 5) ctx.addIssue({ code: "custom", path: ["immediateReason"], message: "reason required" });
});

export async function createRiskPolicyVersion(_prev: ActionState<{ effective: "TODAY" | "NEXT_DAY" }>, form: FormData): Promise<ActionState<{ effective: "TODAY" | "NEXT_DAY" }>> {
  try {
    const session = await writableSession();
    if (!session) return actionError(SCHEMA_OUTDATED_MESSAGE);
    const input = policyInput.safeParse({
      accountId: formText(form, "accountId"), maxRiskPercent: formText(form, "maxRiskPercent"), defaultRiskPercent: formText(form, "defaultRiskPercent"),
      maxDailyTrades: formText(form, "maxDailyTrades"), minRR: formText(form, "minRR"), rrPolicy: formText(form, "rrPolicy"), newsPolicy: formText(form, "newsPolicy"),
      dailyRiskCap: formOptional(form, "dailyRiskCap"), dailyLossCap: formOptional(form, "dailyLossCap"), immediate: formFlag(form, "immediate"),
      reason: formOptional(form, "reason"),
    });
    if (!input.success) return actionError(INVALID_COPY, fieldErrors(input.error, "maxRiskPercent"));
    const { accountId, immediate, reason, ...config } = input.data;
    const payload = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    const { error } = await session.db.rpc("create_risk_policy_version", {
      p_account_id: accountId, p_config: payload, p_immediate: immediate, p_reason: immediate ? reason ?? null : null,
    });
    if (error) return rpcFailure(error, ["maxRiskPercent", "defaultRiskPercent", "maxDailyTrades", "minRR", "rrPolicy", "newsPolicy", "dailyRiskCap", "dailyLossCap"]);
    revalidateAccount(accountId);
    revalidatePath("/trades/new");
    return actionSuccess(
      immediate
        ? "New risk plan version active now. The override and its reason are recorded."
        : "New risk plan version starts on the next trading day (UTC−5). Today's checks keep the current version.",
      { effective: immediate ? "TODAY" : "NEXT_DAY" },
    );
  } catch (error) {
    return unexpected(error);
  }
}
