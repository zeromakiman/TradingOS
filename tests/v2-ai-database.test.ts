import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEDGER_COLUMNS } from "@/domain/ledger";
import { type BootstrappedAccount, createTestDatabase, OTHER, OWNER, type TestDatabase } from "./helpers/pglite";

// docs/V2_ARCHITECTURE.md §11.3 (pre-trade AI on V2 drafts) and §11.4 (timeline-aware trade review), migration 0018.

type Json = Record<string, unknown>;
interface DraftEnvelope { tradeId: string; proposalId: string; revision: number }
interface LedgerDefinition { definition: string; options: string[] | null; columns: string[] }

let db: TestDatabase;
let owner: BootstrappedAccount;
let other: BootstrappedAccount;
/** public.trade_ledger as the migrations before 0018 leave it, and as 0018 leaves it. */
let ledgerBefore: LedgerDefinition;
let ledgerAfter: LedgerDefinition;

const HASH = "a".repeat(64);
const sha = (seed: string) => seed.repeat(64).slice(0, 64);

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}

async function rejects(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(run()).rejects.toThrow(pattern);
}

async function ledgerDefinition(): Promise<LedgerDefinition> {
  await db.admin();
  const { rows } = await db.query<LedgerDefinition>(`
    select pg_get_viewdef(c.oid) as definition, c.reloptions as options,
           array(select a.attname || ' ' || format_type(a.atttypid, a.atttypmod) from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum) as columns
      from pg_class c where c.oid = 'public.trade_ledger'::regclass`);
  return rows[0];
}

/** The select expression of trade_ledger.ai_review_count, and the whole definition without it. */
function aroundAiReviewCount(definition: string): { expression: string; rest: string } {
  const match = /AS journal_count,\s*([\s\S]+?) AS ai_review_count\b/.exec(definition);
  if (!match) throw new Error("trade_ledger.ai_review_count not found");
  const start = match.index + match[0].indexOf(match[1]);
  return { expression: match[1], rest: definition.slice(0, start) + definition.slice(start + match[1].length) };
}

const proposal = (a: BootstrappedAccount, changes: Json = {}) => JSON.stringify({
  instrumentId: a.instrumentId, direction: "LONG", model: "OB_FIRST_TOUCH", entry: "1.10000", stop: "1.09800", target: "1.10600", riskPercent: "0.5",
  narrative: "Synthetic draft: Asian low swept, waiting for the M5 order block.", contractConfirmed: true, news: "CLEAR", contradiction: false, ...changes,
});

async function draft(user = OWNER, a = owner, changes: Json = {}): Promise<DraftEnvelope> {
  await db.actor(user);
  return value<DraftEnvelope>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [a.accountId, proposal(a, changes), randomUUID(), a.riskId, a.observationId]);
}

async function revise(tradeId: string, expected: number, a = owner, changes: Json = {}): Promise<DraftEnvelope> {
  await db.actor(OWNER);
  return value<DraftEnvelope>("select public.revise_trade_draft($1, $2::jsonb, $3, $4, $5, $6) as value",
    [tradeId, proposal(a, changes), randomUUID(), expected, a.riskId, a.observationId]);
}

/** Locking reserves one of the account's two daily slots, so every locked trade gets its own synthetic account. */
async function freshAccount(): Promise<BootstrappedAccount> {
  const a = await db.bootstrapAccount(OWNER, { name: `Lock account ${randomUUID().slice(0, 8)}` });
  await db.actor(OWNER);
  await db.query("select public.set_account_ai_preferences($1, true, 500, true)", [a.accountId]);
  return a;
}

async function register(tradeId: string, digest: string, options: { id?: string; user?: string; label?: string } = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  await db.actor(options.user ?? OWNER, "service_role");
  await db.query("select public.register_trade_evidence($1, $2::jsonb)", [options.user ?? OWNER, JSON.stringify({
    id, tradeId, label: options.label ?? "PRE_ENTRY", timeframe: "M5", originalFilename: "chart.png", mimeType: "image/png", byteSize: 10, sha256: digest, width: 10, height: 10, captureMethod: "PASTE",
  })]);
  return id;
}

async function legacyScreenshot(proposalId: string, digest: string, a = owner): Promise<string> {
  const id = randomUUID();
  await db.admin();
  await db.query(`insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size, sha256, width, height)
    values ($1, $2, $3, $4, 'H1', $5, 'legacy.png', 'image/png', 10, $6, 10, 10)`, [id, OWNER, a.accountId, proposalId, `${OWNER}/${proposalId}/${id}`, digest]);
  return id;
}

