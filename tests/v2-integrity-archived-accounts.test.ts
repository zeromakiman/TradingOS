import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import type { ExternalPosition } from "@/domain/sync/contract";
import { MOCK_POSITIONS } from "@/domain/sync/mock-provider";
import { normalizeExternalPosition } from "@/domain/sync/normalize";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// "Archiving hides the account from new trades; history stays." (docs/V2_ARCHITECTURE.md §3.2, §9, §14.9). The
// database enforces it, not only the forms: while the latest profile revision is ARCHIVED, every RPC that would start
// new activity on the account refuses with ACCOUNT_ARCHIVED (new trades of every origin, draft revisions, risk checks,
// locks, external losses, account values, connections, imported trades) and writes nothing. The trades the account
// already holds can still be finished, its history stays readable, replays of earlier requests still answer, and a
// restore re-enables everything. Ownership is checked first: another user never learns that an account is archived.

type Json = Record<string, unknown>;
interface DraftEnvelope { tradeId: string; proposalId: string; revision: number; result: { decision: string } }
interface CheckEnvelope { planId: string | null; replayed: boolean }
interface IngestEnvelope { outcome: string; executionId: string; tradeId: string | null }

const ARCHIVED = /^ACCOUNT_ARCHIVED: /;
// Distinct prices keep plans of one account and day clear of the DUPLICATE rule.
const SECOND = { entry: "1.2", stop: "1.198", target: "1.206" };
const THIRD = { entry: "1.3", stop: "1.298", target: "1.306" };

let db: TestDatabase;

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}

const proposal = (a: BootstrappedAccount, changes: Json = {}) => ({
  ...previewProposal, instrumentId: a.instrumentId, narrative: "Archived account fixture", contractConfirmed: true, news: "CLEAR", ...changes,
});

async function setStatus(accountId: string, status: "ACTIVE" | "ARCHIVED", user = OWNER): Promise<number> {
  await db.actor(user);
  return value<number>("select public.update_account_profile($1, $2::jsonb) as value", [accountId, JSON.stringify({ status })]);
}

async function createDraft(a: BootstrappedAccount, key: string = randomUUID(), changes: Json = {}): Promise<DraftEnvelope> {
  await db.actor(OWNER);
  return value<DraftEnvelope>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
    [a.accountId, JSON.stringify(proposal(a, changes)), key, a.riskId, a.observationId]);
}

async function lock(tradeId: string, revision = 1): Promise<CheckEnvelope> {
  await db.actor(OWNER);
  return value<CheckEnvelope>("select public.lock_trade($1, $2) as value", [tradeId, revision]);
}

async function liveTrade(a: BootstrappedAccount, input: Json, key: string = randomUUID()): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify(input), key]);
}

async function externalLoss(a: BootstrappedAccount, amount: string, note: string | null, key: string = randomUUID()): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select public.add_external_loss($1, $2, $3, $4) as value", [a.accountId, amount, note, key]);
}

async function lifecycle(tradeId: string): Promise<string> {
  await db.actor(OWNER);
  return value<string>("select lifecycle as value from public.trade_ledger where id = $1", [tradeId]);
}

/** Every kind of record a new activity would add to the account, counted as the superuser (RLS and grants aside). */
async function activity(accountId: string): Promise<Record<string, number>> {
  await db.admin();
  const { rows } = await db.query<Record<string, number>>(`select
      (select count(*)::int from public.trades where account_id = $1) as trades,
      (select count(*)::int from public.trade_revisions where account_id = $1) as revisions,
      (select count(*)::int from public.setup_proposals where account_id = $1) as proposals,
      (select count(*)::int from public.setup_risk_checks where account_id = $1) as risk_checks,
      (select count(*)::int from public.risk_evaluations where account_id = $1) as evaluations,
      (select count(*)::int from public.trade_plans where account_id = $1) as plans,
      (select count(*)::int from public.trade_position_facts where account_id = $1) as facts,
      (select count(*)::int from public.external_loss_entries where account_id = $1) as losses,
      (select count(*)::int from public.account_observations where account_id = $1) as observations,
      (select count(*)::int from public.platform_connections where account_id = $1) as connections,
      (select count(*)::int from public.platform_connection_events where account_id = $1) as connection_events,
      (select count(*)::int from public.external_executions where account_id = $1) as executions,
      (select count(*)::int from public.daily_contexts where account_id = $1) as daily_notes,
      (select count(*)::int from public.ai_preference_events where account_id = $1) as ai_settings`, [accountId]);
  return rows[0];
}

