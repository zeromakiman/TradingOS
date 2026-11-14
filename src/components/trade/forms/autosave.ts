import { z } from "zod";
import { paletteHash } from "@/components/shell/palette-history";
import { type LiveDraft, OTHER_SYMBOL, switchLiveAccount } from "./live-model";
import { CUSTOM_RISK, type PlanDraft, planDefaultRisk, riskChoiceFor, riskPresets, switchPlanAccount } from "./plan-model";
import type { FormAccount } from "./types";

/**
 * Unsaved entries of the trade forms, kept in this browser tab (sessionStorage) so that Back, a swipe-back or a reload
 * never throws a half-written plan or live trade away (docs/V2_ARCHITECTURE.md §14.2, §14.3). Only the form fields and
 * the submission's request key are kept (a retry after a lost response stays a replay of the same submission), never
 * screenshots. Keys carry hashes of the signed-in user and of the trade, never a raw id, and opening a form removes
 * other users' entries left in the tab. Restored values are checked again against today's accounts. Storage can be
 * unavailable (private windows, blocked site data): the forms then simply keep nothing.
 */

const PREFIX = "tos.form";
const VERSION = 1;

/** The form whose entries are kept: Plan Trade, Record Live Trade, or Edit Draft of one revision of a trade. */
export type AutosaveTarget = { form: "plan" } | { form: "live" } | { form: "edit"; tradeId: string; revision: number };

/** Per-user part of the keys: a hash of the user id, so a later sign-in in the same tab never restores these entries. */
export function autosaveScope(userId: string): string {
  return paletteHash(`trade-form:${userId.trim().toLowerCase()}`);
}

/**
 * `tos.form.<user>.plan.new`, `tos.form.<user>.live.new` or `tos.form.<user>.edit-<trade>.r2`: one key per form. Edit
 * Draft keys name the revision the entries were made on, so they never land on a newer revision.
 */
export function autosaveKey(scope: string, target: AutosaveTarget): string {
  if (target.form === "edit") return `${PREFIX}.${scope}.edit-${paletteHash(target.tradeId.trim().toLowerCase())}.r${target.revision}`;
  return `${PREFIX}.${scope}.${target.form}.new`;
}

function keyParts(key: string): { scope: string; family: string } {
  const [, , scope = "", family = ""] = key.split(".");
  return { scope, family };
}

function storedKeys(store: Storage): string[] {
  return Array.from({ length: store.length }, (_, index) => store.key(index)).filter((key): key is string => key?.startsWith(`${PREFIX}.`) ?? false);
}

/** Removes entries of other users in this tab and older revisions of the same draft. */
export function pruneAutosaves(key: string) {
  const current = keyParts(key);
  try {
    const store = window.sessionStorage;
    for (const other of storedKeys(store)) {
      const parts = keyParts(other);
      if (other !== key && (parts.scope !== current.scope || parts.family === current.family)) store.removeItem(other);
    }
  } catch {
    // Nothing is kept without storage.
  }
}

/** Forgets the unsaved entries of every trade form in this tab (sign-out and account erasure). */
export function clearFormAutosaves() {
  try {
    const store = window.sessionStorage;
    for (const key of storedKeys(store)) store.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}

export interface StoredEntries {
  /** The form fields as stored; validate them with `restorePlanDraft` or `restoreLiveDraft` before use. */
  draft: unknown;
  requestKey: string | null;
}

const envelope = z.object({ v: z.literal(VERSION), draft: z.unknown(), requestKey: z.uuid().nullable() });

/** The entries kept under `key`, or null; unreadable entries are removed. */
export function readAutosave(key: string): StoredEntries | null {
  try {
    const store = window.sessionStorage;
    const text = store.getItem(key);
    if (text === null) return null;
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch {
      // Not JSON: dropped below.
    }
    const parsed = envelope.safeParse(value);
    if (parsed.success) return { draft: parsed.data.draft, requestKey: parsed.data.requestKey };
    store.removeItem(key);
  } catch {
    // Storage unavailable.
  }
  return null;
}

export function writeAutosave(key: string, entries: StoredEntries) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ v: VERSION, draft: entries.draft, requestKey: entries.requestKey }));
  } catch {
    // Full or blocked storage: the entries live as long as the page.
  }
}

export function removeAutosave(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}

/** Whether two flat form drafts hold the same values, whatever their key order. */
export function sameDraft<T extends object>(a: T, b: T): boolean {
  const left = Object.entries(a);
  const right = b as Record<string, unknown>;
  return left.length === Object.keys(b).length && left.every(([key, value]) => Object.hasOwn(right, key) && Object.is(value, right[key]));
}