// --- pre-trade requests (0010 RPCs replaced in 0018) ---------------------------------------------------------
async function startChallenge(proposalId: string, options: { operation?: string; evidence?: { id: string; sha256: string }[]; id?: string; user?: string } = {}) {
  const id = options.id ?? randomUUID();
  await db.actor(OWNER, "service_role");
  const started = await value<boolean>("select public.start_bias_challenge($1, $2, $3, $4::jsonb, $5, $6::jsonb, '{}') as value",
    [id, options.user ?? OWNER, proposalId, JSON.stringify({ selectedEvidence: options.evidence ?? [] }), HASH, JSON.stringify({ id: options.operation ?? "ANALYZE_SETUP" })]);
  return { id, started };
}
async function authorizeChallenge(id: string): Promise<void> {
  await db.actor(OWNER, "service_role");
  await db.query("select public.authorize_bias_challenge($1, $2)", [id, OWNER]);
}
async function finishChallenge(id: string, reservation: string | null = null): Promise<void> {
  await db.actor(OWNER, "service_role");
  if (reservation) await db.query(`select public.finish_bias_challenge($1, $2, 'COMPLETED', '{"ok":true}', null, null, $3)`, [id, OWNER, reservation]);
  else await db.query("select public.finish_bias_challenge($1, $2, 'FAILED', null, 'MOCK_FAILURE', null, null)", [id, OWNER]);
}

// --- accounting ------------------------------------------------------------------------------------------------
async function reserve(operationId: string, operation: string, options: { dispatch?: boolean; settle?: "SETTLED" | "CANCELLED" | null; account?: BootstrappedAccount } = {}): Promise<string> {
  const id = randomUUID();
  await db.actor(OWNER, "service_role");
  await db.query("select public.reserve_account_ai_request($1, $2, $3, $4, 'A', $5, 'gpt-5.4-mini', '{}', 47520, $6, 'openai')",
    [id, OWNER, (options.account ?? owner).accountId, operationId, HASH, operation]);
  if (options.settle === "CANCELLED") {
    await db.query(`select public.settle_account_ai_request($1, $2, '{"disposition":"CANCELLED","chargedMicros":0,"errorCode":"NOT_DISPATCHED"}')`, [id, OWNER]);
    return id;
  }
  if (options.dispatch ?? true) await db.query("select public.dispatch_account_ai_request($1, $2, $3)", [id, OWNER, HASH]);
  if ((options.settle === undefined ? "SETTLED" : options.settle) === "SETTLED") {
    await db.query(`select public.settle_account_ai_request($1, $2, '{"disposition":"SETTLED","chargedMicros":21000,"inputTokens":9000,"outputTokens":900,"usage":{"input_tokens":9000,"output_tokens":900}}')`, [id, OWNER]);
  }
  return id;
}

// --- trades ----------------------------------------------------------------------------------------------------
async function liveTrade(user = OWNER, a = owner): Promise<string> {
  await db.actor(user);
  return value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value",
    [a.accountId, JSON.stringify({ instrumentId: a.instrumentId, direction: "LONG", entryPrice: "1.1", quantity: "0.25", initialStop: "1.098" }), randomUUID()]);
}
async function closeLive(tradeId: string, user = OWNER): Promise<void> {
  await db.actor(user);
  await db.query("select public.close_live_trade($1, $2::jsonb)", [tradeId, JSON.stringify({ exitPrice: "1.104", exitedAt: new Date(Date.now() - 1000).toISOString() })]);
}
async function closedPlannedTrade(): Promise<DraftEnvelope & { planId: string }> {
  const d = await draft(OWNER, await freshAccount());
  await db.actor(OWNER);
  const locked = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [d.tradeId]);
  if (!locked.planId) throw new Error("synthetic draft was not approved");
  await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [d.tradeId]);
  await db.query("select public.close_planned_trade($1, '1.106', clock_timestamp(), '0')", [d.tradeId]);
  return { ...d, planId: locked.planId };
}

// --- timeline reviews ------------------------------------------------------------------------------------------
const facts = (tradeId: string, origin: string, planStatus: string, evidence: { id: string; sha256: string }[] = []) =>
  JSON.stringify({ version: "REVIEW_TRADE_TIMELINE_FACTS_V1", tradeId, origin, planStatus, evidence });
