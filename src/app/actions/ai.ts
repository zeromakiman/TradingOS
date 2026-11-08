"use server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { monthlyPeriod } from "@/ai/monthly-period";
import { recentSample } from "@/ai/recent-trades-context";
import { weeklyPeriod } from "@/ai/weekly-period";
import { analyzeTradeSetup } from "@/lib/analyze-setup";
import { challengeTradeBias } from "@/lib/bias-challenge";
import { reviewMonth } from "@/lib/monthly-review";
import { operationalFailure } from "@/lib/operational-log";
import { analyzeRecentTrades } from "@/lib/recent-trades";
import { SCHEMA_OUTDATED_MESSAGE, writableSession } from "@/lib/schema-gate";
import { reviewTradeTimeline } from "@/lib/trade-timeline-review";
import { reviewWeek } from "@/lib/weekly-review";

/**
 * V2 AI server actions (spec §8.3, §11). Each request carries a client-generated `requestKey` that becomes the
 * request id: replaying it returns RECORDED without another provider call, so the form rotates the key only after a
 * terminal result (`status` COMPLETED, FAILED or RECORDED). The user always comes from the verified session inside
 * the lib functions; nothing here accepts a user id, a revision proposal or a price from the client. Every action
 * first passes the shared schema gate (`writableSession`, src/lib/schema-gate.ts, spec §13.10) like every other action
 * module, so nothing is written or sent against an older database; an unreadable marker is an unexpected failure.
 */

export interface AiActionState {
  error?: string;
  success?: string;
  /** Outcome code for the form: COMPLETED, FAILED, RECORDED (terminal) or a no-write state such as ACCOUNT_OFF. */
  status?: string;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "RECORDED"]);

/** True when the database is missing the schema marker or older than 2.0; throws when the marker cannot be read. */
async function schemaOutdated(): Promise<boolean> {
  return (await writableSession()) === null;
}

function text(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function evidenceIds(form: FormData): string[] {
  return form.getAll("evidence").filter((value): value is string => typeof value === "string");
}

function outcome(result: { status: string; message: string }): AiActionState {
  return TERMINAL.has(result.status) ? { success: result.message, status: result.status } : { error: result.message, status: result.status };
}

function unexpected(error: unknown, copy: string): AiActionState {
  unstable_rethrow(error);
  operationalFailure("request_failed");
  return { error: copy };
}

function revalidateTrade(tradeId: string): void {
  revalidatePath(`/trades/${tradeId}`);
  revalidatePath("/settings");
}

const uuid = z.uuid();
const preTradeInput = z.object({
  tradeId: uuid,
  requestKey: uuid,
  evidence: z.array(uuid).max(3),
  /** Revision shown on the page; the server analyses the latest revision and refuses when they differ. */
  revision: z.coerce.number().int().positive().optional(),
});
const reviewInput = z.object({ tradeId: uuid, requestKey: uuid, evidence: z.array(uuid).max(4) });

function preTradeFields(form: FormData) {
  return preTradeInput.safeParse({
    tradeId: text(form, "tradeId"), requestKey: text(form, "requestKey"), evidence: evidenceIds(form), revision: text(form, "revision") || undefined,
  });
}

export async function requestTradeAnalyzeSetup(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = preTradeFields(form);
    if (!input.success) return { error: "Select up to three screenshots from this draft." };
    const result = await analyzeTradeSetup(input.data.tradeId, input.data.requestKey, input.data.evidence, input.data.revision);
    revalidateTrade(input.data.tradeId);
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request an analysis. Refresh to check the draft, its screenshots and AI settings.");
  }
}

export async function requestTradeBiasChallenge(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = preTradeFields(form);
    if (!input.success) return { error: "Select up to three screenshots from this draft." };
    const result = await challengeTradeBias(input.data.tradeId, input.data.requestKey, input.data.evidence, input.data.revision);
    revalidateTrade(input.data.tradeId);
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request a challenge. Refresh to check the draft, its screenshots and AI settings.");
  }
}

export async function requestTradeTimelineReview(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = reviewInput.safeParse({ tradeId: text(form, "tradeId"), requestKey: text(form, "requestKey"), evidence: evidenceIds(form) });
    if (!input.success) return { error: "Select up to four screenshots from this trade." };
    const result = await reviewTradeTimeline(input.data.tradeId, input.data.requestKey, input.data.evidence);
    revalidateTrade(input.data.tradeId);
    revalidatePath("/journal");
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request a review. Refresh to check the trade, its screenshots and AI settings.");
  }
}

const accountInput = z.object({ accountId: uuid, requestKey: uuid });

function revalidateReview(page: "weekly" | "recent" | "monthly"): void {
  revalidatePath("/review");
  revalidatePath(`/review/${page}`);
  revalidatePath("/settings");
}

export async function requestWeeklyAiReview(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = accountInput.safeParse({ accountId: text(form, "accountId"), requestKey: text(form, "requestKey") });
    let week: string;
    try {
      week = weeklyPeriod(z.string().parse(text(form, "week"))).startDate;
    } catch {
      return { error: "Choose a completed week and a trading account." };
    }
    if (!input.success) return { error: "Choose a completed week and a trading account." };
    const result = await reviewWeek(input.data.accountId, week, input.data.requestKey);
    revalidateReview("weekly");
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request a weekly review. Refresh to check the account, its history and AI settings.");
  }
}

export async function requestRecentTradesAiReview(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = accountInput.safeParse({ accountId: text(form, "accountId"), requestKey: text(form, "requestKey") });
    let sample: ReturnType<typeof recentSample>;
    try {
      sample = recentSample(form.get("sample"));
    } catch {
      return { error: "Choose 10, 20 or 30 completed trades and a trading account." };
    }
    if (!input.success) return { error: "Choose 10, 20 or 30 completed trades and a trading account." };
    const result = await analyzeRecentTrades(input.data.accountId, sample, input.data.requestKey);
    revalidateReview("recent");
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request an analysis of recent trades. Refresh to check the account, its history and AI settings.");
  }
}

export async function requestMonthlyAiReview(_state: AiActionState, form: FormData): Promise<AiActionState> {
  try {
    if (await schemaOutdated()) return { error: SCHEMA_OUTDATED_MESSAGE };
    const input = accountInput.safeParse({ accountId: text(form, "accountId"), requestKey: text(form, "requestKey") });
    let month: string;
    try {
      month = monthlyPeriod(z.string().parse(text(form, "month"))).month;
    } catch {
      return { error: "Choose a completed month and a trading account." };
    }
    if (!input.success) return { error: "Choose a completed month and a trading account." };
    const result = await reviewMonth(input.data.accountId, month, input.data.requestKey);
    revalidateReview("monthly");
    return outcome(result);
  } catch (error) {
    return unexpected(error, "Unable to request a monthly review. Refresh to check the account, its history and AI settings.");
  }
}