/** The RPCs that start new activity on account `a`, given a draft of it made while it was active. */
function newActivity(a: BootstrappedAccount, draft: DraftEnvelope): [string, string, unknown[]][] {
  return [
    ["create a planned trade", "select public.create_planned_trade($1, $2::jsonb, $3, $4, $5)", [a.accountId, JSON.stringify(proposal(a, SECOND)), randomUUID(), a.riskId, a.observationId]],
    ["record a live trade", "select public.record_live_trade($1, $2::jsonb, $3)", [a.accountId, JSON.stringify({ symbol: "XAUUSD", direction: "LONG" }), randomUUID()]],
    ["duplicate a draft", "select public.duplicate_trade_draft($1, $2, $3, $4)", [draft.tradeId, randomUUID(), a.riskId, a.observationId]],
    ["revise a draft", "select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5)", [draft.tradeId, JSON.stringify(proposal(a, THIRD)), randomUUID(), a.riskId, a.observationId]],
    ["check a draft", "select public.check_trade_risk($1)", [draft.tradeId]],
    ["lock a draft", "select public.lock_trade($1, 1)", [draft.tradeId]],
    ["check through the V1 entry point", "select public.check_setup_risk($1, false)", [draft.proposalId]],
    ["lock through the V1 entry point", "select public.check_setup_risk($1, true)", [draft.proposalId]],
    // V1 save_setup_proposal stays granted (§10.4) and persists a risk check: it is new activity too.
    ["save a proposal through the V1 entry point", "select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5)", [a.accountId, JSON.stringify(proposal(a, THIRD)), randomUUID(), a.riskId, a.observationId]],
    ["add an external loss", "select public.add_external_loss($1, '10', null, $2)", [a.accountId, randomUUID()]],
    ["record account values", "select public.record_account_values($1, '10000', '10000')", [a.accountId]],
    ["connect a platform", "select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2)", [a.accountId, randomUUID()]],
    // V1 save_daily_context (Today's plan · notes) and set_account_ai_preferences (Settings → AI) stay granted (§10.4):
    // a new notes revision, turning AI on and a new monthly limit are new records too. (Turning AI off is not: below.)
    ["save today's notes through the V1 entry point", "select public.save_daily_context($1, 'Notes after archiving')", [a.accountId]],
    ["turn AI on through the V1 entry point", "select public.set_account_ai_preferences($1, true, null, true)", [a.accountId]],
    ["change the AI limit through the V1 entry point", "select public.set_account_ai_preferences($1, null, 1000, false)", [a.accountId]],
  ];
}