async function startReview(tradeId: string, reviewFacts: string, options: { id?: string; user?: string; operation?: string } = {}) {
  const id = options.id ?? randomUUID();
  await db.actor(OWNER, "service_role");
  const started = await value<boolean>("select public.start_trade_timeline_review($1, $2, $3, $4::jsonb, $5, $6::jsonb, '{}') as value",
    [id, options.user ?? OWNER, tradeId, reviewFacts, HASH, JSON.stringify({ id: options.operation ?? "REVIEW_TRADE_TIMELINE" })]);
  return { id, started };
}
async function authorizeReview(id: string, user = OWNER): Promise<void> {
  await db.actor(OWNER, "service_role");
  await db.query("select public.authorize_trade_timeline_review($1, $2)", [id, user]);
}
async function finishReview(id: string, status: "COMPLETED" | "FAILED", reservation: string | null = null): Promise<void> {
  await db.actor(OWNER, "service_role");
  await db.query("select public.finish_trade_timeline_review($1, $2, $3, $4::jsonb, $5, null, $6)",
    [id, OWNER, status, status === "COMPLETED" ? JSON.stringify({ headline: "synthetic" }) : null, status === "FAILED" ? "MOCK_FAILURE" : null, reservation]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations({ upTo: "0017" });
  ledgerBefore = await ledgerDefinition();
  expect(await db.applyMigrations({ upTo: "0018" })).toEqual(["0018_trade_ai_timeline.sql"]);
  ledgerAfter = await ledgerDefinition();
  await db.applyMigrations();
  await db.pinSession("ACTIVE_KILL_ZONE");
  other = await db.bootstrapAccount(OTHER);
  owner = await db.bootstrapAccount(OWNER);
  await db.actor(OWNER);
  await db.query("select public.set_account_ai_preferences($1, true, 500, true)", [owner.accountId]);
}, 60_000);
afterAll(async () => { await db.close(); });

describe("0018 privileges", () => {
  it("keeps every AI RPC service-only and every helper unreachable from API roles", async () => {
    await db.admin();
    const { rows } = await db.query<{ fn: string; anon: boolean; authenticated: boolean; service: boolean; definer: boolean; config: string[] }>(`
      select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated, has_function_privilege('service_role', p.oid, 'EXECUTE') as service,
             p.prosecdef as definer, coalesce(p.proconfig, '{}') as config
        from pg_proc p
       where p.oid in ('public.start_bias_challenge(uuid,uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure, 'public.authorize_bias_challenge(uuid,uuid)'::regprocedure,
                       'public.start_trade_timeline_review(uuid,uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure, 'public.authorize_trade_timeline_review(uuid,uuid)'::regprocedure,
                       'public.finish_trade_timeline_review(uuid,uuid,text,jsonb,text,jsonb,uuid)'::regprocedure,
                       'private.require_current_draft(uuid,uuid)'::regprocedure, 'private.trade_closed(uuid)'::regprocedure,
                       'private.check_timeline_review_evidence(public.trades,jsonb,timestamptz)'::regprocedure)
       order by 1`);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row, row.fn).toMatchObject({ anon: false, authenticated: false, service: !row.fn.startsWith("private."), definer: true });
      expect(row.config).toContain('search_path=""');
    }
  });

  it("lets only the owner read review history and the AI read models, and nobody write them directly", async () => {
    await db.admin();
    const grants = await db.query<{ name: string; role: string; privilege: string }>(`
      select c.relname as name, r.role, p.privilege from pg_class c
       cross join unnest(array['anon', 'authenticated', 'service_role']) as r(role)
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(privilege)
       where c.oid in ('public.trade_timeline_reviews'::regclass, 'public.trade_timeline_review_results'::regclass, 'public.trade_ai_activity'::regclass,
                       'public.trade_ledger'::regclass)
         and has_table_privilege(r.role, c.oid, p.privilege) order by 1, 2, 3`);
    expect(grants.rows).toEqual([
      { name: "trade_ai_activity", role: "authenticated", privilege: "SELECT" },
      { name: "trade_ledger", role: "authenticated", privilege: "SELECT" },
      { name: "trade_timeline_review_results", role: "authenticated", privilege: "SELECT" },
      { name: "trade_timeline_reviews", role: "authenticated", privilege: "SELECT" },
    ]);
    await db.actor(OWNER);
    await rejects(() => db.query("insert into public.trade_timeline_reviews(id) values ($1)", [randomUUID()]), /permission denied/);
    await rejects(() => db.query("select public.start_trade_timeline_review($1, $2, $3, '{}', $4, '{}', '{}')", [randomUUID(), OWNER, randomUUID(), HASH]), /permission denied/);
    await rejects(() => db.query("select public.authorize_bias_challenge($1, $2)", [randomUUID(), OWNER]), /permission denied/);
    await db.anon();
    await rejects(() => db.query("select * from public.trade_ai_activity"), /permission denied/);
    await rejects(() => db.query("select * from public.trade_ledger"), /permission denied/);
  });
});

