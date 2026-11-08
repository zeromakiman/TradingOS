import "server-only";
import { typeAndBroker } from "@/components/accounts/copy";
import { evidenceTagText } from "@/components/evidence/labels";
import { isEvidenceLabel, isTimeframe } from "@/components/evidence/types";
import { LOCKED_PLAN_NOTE } from "@/domain/trade-state";
import type { DuplicateCandidate } from "@/domain/risk";
import { type ContextAccount, currentSession, getAccountContext } from "@/lib/account-context";
import { operationalFailure } from "@/lib/operational-log";
import { getTradeDetail, type TradeDetail } from "@/lib/trades-data";
import { type AccountWorkspace, getAccountWorkspace, loadAccountWorkspace, riskContextFor } from "@/lib/workspace";
import { autosaveScope } from "./autosave";
import type { AccountRiskBase, DraftPrefill, EditDraftData, ExistingEvidence, FormAccount, NotEditable, TradeFormData } from "./types";

/**
 * Server loaders of the trade forms (docs/V2_ARCHITECTURE.md §9.2, §14.2, §14.3), read with the user's session. Plan
 * Trade and Record Live Trade load every ACTIVE account's workspace once, so switching the form's account never needs a
 * request; Edit Draft loads the trade (latest revision, evidence, AI history) and its account's workspace.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields the DUPLICATE rule compares; locked theses and flags stay on the server. */
function duplicateFields(plans: readonly DuplicateCandidate[]): DuplicateCandidate[] {
  return plans.map(plan => {
    const proposal = isRecord(plan.proposal) ? plan.proposal : {};
    return {
      instrumentVersionId: plan.instrumentVersionId,
      proposal: { direction: proposal.direction, model: proposal.model, entry: proposal.entry, stop: proposal.stop, target: proposal.target },
    };
  });
}

/** The engine context of the workspace without the instrument and the duplicate flag (the preview adds both). */
function riskBase(workspace: AccountWorkspace): AccountRiskBase | null {
  const first = workspace.instruments[0];
  const context = first ? riskContextFor(workspace, first) : null;
  if (!context) return null;
  return {
    now: context.now, strategyVersionId: context.strategyVersionId, strategyVersion: context.strategyVersion, observationId: context.observationId,
    observationDay: context.observationDay, equity: context.equity, currency: context.currency, plan: context.plan, usage: context.usage,
  };
}

/** A workspace as the forms read it. */
export function formAccount(workspace: AccountWorkspace): FormAccount {
  const { account, riskPlan, observation, strategy, usage } = workspace;
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    description: typeAndBroker(account.type, account.broker),
    instruments: workspace.instruments,
    riskPlan: riskPlan
      ? {
        version: riskPlan.version, maxRiskPercent: riskPlan.maxRiskPercent, defaultRiskPercent: riskPlan.defaultRiskPercent, minRR: riskPlan.minRR,
        rrPolicy: riskPlan.rrPolicy, newsPolicy: riskPlan.newsPolicy, maxDailyTrades: riskPlan.maxDailyTrades, dailyRiskCap: riskPlan.dailyRiskCap,
        dailyLossCap: riskPlan.dailyLossCap,
      }
      : null,
    risk: riskBase(workspace),
    todaysPlans: duplicateFields(workspace.todaysPlans),
    riskPlanId: riskPlan?.id ?? null,
    observationId: observation?.id ?? null,
    balance: observation?.balance ?? null,
    equity: observation?.equity ?? null,
    observationDay: observation?.tradingDay ?? null,
    strategyVersion: strategy?.version ?? null,
    usage: riskPlan
      ? { day: usage.day, used: usage.plannedSlots + usage.unplannedTrades, planned: usage.plannedSlots, unplanned: usage.unplannedTrades, max: riskPlan.maxDailyTrades }
      : null,
    gaps: workspace.gaps,
  };
}

/** An account whose workspace could not be read: listed, but nothing can be planned or recorded on it. */
function unavailableAccount(account: ContextAccount): FormAccount {
  return {
    id: account.id, name: account.name, currency: account.currency, description: typeAndBroker(account.type, account.broker), instruments: [], riskPlan: null,
    risk: null, todaysPlans: [], riskPlanId: null, observationId: null, balance: null, equity: null, observationDay: null, strategyVersion: null, usage: null,
    gaps: ["UNAVAILABLE"],
  };
}

/** Plan Trade / Record Live Trade: every active account at the server time of this request. */
export async function loadTradeFormData(): Promise<TradeFormData> {
  const [{ db, user }, context] = await Promise.all([currentSession(), getAccountContext()]);
  const now = new Date().toISOString();
  const accounts = await Promise.all(context.active.map(async account => {
    try {
      return formAccount(await loadAccountWorkspace(db, user.id, account, now));
    } catch {
      operationalFailure("data_read_failed");
      return unavailableAccount(account);
    }
  }));
  return { now, accounts, defaultAccountId: context.formDefaultAccountId, hasArchived: context.archived.length > 0, autosaveScope: autosaveScope(user.id) };
}