/** V1 `Account not found` (no code prefix) of the V1 entry points that take an account id and no request key. */
const V1_ACCOUNT_ENTRY = /public\.(save_daily_context|set_account_ai_preferences)\(/;

async function aiSettings(accountId: string, enabled: boolean | null, budgetCents: number | null, confirm = false): Promise<void> {
  await db.actor(OWNER);
  await db.query("select public.set_account_ai_preferences($1, $2, $3, $4)", [accountId, enabled, budgetCents, confirm]);
}

async function aiEvents(accountId: string): Promise<Json[]> {
  await db.admin();
  return (await db.query<Json>(`select previous_enabled, enabled, previous_budget_cents, budget_cents, consent_version
      from public.ai_preference_events where account_id = $1 order by id`, [accountId])).rows;
}

async function dailyNotes(accountId: string): Promise<string[]> {
  await db.admin();
  return (await db.query<{ narrative: string }>("select narrative from public.daily_contexts where account_id = $1 order by recorded_at, id", [accountId]))
    .rows.map(row => row.narrative);
}

/** The trusted server's reservation of one AI request (0008): what an account with AI on can still spend. */
async function reserveAi(accountId: string): Promise<void> {
  await db.actor(OWNER, "service_role");
  await db.query("select public.reserve_account_ai_request($1, $2, $3, $4, 'A', $5, 'gpt-6-astra', '{}', 10000, 'TRADE_REVIEW', 'openai')",
    [randomUUID(), OWNER, accountId, randomUUID(), "a".repeat(64)]);
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function position(changes: Json = {}): ExternalPosition {
  const result = normalizeExternalPosition({ ...MOCK_POSITIONS[0], ...changes });
  if (!result.ok) throw new Error(result.error);
  return result.position;
}
const openPosition = (changes: Json = {}) => position({ exitPrice: null, exitedAt: null, commission: null, swap: null, realizedPnl: null, ...changes });

async function ingest(connectionId: string, payload: ExternalPosition, decision: Json = { kind: "CREATE" }): Promise<IngestEnvelope> {
  // The trusted server's secret key carries no user id.
  await db.actor("", "service_role");
  return value<IngestEnvelope>("select public.ingest_external_execution($1, $2, $3::jsonb, $4::jsonb) as value",
    [OWNER, connectionId, JSON.stringify(payload), JSON.stringify(decision)]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // A deterministic eligible session for the locks; production RPCs keep clock_timestamp().
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

describe("archived trading accounts take no new activity (§3.2, §14.9)", () => {
  it("refuses every new trade, revision, check, lock and account record, and writes nothing", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await setStatus(a.accountId, "ARCHIVED");
    const before = await activity(a.accountId);
    await db.actor(OWNER);
    for (const [what, sql, params] of newActivity(a, draft)) {
      await expect(db.query(sql, params), what).rejects.toThrow(ARCHIVED);
    }
    expect(await activity(a.accountId)).toEqual(before);
    // The draft is history: readable, unchanged, still a draft of revision 1.
    await db.actor(OWNER);
    expect((await db.query<Json>("select lifecycle, latest_revision, plan_id from public.trade_ledger where id = $1", [draft.tradeId])).rows[0])
      .toEqual({ lifecycle: "DRAFT", latest_revision: 1, plan_id: null });
  });

  it("still answers replays of requests made while the account was active, writing nothing", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const keys = { draft: randomUUID(), live: randomUUID(), loss: randomUUID(), connection: randomUUID(), proposal: randomUUID() };
    const draft = await createDraft(a, keys.draft);
    const locked = await createDraft(a, randomUUID(), SECOND);
    const plan = await lock(locked.tradeId);
    expect(plan.planId).toBeTruthy();
    const live = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" }, keys.live);
    const loss = await externalLoss(a, "25", "Other platform", keys.loss);
    await db.actor(OWNER);
    const connection = await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, keys.connection]);
    const saveV1 = () => value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a, THIRD)), keys.proposal, a.riskId, a.observationId]);
    const v1Proposal = await saveV1();
    await setStatus(a.accountId, "ARCHIVED");
    const before = await activity(a.accountId);

    expect(await createDraft(a, keys.draft)).toEqual(draft);
    expect(await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" }, keys.live)).toBe(live);
    expect(await externalLoss(a, "25", "Other platform", keys.loss)).toBe(loss);
    await db.actor(OWNER);
    expect(await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, keys.connection])).toBe(connection);
    expect(await lock(locked.tradeId)).toMatchObject({ planId: plan.planId, replayed: true });
    await db.actor(OWNER);
    expect(await value<CheckEnvelope>("select public.check_setup_risk($1, true) as value", [locked.proposalId])).toMatchObject({ planId: plan.planId, replayed: true });
    expect(await saveV1()).toBe(v1Proposal);
    // A replay with other values is still a conflict, never a way around the archive.
    await expect(createDraft(a, keys.draft, THIRD)).rejects.toThrow(/^IDEMPOTENCY_CONFLICT:/);
    expect(await activity(a.accountId)).toEqual(before);
  });

  it("lets the trades it already holds finish, and keeps its history readable", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const taken = await createDraft(a);
    expect((await lock(taken.tradeId)).planId).toBeTruthy();
    const skipped = await createDraft(a, randomUUID(), SECOND);
    expect((await lock(skipped.tradeId)).planId).toBeTruthy();
    const leftover = await createDraft(a, randomUUID(), THIRD);
    const live = await liveTrade(a, { symbol: "XAUUSD", direction: "SHORT" });
    const loss = await externalLoss(a, "40", "Entered on the wrong account");
    await setStatus(a.accountId, "ARCHIVED");

    await db.actor(OWNER);
    // A plan locked while the account was active: the fill, the close and the review.
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [taken.tradeId]);
    await db.query("select public.add_journal_entry($1, 'NOTE', 'Managing the position after archiving', '{}'::jsonb, $2)", [taken.tradeId, randomUUID()]);
    await db.query("select public.close_planned_trade($1, '1.104', clock_timestamp(), '0')", [taken.tradeId]);
    await db.query("select public.set_trade_tags($1, 'A', null, null, array['archived'])", [taken.tradeId]);
    await db.query("select public.complete_trade_review($1, null)", [taken.tradeId]);
    // Plans and drafts that end without a trade.
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'Account archived')", [skipped.tradeId]);
    await db.query("select public.discard_trade_draft($1, 'Account archived', null)", [leftover.tradeId]);
    // A live-first position: missing details, a screenshot, the close.
    await db.query("select public.complete_live_entry($1, '{\"entryPrice\":\"2400.5\"}'::jsonb, $2)", [live, randomUUID()]);
    await db.actor(OWNER, "service_role");
    await db.query("select public.register_trade_evidence($1, $2::jsonb)", [OWNER, JSON.stringify({
      id: randomUUID(), tradeId: live, label: "EXIT", timeframe: "M5", originalFilename: "exit.png", mimeType: "image/png", byteSize: 2048,
      sha256: "b".repeat(64), width: 1280, height: 720, captureMethod: "PASTE",
    })]);
    await db.actor(OWNER);
    await db.query("select public.close_live_trade($1, $2::jsonb)", [live, JSON.stringify({ exitedAt: ago(1), netPnl: "-12.50" })]);
    // Corrections of its records and its profile.
    await db.query("select public.remove_external_loss($1, 'Duplicate entry')", [loss]);
    await db.query("select public.update_account_profile($1, '{\"displayName\":\"Old challenge\"}'::jsonb)", [a.accountId]);

    expect(await lifecycle(taken.tradeId)).toBe("REVIEWED");
    expect(await lifecycle(skipped.tradeId)).toBe("SKIPPED");
    expect(await lifecycle(leftover.tradeId)).toBe("DISCARDED");
    expect(await lifecycle(live)).toBe("CLOSED");
    await db.actor(OWNER);
    expect(await value<string>("select status as value from public.account_profiles where account_id = $1 order by id desc limit 1", [a.accountId])).toBe("ARCHIVED");
    expect(await value<string>("select (public.get_daily_risk_usage($1) ->> 'externalLoss') as value", [a.accountId])).toBe("0");
  });

  it("re-enables new activity once the account is restored", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await setStatus(a.accountId, "ARCHIVED");
    await expect(lock(draft.tradeId)).rejects.toThrow(ARCHIVED);
    await setStatus(a.accountId, "ACTIVE");
    expect(await value<string>("select status as value from public.account_profiles where account_id = $1 order by id desc limit 1", [a.accountId])).toBe("ACTIVE");

    expect(await createDraft(a, randomUUID(), SECOND)).toMatchObject({ revision: 1 });
    await db.actor(OWNER);
    expect(await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [draft.tradeId, randomUUID(), a.riskId, a.observationId]))
      .toMatchObject({ tradeId: expect.any(String) });
    expect(await value<DraftEnvelope>("select public.revise_trade_draft($1, $2::jsonb, $3, 1, $4, $5) as value",
      [draft.tradeId, JSON.stringify(proposal(a, THIRD)), randomUUID(), a.riskId, a.observationId])).toMatchObject({ revision: 2 });
    expect(await value<Json>("select public.check_trade_risk($1) as value", [draft.tradeId])).toMatchObject({ tradeId: draft.tradeId });
    expect((await lock(draft.tradeId, 2)).planId).toBeTruthy();
    expect(await liveTrade(a, { symbol: "XAUUSD", direction: "LONG" })).toEqual(expect.any(String));
    expect(await externalLoss(a, "10", null)).toEqual(expect.any(String));
    await db.actor(OWNER);
    expect(await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, randomUUID()])).toEqual(expect.any(String));
    // Saved against the account values of the bootstrap, which the next call replaces.
    expect(await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value",
      [a.accountId, JSON.stringify(proposal(a, { entry: "1.4", stop: "1.398", target: "1.406" })), randomUUID(), a.riskId, a.observationId])).toEqual(expect.any(String));
    expect(await value<string>("select public.record_account_values($1, '10000', '10000') as value", [a.accountId])).toEqual(expect.any(String));
    // Archiving again refuses again: the latest profile revision decides.
    await setStatus(a.accountId, "ARCHIVED");
    await expect(createDraft(a)).rejects.toThrow(ARCHIVED);
  });

  it("checks ownership first: another user meets the not-found errors, never the archive", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await setStatus(a.accountId, "ARCHIVED");
    const mine = await db.bootstrapAccount(OTHER);
    await db.actor(OTHER);
    for (const [what, sql, params] of newActivity(a, draft)) {
      const expected = what.startsWith("save a proposal") ? /^Account not found or missing request key/
        : V1_ACCOUNT_ENTRY.test(sql) ? /^Account not found$/
        : what.includes("V1") ? /^Proposal not found/ : params[0] === a.accountId ? /^ACCOUNT_NOT_FOUND:/ : /^TRADE_NOT_FOUND:/;
      await expect(db.query(sql, params), what).rejects.toThrow(expected);
    }
    // Nobody else can restore (or archive) the account.
    await expect(setStatus(a.accountId, "ACTIVE", OTHER)).rejects.toThrow(/^ACCOUNT_NOT_FOUND:/);
    // The other user's own account is unaffected by this archive.
    await db.actor(OTHER);
    const theirs = await value<DraftEnvelope>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value",
      [mine.accountId, JSON.stringify(proposal(mine)), randomUUID(), mine.riskId, mine.observationId]);
    expect(theirs.revision).toBe(1);
    // The guard itself is reachable only from the database's own functions.
    await db.actor(OWNER);
    await expect(db.query("select private.require_active_account($1)", [a.accountId])).rejects.toThrow(/permission denied/);
  });

  it("imports no new trade into an archived account, while positions it already imported keep syncing", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await db.actor(OWNER);
    const connection = await value<string>("select public.create_platform_connection($1, 'MOCK', 'Mock platform', $2) as value", [a.accountId, randomUUID()]);
    const open = openPosition({ enteredAt: ago(120) });
    const imported = await ingest(connection, open);
    expect(imported.outcome).toBe("CREATED");
    await setStatus(a.accountId, "ARCHIVED");
    const before = await activity(a.accountId);

    await expect(ingest(connection, openPosition({ externalId: "MOCK-2001", enteredAt: ago(60) }))).rejects.toThrow(ARCHIVED);
    expect(await activity(a.accountId)).toEqual(before);
    // The imported position closes on the platform: its trade is finished, as any open trade may be.
    const closed = await ingest(connection, position({ externalId: open.externalId, enteredAt: open.enteredAt, exitedAt: ago(10) }));
    expect(closed).toMatchObject({ outcome: "CLOSED", tradeId: imported.tradeId });
    expect(await lifecycle(String(imported.tradeId))).toBe("CLOSED");
    // A position held for the trader to link creates no trade.
    expect(await ingest(connection, openPosition({ externalId: "MOCK-2002", enteredAt: ago(30) }), { kind: "HOLD" })).toMatchObject({ outcome: "HELD", tradeId: null });
    expect((await activity(a.accountId)).trades).toBe(before.trades);
  });
});