describe("pre-trade AI on V2 drafts (start_/authorize_bias_challenge)", () => {
  it("keeps the 0010 behaviour and messages for proposals that are not V2 revisions", async () => {
    await db.actor(OWNER);
    const orphan = await value<string>("select public.save_setup_proposal($1, $2::jsonb, $3, $4, $5) as value", [owner.accountId, proposal(owner), randomUUID(), owner.riskId, owner.observationId]);
    expect(await value<number>("select count(*)::int as value from public.trade_revisions where proposal_id = $1", [orphan])).toBe(0);
    const first = await startChallenge(orphan, { operation: "CHALLENGE_BIAS" });
    expect(first.started).toBe(true);
    await authorizeChallenge(first.id);
    expect((await startChallenge(orphan, { operation: "CHALLENGE_BIAS", id: first.id })).started).toBe(false);
    await rejects(() => startChallenge(orphan), /^Challenge already running$/);
    await finishChallenge(first.id);
    const missing = await startChallenge(orphan, { evidence: [{ id: randomUUID(), sha256: HASH }] });
    await rejects(() => authorizeChallenge(missing.id), /^Selected evidence changed$/);
    await finishChallenge(missing.id);
    await rejects(() => startChallenge(orphan, { operation: "REVIEW_TRADE" }), /^Unknown proposal AI operation$/);
  });

  it("analyses only the latest revision and re-checks it at every authorization", async () => {
    const d = await draft();
    const first = await startChallenge(d.proposalId);
    expect(first.started).toBe(true);
    await authorizeChallenge(first.id);
    const second = await revise(d.tradeId, 1, owner, { narrative: "Revised thesis" });
    // The request started on revision 1 can no longer reserve, dispatch or generate.
    await rejects(() => authorizeChallenge(first.id), /^NOT_LATEST_REVISION: .*revision 2/);
    await finishChallenge(first.id);
    await rejects(() => startChallenge(d.proposalId), /^NOT_LATEST_REVISION: .*revision 2/);
    const current = await startChallenge(second.proposalId, { operation: "CHALLENGE_BIAS" });
    expect(current.started).toBe(true);
    // ANALYZE_SETUP and CHALLENGE_BIAS share one in-flight request per proposal (0010).
    await rejects(() => startChallenge(second.proposalId), /^Challenge already running$/);
    await finishChallenge(current.id);
  });

  it("refuses locked, discarded and foreign drafts, while replays stay replays", async () => {
    const d = await draft(OWNER, await freshAccount());
    const started = await startChallenge(d.proposalId);
    await finishChallenge(started.id);
    await db.actor(OWNER);
    expect((await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [d.tradeId])).planId).toBeTruthy();
    await rejects(() => startChallenge(d.proposalId), /^PLAN_LOCKED: Plan already locked$/);
    expect((await startChallenge(d.proposalId, { id: started.id })).started).toBe(false);
    const discarded = await draft();
    await db.actor(OWNER);
    await db.query("select public.discard_trade_draft($1, null, $2)", [discarded.tradeId, randomUUID()]);
    await rejects(() => startChallenge(discarded.proposalId), /^DRAFT_DISCARDED/);
    const foreign = await draft(OTHER, other);
    await rejects(() => startChallenge(foreign.proposalId), /^Proposal not found$/);
  });

  it("accepts V2 evidence of the same trade and legacy screenshots of the same revision", async () => {
    const d = await draft();
    const evidence = await register(d.tradeId, sha("1"));
    const legacy = await legacyScreenshot(d.proposalId, sha("2"));
    const request = await startChallenge(d.proposalId, { evidence: [{ id: evidence, sha256: sha("1") }, { id: legacy, sha256: sha("2") }] });
    await expect(authorizeChallenge(request.id)).resolves.toBeUndefined();
    await finishChallenge(request.id);
  });

  it("rejects evidence that changed, belongs elsewhere, was removed, or was registered after the request", async () => {
    const d = await draft();
    const evidence = await register(d.tradeId, sha("3"));
    const sibling = await draft();
    const siblingEvidence = await register(sibling.tradeId, sha("4"));
    const foreign = await draft(OTHER, other);
    const foreignEvidence = await register(foreign.tradeId, sha("5"), { user: OTHER });
    const olderRevisionShot = await legacyScreenshot(d.proposalId, sha("6"));
    const current = await revise(d.tradeId, 1);
    const cases: { id: string; sha256: string }[][] = [
      [{ id: evidence, sha256: sha("9") }],
      [{ id: siblingEvidence, sha256: sha("4") }],
      [{ id: foreignEvidence, sha256: sha("5") }],
      [{ id: olderRevisionShot, sha256: sha("6") }],
    ];
    for (const selected of cases) {
      const request = await startChallenge(current.proposalId, { evidence: selected });
      await rejects(() => authorizeChallenge(request.id), /^EVIDENCE_CHANGED: Selected evidence changed$/);
      await finishChallenge(request.id);
    }
    const lateId = randomUUID();
    const late = await startChallenge(current.proposalId, { evidence: [{ id: lateId, sha256: sha("7") }] });
    await register(d.tradeId, sha("7"), { id: lateId });
    await rejects(() => authorizeChallenge(late.id), /^EVIDENCE_CHANGED/);
    await finishChallenge(late.id);
    await db.actor(OWNER);
    await db.query("select public.remove_trade_evidence($1)", [evidence]);
    const removed = await startChallenge(current.proposalId, { evidence: [{ id: evidence, sha256: sha("3") }] });
    await rejects(() => authorizeChallenge(removed.id), /^EVIDENCE_CHANGED/);
    await finishChallenge(removed.id);
  });
});