/**
 * Stored entries worth bringing back: valid for today's data (`restore`) and different from what the page opened with.
 * Null otherwise, and the stored copy is then dropped.
 */
export function restorableEntries<T extends object>(
  stored: StoredEntries | null, restore: (draft: unknown) => T | null, initial: T,
): { draft: T; requestKey: string | null } | null {
  if (stored === null) return null;
  const draft = restore(stored.draft);
  return draft === null || sameDraft(draft, initial) ? null : { draft, requestKey: stored.requestKey };
}

/** What the tab keeps for a form: nothing while its entries are untouched, else the entries and the request key. */
export function entriesToKeep<T extends object>(draft: T, initial: T, requestKey: string | null): StoredEntries | null {
  return sameDraft(draft, initial) ? null : { draft, requestKey };
}

const field = (max: number) => z.string().max(max);
const direction = z.enum(["", "LONG", "SHORT"]);

const planDraftSchema = z.object({
  accountId: field(64),
  instrumentId: field(64),
  direction,
  model: z.enum(["", "OB_FIRST_TOUCH", "OTE"]),
  entry: field(64),
  stop: field(64),
  target: field(64),
  riskChoice: field(64),
  customRisk: field(64),
  narrative: field(5000),
  news: z.enum(["UNKNOWN", "CLEAR", "RESTRICTED"]),
  contractConfirmed: z.boolean(),
  contradiction: z.boolean(),
});

const liveDraftSchema = z.object({
  accountId: field(64),
  instrumentId: field(64),
  symbol: field(20),
  direction,
  entryPrice: field(64),
  priceLater: z.boolean(),
  timing: z.enum(["now", "earlier", "unknown"]),
  enteredAt: field(32),
  quantity: field(64),
  initialStop: field(64),
  riskAmount: field(64),
  entryModel: z.enum(["", "OB_FIRST_TOUCH", "OTE", "OTHER"]),
  // 0020: entries kept before custom models existed have none.
  customModelId: field(64).default(""),
});

/**
 * Stored Plan Trade or Edit Draft entries checked against today's accounts, or null when they are not a plan's entries.
 * An account that is gone gives way to the page's account (prices, thesis and checks stay; the contract is confirmed
 * again); a contract whose version changed, or a risk preset above today's maximum, is not restored.
 */
export function restorePlanDraft(stored: unknown, accounts: readonly FormAccount[], initial: PlanDraft): PlanDraft | null {
  const parsed = planDraftSchema.safeParse(stored);
  if (!parsed.success) return null;
  const draft: PlanDraft = parsed.data;
  const account = accounts.find(item => item.id === draft.accountId);
  if (!account) {
    const fallback = accounts.find(item => item.id === initial.accountId);
    return fallback ? switchPlanAccount(draft, fallback, accounts) : { ...draft, accountId: "", instrumentId: "", contractConfirmed: false };
  }
  const instrument = account.instruments.find(item => item.id === draft.instrumentId);
  const presets = riskPresets(account.riskPlan);
  const riskKept = draft.riskChoice === "" || draft.riskChoice === CUSTOM_RISK || presets.includes(draft.riskChoice);
  return {
    ...draft,
    instrumentId: instrument?.id ?? "",
    contractConfirmed: instrument !== undefined && draft.contractConfirmed,
    ...(riskKept ? {} : riskChoiceFor(planDefaultRisk(account.riskPlan), presets)),
  };
}

/**
 * Stored Record Live Trade entries checked against today's accounts, or null when they are not a live trade's entries.
 * An account that is gone gives way to the page's account (keeping the symbol where it trades it); an instrument that
 * is no longer the account's is not restored.
 */
export function restoreLiveDraft(stored: unknown, accounts: readonly FormAccount[], initial: LiveDraft): LiveDraft | null {
  const parsed = liveDraftSchema.safeParse(stored);
  if (!parsed.success) return null;
  const draft: LiveDraft = parsed.data;
  const account = accounts.find(item => item.id === draft.accountId);
  if (!account) {
    const fallback = accounts.find(item => item.id === initial.accountId);
    return fallback ? switchLiveAccount(draft, fallback, accounts) : { ...draft, accountId: "", instrumentId: "" };
  }
  const known = draft.instrumentId === "" || draft.instrumentId === OTHER_SYMBOL || account.instruments.some(item => item.id === draft.instrumentId);
  // A custom model that is gone or archived is not restored (the model goes back to no choice).
  const model = draft.customModelId === "" || account.customModels.some(item => item.id === draft.customModelId) ? {} : { customModelId: "", entryModel: "" as const };
  return { ...draft, ...model, ...(known ? {} : { instrumentId: "" }) };
}