const NOT_EDITABLE_COPY = {
  ORIGIN: (origin: string) => `${origin} trades have no pre-trade draft to edit. Missing entry details can be added on the trade page.`,
  DISCARDED: "This draft was discarded, so it can't be edited. Duplicate it from the trade page to plan it again.",
  SKIPPED: "This draft was skipped, so it can't be edited. Duplicate it from the trade page to plan it again.",
  NO_REVISION: "This draft has no saved revision to edit.",
} as const;

function notEditable(detail: TradeDetail): NotEditable | null {
  const base = { tradeId: detail.tradeId, title: detail.title, stateLabel: detail.state.label, stateTone: detail.state.tone };
  if (detail.origin !== "PLANNED") return { ...base, reason: NOT_EDITABLE_COPY.ORIGIN(detail.state.originLabel) };
  if (detail.plan !== null || detail.state.immutableNote) return { ...base, reason: detail.state.immutableNote ?? LOCKED_PLAN_NOTE };
  if (detail.state.lifecycle === "DISCARDED") return { ...base, reason: NOT_EDITABLE_COPY.DISCARDED };
  if (detail.state.lifecycle !== "DRAFT") return { ...base, reason: NOT_EDITABLE_COPY.SKIPPED };
  if (!detail.draft) return { ...base, reason: NOT_EDITABLE_COPY.NO_REVISION };
  return null;
}

function existingEvidence(detail: TradeDetail): ExistingEvidence[] {
  return detail.evidence.items
    .filter(item => item.removedAt === null)
    .map(item => ({
      id: item.id,
      name: item.name,
      tag: isEvidenceLabel(item.label) ? evidenceTagText(item.label, isTimeframe(item.timeframe) ? item.timeframe : null) : item.name,
      thumbSrc: item.thumbSrc,
      recordedAt: item.recordedAt,
    }));
}

/**
 * Edit Draft: the latest revision of a draft the user owns, or why it can't be edited; null when the trade is not the
 * user's (the page answers 404). A revision whose contract was superseded by a newer version of the same symbol is
 * prefilled with the current version, and its contract confirmation is cleared: the values to confirm changed.
 */
export async function loadEditDraft(tradeId: string): Promise<{ kind: "draft"; data: EditDraftData } | { kind: "not-editable"; data: NotEditable } | null> {
  const [detail, { user }] = await Promise.all([getTradeDetail(tradeId), currentSession()]);
  if (!detail) return null;
  const blocked = notEditable(detail);
  const draft = detail.draft;
  if (blocked || !draft) {
    const reason = { tradeId: detail.tradeId, title: detail.title, stateLabel: detail.state.label, stateTone: detail.state.tone, reason: NOT_EDITABLE_COPY.NO_REVISION };
    return { kind: "not-editable", data: blocked ?? reason };
  }
  const workspace = await getAccountWorkspace(detail.account.id);
  if (!workspace) return null;
  const account = formAccount(workspace);
  const proposal = draft.proposal;
  const storedId = proposal.instrumentVersionId?.toLowerCase() ?? null;
  let instrumentId = storedId !== null && account.instruments.some(item => item.id.toLowerCase() === storedId) ? storedId : null;
  let contractUpdated: EditDraftData["contractUpdated"] = null;
  if (storedId !== null && instrumentId === null) {
    const symbol = detail.instrument?.symbol ?? detail.symbol;
    const current = symbol ? account.instruments.find(item => item.symbol === symbol) : undefined;
    if (current && symbol) {
      instrumentId = current.id;
      contractUpdated = { symbol };
    }
  }
  const prefill: DraftPrefill = {
    instrumentId,
    direction: proposal.direction,
    model: proposal.model,
    entry: proposal.entry,
    stop: proposal.stop,
    target: proposal.target,
    riskPercent: proposal.riskPercent,
    narrative: proposal.narrative,
    contractConfirmed: contractUpdated ? false : proposal.contractConfirmed,
    news: proposal.news,
    contradiction: proposal.contradiction,
  };
  const ofRevision = detail.ai.history?.preTrade.find(group => group.number === draft.revision)?.rows ?? [];
  return {
    kind: "draft",
    data: {
      now: workspace.now,
      tradeId: detail.tradeId,
      title: detail.title,
      revision: draft.revision,
      expectedRevision: draft.expectedRevision,
      stateLabel: detail.state.label,
      stateTone: detail.state.tone,
      account,
      archived: detail.account.status === "ARCHIVED",
      prefill,
      contractUpdated,
      evidence: existingEvidence(detail),
      evidenceCapacity: Math.max(0, detail.evidence.limit - detail.evidence.activeCount),
      aiAnalysesOfRevision: ofRevision.filter(row => row.status !== "FAILED").length,
      autosaveScope: autosaveScope(user.id),
    },
  };
}