describe("the V1 notes and AI-settings entry points on an archived account (§3.2, §10.4, §11.2)", () => {
  it("refuses today's notes while archived and saves them again once restored; every save stays a new revision", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const save = async (narrative: string) => {
      await db.actor(OWNER);
      return value<string>("select public.save_daily_context($1, $2) as value", [a.accountId, narrative]);
    };
    // No request key: the same text saved twice is two revisions, as in V1.
    const first = await save("Bias: short");
    expect(await save("Bias: short")).not.toBe(first);
    expect(await dailyNotes(a.accountId)).toEqual(["Bias: short", "Bias: short"]);

    await setStatus(a.accountId, "ARCHIVED");
    const before = await activity(a.accountId);
    await expect(save("Bias: long")).rejects.toThrow(ARCHIVED);
    await expect(save("")).rejects.toThrow(ARCHIVED);
    expect(await activity(a.accountId)).toEqual(before);

    await setStatus(a.accountId, "ACTIVE");
    expect(await save("Bias: long")).toEqual(expect.any(String));
    expect(await dailyNotes(a.accountId)).toEqual(["Bias: short", "Bias: short", "Bias: long"]);
  });

  it("lets an archived account turn AI off, and changes nothing else of its AI settings until it is restored", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await aiSettings(a.accountId, true, 500, true);
    await aiSettings(a.accountId, null, 1000);
    await setStatus(a.accountId, "ARCHIVED");
    // An archived account with AI on can still run AI (§11): its trader must be able to stop that.
    await reserveAi(a.accountId);
    const before = await activity(a.accountId);

    // A call that changes nothing still answers and writes nothing, as before (the form submitted twice).
    await aiSettings(a.accountId, true, null, true);
    await aiSettings(a.accountId, null, 1000);
    // Any other change is new activity: refused, also when it is combined with turning AI off.
    await expect(aiSettings(a.accountId, null, 300)).rejects.toThrow(ARCHIVED);
    await expect(aiSettings(a.accountId, false, 300)).rejects.toThrow(ARCHIVED);
    expect(await activity(a.accountId)).toEqual(before);

    // Turning AI off withdraws the consent and stops the spending; the limit stays as it was.
    await aiSettings(a.accountId, false, null);
    expect((await aiEvents(a.accountId)).at(-1)).toEqual({ previous_enabled: true, enabled: false, previous_budget_cents: 1000, budget_cents: 1000, consent_version: null });
    await expect(reserveAi(a.accountId)).rejects.toThrow(/Account AI is OFF/);
    await aiSettings(a.accountId, false, null);
    // Turning it on again, with or without a new limit, waits for the restore.
    await expect(aiSettings(a.accountId, true, null, true)).rejects.toThrow(ARCHIVED);
    await expect(aiSettings(a.accountId, true, 1000, true)).rejects.toThrow(ARCHIVED);
    await expect(aiSettings(a.accountId, null, 500)).rejects.toThrow(ARCHIVED);
    expect(await aiEvents(a.accountId)).toHaveLength(3);
    await db.actor(OWNER);
    expect(await value<Json>("select public.get_account_ai_budget($1) as value", [a.accountId])).toMatchObject({ enabled: false, budgetCents: 1000 });

    // Restored, every setting changes again, under the same consent rule as before.
    await setStatus(a.accountId, "ACTIVE");
    await expect(aiSettings(a.accountId, true, null, false)).rejects.toThrow(/^Explicit AI disclosure confirmation required/);
    await aiSettings(a.accountId, true, null, true);
    await aiSettings(a.accountId, null, 300);
    expect((await aiEvents(a.accountId)).slice(3)).toEqual([
      { previous_enabled: false, enabled: true, previous_budget_cents: 1000, budget_cents: 1000, consent_version: "AI_DISCLOSURE_V1" },
      { previous_enabled: true, enabled: true, previous_budget_cents: 1000, budget_cents: 300, consent_version: "AI_DISCLOSURE_V1" },
    ]);
  });

  it("checks ownership before the archive: another user's turn-off is not found", async () => {
    const a = await db.bootstrapAccount(OWNER);
    await aiSettings(a.accountId, true, 500, true);
    await setStatus(a.accountId, "ARCHIVED");
    await db.bootstrapAccount(OTHER);
    await db.actor(OTHER);
    await expect(db.query("select public.set_account_ai_preferences($1, false, null, false)", [a.accountId])).rejects.toThrow(/^Account not found$/);
    await expect(db.query("select public.save_daily_context($1, 'x')", [a.accountId])).rejects.toThrow(/^Account not found$/);
    expect(await aiEvents(a.accountId)).toHaveLength(1);
  });
});