describe("timeline-aware trade review RPCs", () => {
  it("requires the caller's closed trade and facts that describe it", async () => {
    const open = await liveTrade();
    await rejects(() => startReview(open, facts(open, "LIVE_FIRST", "NO_PLAN_RECORDED")), /^NOT_CLOSED/);
    await closeLive(open);
    await rejects(() => startReview(open, facts(open, "LIVE_FIRST", "NO_PLAN_RECORDED"), { user: OTHER }), /^TRADE_NOT_FOUND/);
    await rejects(() => startReview(randomUUID(), facts(open, "LIVE_FIRST", "NO_PLAN_RECORDED")), /^TRADE_NOT_FOUND/);
    await rejects(() => startReview(open, facts(open, "LIVE_FIRST", "NO_PLAN_RECORDED"), { operation: "REVIEW_TRADE" }), /^UNKNOWN_OPERATION/);
    for (const mismatch of [
      facts(open, "LIVE_FIRST", "LOCKED_PLAN"), facts(open, "PLANNED", "NO_PLAN_RECORDED"), facts(randomUUID(), "LIVE_FIRST", "NO_PLAN_RECORDED"),
      JSON.stringify({ version: "REVIEW_TRADE_FACTS_V1", tradeId: open, origin: "LIVE_FIRST", planStatus: "NO_PLAN_RECORDED" }),
    ]) {
      await rejects(() => startReview(open, mismatch), /^SCOPE_MISMATCH/);
    }
    const locked = await draft(OWNER, await freshAccount());
    await db.actor(OWNER);
    expect((await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [locked.tradeId])).planId).toBeTruthy();
    await rejects(() => startReview(locked.tradeId, facts(locked.tradeId, "PLANNED", "LOCKED_PLAN")), /^NOT_CLOSED/);
    await db.admin();
    expect(await value<number>("select count(*)::int as value from public.trade_timeline_reviews where trade_id = any($1)", [[open, locked.tradeId]])).toBe(0);
  });

  it("allows one in-flight review per trade and returns false for a replayed request id", async () => {
    const trade = await liveTrade();
    await closeLive(trade);
    const reviewFacts = facts(trade, "LIVE_FIRST", "NO_PLAN_RECORDED");
    const first = await startReview(trade, reviewFacts);
    expect(first.started).toBe(true);
    expect((await startReview(trade, reviewFacts, { id: first.id })).started).toBe(false);
    await rejects(() => startReview(trade, reviewFacts), /^REVIEW_IN_PROGRESS/);
    const elsewhere = await liveTrade();
    await closeLive(elsewhere);
    await rejects(() => startReview(elsewhere, facts(elsewhere, "LIVE_FIRST", "NO_PLAN_RECORDED"), { id: first.id }), /^REVIEW_NOT_FOUND/);
    await authorizeReview(first.id);
    await rejects(() => authorizeReview(first.id, OTHER), /^REVIEW_NOT_FOUND/);
    await finishReview(first.id, "FAILED");
    await rejects(() => authorizeReview(first.id), /^REVIEW_ENDED/);
    expect((await startReview(trade, reviewFacts)).started).toBe(true);
  });

  it("reviews planned trades closed through their plan as LOCKED_PLAN", async () => {
    const trade = await closedPlannedTrade();
    await rejects(() => startReview(trade.tradeId, facts(trade.tradeId, "PLANNED", "NO_PLAN_RECORDED")), /^SCOPE_MISMATCH/);
    const review = await startReview(trade.tradeId, facts(trade.tradeId, "PLANNED", "LOCKED_PLAN"));
    expect(review.started).toBe(true);
    await finishReview(review.id, "FAILED");
  });

  it("binds evidence to the trade: owned, not removed, unchanged and at most four distinct items", async () => {
    const account = await freshAccount();
    const planned = await draft(OWNER, account);
    const preEntry = await register(planned.tradeId, sha("a"));
    // Legacy screenshots belong to the trade through any of its revisions, not only the locked one.
    const legacy = await legacyScreenshot(planned.proposalId, sha("b"), account);
    const unchanged = await register(planned.tradeId, sha("c"));
    const current = await revise(planned.tradeId, 1, account, { narrative: "Revised thesis" });
    const lockedRevisionShot = await legacyScreenshot(current.proposalId, sha("1"), account);
    const removedLater = await legacyScreenshot(current.proposalId, sha("2"), account);
    const sibling = await draft(OWNER, account);
    const siblingShot = await legacyScreenshot(sibling.proposalId, sha("3"), account);
    await db.actor(OWNER);
    expect((await value<{ planId: string | null }>("select public.lock_trade($1, 2) as value", [planned.tradeId])).planId).toBeTruthy();
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [planned.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.106', clock_timestamp(), '0')", [planned.tradeId]);
    const postTrade = await register(planned.tradeId, sha("d"), { label: "EXIT" });
    const elsewhere = await liveTrade();
    const foreignEvidence = await register(elsewhere, sha("e"));
    const start = (evidence: { id: string; sha256: string }[]) => startReview(planned.tradeId, facts(planned.tradeId, "PLANNED", "LOCKED_PLAN", evidence));

    const ok = await start([{ id: preEntry, sha256: sha("a") }, { id: legacy, sha256: sha("b") }, { id: lockedRevisionShot, sha256: sha("1") }, { id: postTrade, sha256: sha("d") }]);
    expect(ok.started).toBe(true);
    await authorizeReview(ok.id);
    // Removal after the request started is caught before reservation, dispatch and generation.
    await db.admin();
    await db.query("insert into public.trade_evidence_removals(evidence_id, user_id, account_id, trade_id) values ($1, $2, $3, $4)", [preEntry, OWNER, account.accountId, planned.tradeId]);
    await rejects(() => authorizeReview(ok.id), /^EVIDENCE_CHANGED/);
    await finishReview(ok.id, "FAILED");
    const legacyRequest = await start([{ id: removedLater, sha256: sha("2") }]);
    expect(legacyRequest.started).toBe(true);
    await authorizeReview(legacyRequest.id);
    await db.actor(OWNER);
    await db.query("select public.remove_setup_screenshot($1)", [removedLater]);
    await rejects(() => authorizeReview(legacyRequest.id), /^EVIDENCE_CHANGED/);
    await finishReview(legacyRequest.id, "FAILED");

    const refused: [string, { id: string; sha256: string }][] = [
      ["removed evidence", { id: preEntry, sha256: sha("a") }],
      ["evidence with another sha256", { id: unchanged, sha256: sha("0") }],
      ["another trade's evidence", { id: foreignEvidence, sha256: sha("e") }],
      ["a removed legacy screenshot", { id: removedLater, sha256: sha("2") }],
      ["a legacy screenshot with another sha256", { id: legacy, sha256: sha("0") }],
      ["a legacy screenshot of another draft of the same user", { id: siblingShot, sha256: sha("3") }],
      ["an unknown id", { id: randomUUID(), sha256: sha("a") }],
    ];
    for (const [label, item] of refused) {
      await expect(start([item]), label).rejects.toThrow(/^EVIDENCE_CHANGED/);
    }
    await rejects(() => start([{ id: postTrade, sha256: sha("d") }, { id: postTrade, sha256: sha("d") }]), /^SCOPE_MISMATCH/);
    await rejects(() => start(Array.from({ length: 5 }, () => ({ id: postTrade, sha256: sha("d") }))), /^EVIDENCE_LIMIT/);
    await rejects(() => start([{ id: "not-a-uuid", sha256: sha("d") }]), /^INVALID_INPUT/);
  });

  it("completes only with SETTLED usage of this request's own reservation; results are append-only", async () => {
    const trade = await liveTrade();
    await closeLive(trade);
    const reviewFacts = facts(trade, "LIVE_FIRST", "NO_PLAN_RECORDED");
    const review = await startReview(trade, reviewFacts);
    await rejects(() => finishReview(review.id, "COMPLETED"), /^USAGE_NOT_SETTLED/);
    const elsewhere = await reserve(randomUUID(), "REVIEW_TRADE_TIMELINE");
    await rejects(() => finishReview(review.id, "COMPLETED", elsewhere), /^RESERVATION_MISMATCH/);
    const pending = await reserve(review.id, "REVIEW_TRADE_TIMELINE", { settle: null });
    await rejects(() => finishReview(review.id, "COMPLETED", pending), /^USAGE_NOT_SETTLED/);
    await db.actor(OWNER, "service_role");
    await rejects(() => db.query("select public.finish_trade_timeline_review($1, $2, 'DONE', null, null, null, null)", [review.id, OWNER]), /^INVALID_INPUT/);
    await finishReview(review.id, "FAILED", pending);

    const second = await startReview(trade, reviewFacts);
    const wrongOperation = await reserve(second.id, "REVIEW_TRADE");
    await rejects(() => finishReview(second.id, "COMPLETED", wrongOperation), /^RESERVATION_MISMATCH/);
    const third = await startReview(trade, reviewFacts).catch(() => null);
    expect(third).toBeNull();
    await finishReview(second.id, "FAILED");

    const cancelled = await startReview(trade, reviewFacts);
    const refunded = await reserve(cancelled.id, "REVIEW_TRADE_TIMELINE", { settle: "CANCELLED" });
    await rejects(() => finishReview(cancelled.id, "COMPLETED", refunded), /^USAGE_NOT_SETTLED/);
    await finishReview(cancelled.id, "FAILED", refunded);

    const completed = await startReview(trade, reviewFacts);
    const settled = await reserve(completed.id, "REVIEW_TRADE_TIMELINE");
    await finishReview(completed.id, "COMPLETED", settled);
    await rejects(() => finishReview(completed.id, "FAILED"), /^REVIEW_ALREADY_FINISHED/);
    await rejects(() => authorizeReview(completed.id), /^REVIEW_ENDED/);

    await db.actor(OWNER);
    const history = await db.query<{ status: string; reservation_id: string | null }>(
      "select x.status, x.reservation_id from public.trade_timeline_reviews r join public.trade_timeline_review_results x on x.review_id = r.id where r.trade_id = $1 order by r.created_at", [trade]);
    expect(history.rows).toEqual([
      { status: "FAILED", reservation_id: pending }, { status: "FAILED", reservation_id: null }, { status: "FAILED", reservation_id: refunded },
      { status: "COMPLETED", reservation_id: settled },
    ]);
    await db.actor(OTHER);
    expect((await db.query("select * from public.trade_timeline_review_results")).rows).toEqual([]);
    expect((await db.query("select * from public.trade_timeline_reviews")).rows).toEqual([]);
    await db.admin();
    await rejects(() => db.query("update public.trade_timeline_review_results set status = 'FAILED' where review_id = $1", [completed.id]), /^Immutable record/);
    await rejects(() => db.query("delete from public.trade_timeline_reviews where id = $1", [completed.id]), /^Immutable record/);
  });
});