describe("every V1 entry point still granted to authenticated has its archived-account rule (§3.2, §10.4)", () => {
  /**
   * The RPCs migrations 0001–0014 grant to authenticated that the final schema still grants, and what each does on an
   * archived account: REFUSES new records (ACCOUNT_ARCHIVED, redefined in 0015; set_account_ai_preferences still turns
   * AI off), FINISHES the trades the account already holds (like the V2 entry, close, skip, journal, screenshot and
   * tag RPCs), READS, or creates a NEW account (no account to be archived). A V1 RPC granted again later fails here
   * until its rule is decided.
   */
  const V1_GRANTED: Readonly<Record<string, "REFUSES" | "FINISHES" | "READS" | "NEW_ACCOUNT">> = {
    save_setup_proposal: "REFUSES", check_setup_risk: "REFUSES", save_daily_context: "REFUSES", set_account_ai_preferences: "REFUSES",
    open_journal_trade: "FINISHES", close_journal_trade: "FINISHES", set_journal_disposition: "FINISHES", tag_journal_trade: "FINISHES",
    append_plan_note: "FINISHES", remove_setup_screenshot: "FINISHES",
    get_account_ai_budget: "READS",
    bootstrap_demo_account: "NEW_ACCOUNT",
  };
  const grantedToAuthenticated = async (database: TestDatabase) => {
    await database.admin();
    const { rows } = await database.query<{ name: string }>(`select distinct p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`);
    return rows.map(row => row.name);
  };

  it("lists exactly the V1 RPCs the final schema still grants", async () => {
    const v1 = await createTestDatabase();
    try {
      await v1.applyMigrations({ upTo: "0014" });
      const before = new Set(await grantedToAuthenticated(v1));
      expect((await grantedToAuthenticated(db)).filter(name => before.has(name))).toEqual(Object.keys(V1_GRANTED).sort());
    } finally {
      await v1.close();
    }
  }, 60_000);

  it("lets the V1 entry points finish a plan the archived account already holds", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const taken = await createDraft(a);
    const takenPlan = (await lock(taken.tradeId)).planId;
    const skipped = await createDraft(a, randomUUID(), SECOND);
    const skippedPlan = (await lock(skipped.tradeId)).planId;
    await setStatus(a.accountId, "ARCHIVED");
    await db.actor(OWNER);
    await db.query("select public.open_journal_trade($1, '1.1', '0.25', clock_timestamp())", [takenPlan]);
    await db.query("select public.append_plan_note($1, 'Managed after archiving', $2)", [takenPlan, randomUUID()]);
    await db.query("select public.tag_journal_trade($1, 'A', null, null)", [takenPlan]);
    await db.query("select public.close_journal_trade($1, '1.104', clock_timestamp(), '0')", [takenPlan]);
    await db.query("select public.set_journal_disposition($1, 'SKIPPED', 'Account archived')", [skippedPlan]);
    expect(await lifecycle(taken.tradeId)).toBe("CLOSED");
    expect(await lifecycle(skipped.tradeId)).toBe("SKIPPED");
  });
});