describe("AI read models: public.trade_ai_activity and trade_ledger.ai_review_count", () => {
  it("counts completed pre-trade analyses across revisions, V1 reviews and timeline reviews per trade", async () => {
    const account = await freshAccount();
    const d = await draft(OWNER, account);
    const early = await startChallenge(d.proposalId);
    await finishChallenge(early.id, await reserve(early.id, "ANALYZE_SETUP", { account }));
    const failed = await startChallenge(d.proposalId, { operation: "CHALLENGE_BIAS" });
    await finishChallenge(failed.id);
    const second = await revise(d.tradeId, 1, account);
    const latest = await startChallenge(second.proposalId, { operation: "CHALLENGE_BIAS" });
    await finishChallenge(latest.id, await reserve(latest.id, "CHALLENGE_BIAS", { account }));
    await db.actor(OWNER);
    const planId = (await value<{ planId: string }>("select public.lock_trade($1, 2) as value", [d.tradeId])).planId;
    expect(planId).toBeTruthy();
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [d.tradeId]);
    await db.query("select public.close_planned_trade($1, '1.106', clock_timestamp(), '0')", [d.tradeId]);
    const v1 = randomUUID();
    await db.actor(OWNER, "service_role");
    await db.query("select public.start_trade_ai_review($1, $2, $3, '{}', $4, $5::jsonb, '{}')", [v1, OWNER, planId, HASH, JSON.stringify({ id: "REVIEW_TRADE" })]);
    const v1Reservation = await reserve(v1, "REVIEW_TRADE", { account });
    await db.actor(OWNER, "service_role");
    await db.query(`select public.finish_trade_ai_review($1, $2, 'COMPLETED', '{"ok":true}', null, null, $3)`, [v1, OWNER, v1Reservation]);
    const timeline = await startReview(d.tradeId, facts(d.tradeId, "PLANNED", "LOCKED_PLAN"));
    await finishReview(timeline.id, "COMPLETED", await reserve(timeline.id, "REVIEW_TRADE_TIMELINE", { account }));
    const untouched = await liveTrade();

    await db.actor(OWNER);
    const rows = await db.query<Json>("select * from public.trade_ai_activity where trade_id = any($1) order by pre_trade_analysis_count desc", [[d.tradeId, untouched]]);
    expect(rows.rows.map(row => ({ ...row, last_completed_at: row.last_completed_at === null ? null : "set" }))).toEqual([
      { trade_id: d.tradeId, account_id: account.accountId, pre_trade_analysis_count: 2, trade_review_count: 1, timeline_review_count: 1, last_completed_at: "set" },
      { trade_id: untouched, account_id: owner.accountId, pre_trade_analysis_count: 0, trade_review_count: 0, timeline_review_count: 0, last_completed_at: null },
    ]);
    const timelineCompletedAt = await value<Date>("select created_at as value from public.trade_timeline_review_results where review_id = $1", [timeline.id]);
    expect((rows.rows[0].last_completed_at as Date).getTime()).toBe(timelineCompletedAt.getTime());
    // The ledger counts trade reviews of both kinds; pre-trade analyses are not reviews.
    const ledger = await db.query<{ id: string; ai_review_count: number }>(
      "select id, ai_review_count from public.trade_ledger where id = any($1) order by ai_review_count desc", [[d.tradeId, untouched]]);
    expect(ledger.rows).toEqual([{ id: d.tradeId, ai_review_count: 2 }, { id: untouched, ai_review_count: 0 }]);
    await db.actor(OTHER);
    expect((await db.query("select * from public.trade_ai_activity where trade_id = $1", [d.tradeId])).rows).toEqual([]);
  });

  it("counts completed timeline reviews of live-first trades in the ledger, never failed attempts", async () => {
    const trade = await liveTrade();
    await closeLive(trade);
    const reviewFacts = facts(trade, "LIVE_FIRST", "NO_PLAN_RECORDED");
    const reviews = async () => {
      await db.actor(OWNER);
      return value<number>("select ai_review_count as value from public.trade_ledger where id = $1", [trade]);
    };
    expect(await reviews()).toBe(0);
    const failed = await startReview(trade, reviewFacts);
    await finishReview(failed.id, "FAILED");
    expect(await reviews()).toBe(0);
    const completed = await startReview(trade, reviewFacts);
    await finishReview(completed.id, "COMPLETED", await reserve(completed.id, "REVIEW_TRADE_TIMELINE"));
    expect(await reviews()).toBe(1);
    const disagreements = await db.query(`select l.id from public.trade_ledger l join public.trade_ai_activity a on a.trade_id = l.id
      where l.ai_review_count <> a.trade_review_count + a.timeline_review_count`);
    expect(disagreements.rows).toEqual([]);
    await db.actor(OTHER);
    expect((await db.query("select * from public.trade_ledger where id = $1", [trade])).rows).toEqual([]);
  });

  it("redefines only trade_ledger.ai_review_count and keeps its columns, types and security_invoker", async () => {
    expect(ledgerAfter.columns).toEqual(ledgerBefore.columns);
    // 0020 appends trashed_at, custom_model_id and custom_model_name after ai_review_count.
    expect(ledgerAfter.columns.map(column => column.split(" ")[0])).toEqual(LEDGER_COLUMNS.filter(column => !["trashed_at", "custom_model_id", "custom_model_name"].includes(column)));
    expect(ledgerAfter.columns.at(-1)).toBe("ai_review_count integer");
    expect(ledgerAfter.options).toEqual(ledgerBefore.options);
    expect(ledgerAfter.options).toContain("security_invoker=true");
    const before = aroundAiReviewCount(ledgerBefore.definition);
    const after = aroundAiReviewCount(ledgerAfter.definition);
    expect(before.expression).toBe("ai_reviews.review_count");
    expect(after.expression).toMatch(/^\(ai_reviews\.review_count \+ \( SELECT [\s\S]+ trade_timeline_review_results /);
    expect(after.rest).toBe(before.rest);
    await db.admin();
    const view = await db.query<{ options: string[] | null }>("select reloptions as options from pg_class where oid = 'public.trade_ai_activity'::regclass");
    expect(view.rows[0].options).toContain("security_invoker=true");
  });
});
