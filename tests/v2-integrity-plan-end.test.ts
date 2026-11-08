import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewProposal } from "@/domain/fixtures";
import { type BootstrappedAccount, createTestDatabase, OWNER, type TestDatabase } from "./helpers/pglite";

// A post-trade note can never masquerade as pre-entry evidence (docs/V2_ARCHITECTURE.md §5.2, §5.3, §7.4; master
// spec 60.9), including on a plan that ended without an entry. Once a planned trade is skipped, cancelled or discarded
// (or was skipped in V1), every journal entry and screenshot recorded on it is stored POST_TRADE at creation, and a
// duplicate copies only evidence recorded before that end. Stored history is never rewritten: a row stored before the
// database knew the end keeps its phase, and the end time alone keeps it out of the copy.

type Json = Record<string, unknown>;
interface Draft { tradeId: string; proposalId: string }
interface Evidence { id: string; phase: string; stateAtCreation: string }

let db: TestDatabase;

const sha = (seed: string) => seed.repeat(64).slice(0, 64);

async function value<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ value: T }>(sql, params);
  return rows[0].value;
}

async function createDraft(a: BootstrappedAccount): Promise<Draft> {
  await db.actor(OWNER);
  return value<Draft>("select public.create_planned_trade($1, $2::jsonb, $3, $4, $5) as value", [
    a.accountId, JSON.stringify({ ...previewProposal, instrumentId: a.instrumentId, narrative: "Integrity fixture", contractConfirmed: true, news: "CLEAR" }),
    randomUUID(), a.riskId, a.observationId,
  ]);
}

async function lock(tradeId: string): Promise<string> {
  await db.actor(OWNER);
  const { planId } = await value<{ planId: string | null }>("select public.lock_trade($1, 1) as value", [tradeId]);
  if (planId === null) throw new Error("The fixture plan was blocked");
  return planId;
}

async function journal(tradeId: string, body: string): Promise<{ phase: string; state: string }> {
  await db.actor(OWNER);
  const id = await value<string>("select public.add_journal_entry($1, 'NOTE', $2, '{}'::jsonb, $3) as value", [tradeId, body, randomUUID()]);
  return value<{ phase: string; state: string }>("select json_build_object('phase', phase, 'state', state_at_creation) as value from public.trade_journal_entries where id = $1", [id]);
}

async function addEvidence(tradeId: string, seed: string, overrides: Json = {}): Promise<Evidence> {
  await db.actor(OWNER, "service_role");
  return value<Evidence>("select public.register_trade_evidence($1, $2::jsonb) as value", [OWNER, JSON.stringify({
    id: randomUUID(), tradeId, label: "ENTRY", timeframe: "M5", originalFilename: "chart.png", mimeType: "image/png", byteSize: 2048, sha256: sha(seed),
    width: 1280, height: 720, captureMethod: "PASTE", ...overrides,
  })]);
}

async function duplicate(a: BootstrappedAccount, tradeId: string): Promise<string> {
  await db.actor(OWNER);
  return (await value<{ tradeId: string }>("select public.duplicate_trade_draft($1, $2, $3, $4) as value", [tradeId, randomUUID(), a.riskId, a.observationId])).tradeId;
}

function copyInto(copy: string, from: string, seed: string): Promise<Evidence> {
  return addEvidence(copy, seed, { captureMethod: "DUPLICATE", copiedFrom: from });
}

async function storedPhase(evidenceId: string): Promise<string> {
  await db.admin();
  return value<string>("select phase as value from public.trade_evidence where id = $1", [evidenceId]);
}

async function planEndedAt(tradeId: string): Promise<string | null> {
  await db.admin();
  return value<string | null>("select private.plan_ended_at($1)::text as value", [tradeId]);
}

async function recordedAt(sql: string, params: unknown[]): Promise<string> {
  await db.admin();
  return value<string>(`select (${sql})::text as value`, params);
}

// 0019 revokes record_setup_decision from authenticated (§10.4); the superuser role keeps the session subject, so this
// models a V1 decision recorded before that revoke.
async function legacyDecision(proposalId: string, decision: "TAKEN" | "SKIPPED"): Promise<void> {
  await db.actor(OWNER);
  await db.admin();
  await db.query("select public.record_setup_decision($1, $2, null)", [proposalId, decision]);
}

/** A row as the database stored it before it knew the end: phase PRE_ENTRY although recorded after the skip. */
async function legacyEvidenceRow(a: BootstrappedAccount, tradeId: string, seed: string): Promise<string> {
  const id = randomUUID();
  await db.admin();
  await db.query(`insert into public.trade_evidence(id, user_id, account_id, trade_id, storage_path, label, timeframe, original_filename, mime_type, byte_size,
                    sha256, width, height, phase, state_at_creation, capture_method)
                  values ($1, $2, $3, $4, $5, 'PRE_ENTRY', 'M15', 'late.png', 'image/png', 2048, $6, 1280, 720, 'PRE_ENTRY', 'SKIPPED', 'PASTE')`,
    [id, OWNER, a.accountId, tradeId, `${OWNER}/${tradeId}/${id}`, sha(seed)]);
  return id;
}

async function legacyScreenshot(a: BootstrappedAccount, proposalId: string, seed: string): Promise<string> {
  const id = randomUUID();
  // A V1 registration: V2 keeps no service-role insert grant on setup_screenshots (0019), so the superuser stands in.
  await db.admin();
  await db.query(`insert into public.setup_screenshots(id, user_id, account_id, proposal_id, role, storage_path, original_filename, mime_type, byte_size, sha256, width, height)
                  values ($1, $2, $3, $4, 'M15', $5, 'm15.png', 'image/png', 1024, $6, 32, 32)`,
    [id, OWNER, a.accountId, proposalId, `${OWNER}/${proposalId}/${id}`, sha(seed)]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await db.applyMigrations();
  // A deterministic eligible session for the locks; production RPCs keep clock_timestamp().
  await db.pinSession("ACTIVE_KILL_ZONE");
}, 60_000);
afterAll(async () => { await db.close(); });

const END_STATES = [
  { status: "SKIPPED", end: (tradeId: string) => db.query("select public.set_planned_disposition($1, 'SKIPPED', 'No retest')", [tradeId]) },
  { status: "CANCELLED", end: (tradeId: string) => db.query("select public.set_planned_disposition($1, 'CANCELLED', 'News release')", [tradeId]) },
  { status: "DISCARDED", end: (tradeId: string) => db.query("select public.discard_trade_draft($1, 'Stale idea', null)", [tradeId]) },
] as const;

describe("records added after a plan ended (§5.2)", () => {
  it.each(END_STATES)("stores what is written after a plan is $status as post-trade, and copies only what came before the end", async ({ status, end }) => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await createDraft(a);
    const drafted = await addEvidence(source.tradeId, "1");
    expect(drafted).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    expect(await journal(source.tradeId, "Waiting for the sweep")).toEqual({ phase: "PRE_ENTRY", state: "DRAFT" });
    let beforeEnd = drafted;
    if (status !== "DISCARDED") {
      await lock(source.tradeId);
      beforeEnd = await addEvidence(source.tradeId, "2");
      expect(beforeEnd).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "LOCKED" });
    }
    await db.actor(OWNER);
    await end(source.tradeId);
    const endedAt = status === "DISCARDED"
      ? await recordedAt("select recorded_at from public.trade_lifecycle_events where trade_id = $1 and event = 'DRAFT_DISCARDED'", [source.tradeId])
      : await recordedAt("select d.recorded_at from public.trade_dispositions d join public.trade_plan_links l on l.plan_id = d.plan_id where l.trade_id = $1", [source.tradeId]);
    expect(await planEndedAt(source.tradeId)).toBe(endedAt);

    // Hindsight: stored post-trade at creation, with the terminal state the trade was in.
    const afterEnd = await addEvidence(source.tradeId, "3", { label: "OTHER" });
    expect(afterEnd).toMatchObject({ phase: "POST_TRADE", stateAtCreation: status });
    expect(await journal(source.tradeId, "Price ran to the target without me")).toEqual({ phase: "POST_TRADE", state: status });
    // Nothing stored earlier changed.
    expect(await storedPhase(drafted.id)).toBe("PRE_ENTRY");
    expect(await storedPhase(beforeEnd.id)).toBe("PRE_ENTRY");

    // Duplicate: the evidence recorded before the end is copied; what was added after it is not (§7.4).
    const copy = await duplicate(a, source.tradeId);
    expect(await copyInto(copy, drafted.id, "1")).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    if (beforeEnd !== drafted) expect(await copyInto(copy, beforeEnd.id, "2")).toMatchObject({ phase: "PRE_ENTRY", stateAtCreation: "DRAFT" });
    await expect(copyInto(copy, afterEnd.id, "3")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
  });

  it("regression: skip, add evidence, duplicate: the screenshot added after the skip is not copied", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await createDraft(a);
    await lock(source.tradeId);
    const before = await addEvidence(source.tradeId, "4");
    await db.actor(OWNER);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'No retest')", [source.tradeId]);
    const late = await addEvidence(source.tradeId, "5", { label: "OTHER", caption: "Where price went after the skip" });
    expect(late.phase).toBe("POST_TRADE");
    const copy = await duplicate(a, source.tradeId);
    await expect(copyInto(copy, late.id, "5")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    expect(await copyInto(copy, before.id, "4")).toMatchObject({ phase: "PRE_ENTRY", replayed: false });
    await db.actor(OWNER);
    expect(await value<number>("select count(*)::int as value from public.trade_evidence where trade_id = $1", [copy])).toBe(1);
  });

  it("keeps rows stored before the database knew the end as they are, and still never copies them as pre-entry evidence", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const source = await createDraft(a);
    const earlyScreenshot = await legacyScreenshot(a, source.proposalId, "6");
    await lock(source.tradeId);
    await db.actor(OWNER);
    await db.query("select public.set_planned_disposition($1, 'SKIPPED', 'No retest')", [source.tradeId]);
    const stalePhase = await legacyEvidenceRow(a, source.tradeId, "7");
    const lateScreenshot = await legacyScreenshot(a, source.proposalId, "8");
    const copy = await duplicate(a, source.tradeId);
    await expect(copyInto(copy, stalePhase, "7")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    await expect(copyInto(copy, lateScreenshot, "8")).rejects.toThrow(/^INVALID_INPUT: copiedFrom/);
    expect(await copyInto(copy, earlyScreenshot, "6")).toMatchObject({ phase: "PRE_ENTRY" });
    // The contradicting row is presented with a marker by the reading side; the database never rewrites it.
    expect(await storedPhase(stalePhase)).toBe("PRE_ENTRY");
  });
});

describe("the end of a plan skipped in V1 (§2.2, §5.2)", () => {
  it("ends a draft at its latest V1 skip, and a later V1 TAKEN decision reopens nothing it stored", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await legacyDecision(draft.proposalId, "SKIPPED");
    const skippedAt = await recordedAt("select max(recorded_at) from public.setup_human_decisions where proposal_id = $1", [draft.proposalId]);
    expect(await planEndedAt(draft.tradeId)).toBe(skippedAt);
    expect(await journal(draft.tradeId, "Skipped before locking")).toEqual({ phase: "POST_TRADE", state: "SKIPPED" });
  });

  it("keeps the earliest end when a cancellation follows a V1 skip, so the end never moves later", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await lock(draft.tradeId);
    await legacyDecision(draft.proposalId, "SKIPPED");
    const skippedAt = await recordedAt("select max(recorded_at) from public.setup_human_decisions where proposal_id = $1", [draft.proposalId]);
    expect(await journal(draft.tradeId, "Between the skip and the cancellation")).toEqual({ phase: "POST_TRADE", state: "SKIPPED" });
    await db.actor(OWNER);
    await db.query("select public.set_planned_disposition($1, 'CANCELLED', 'Session ended')", [draft.tradeId]);
    expect(await planEndedAt(draft.tradeId)).toBe(skippedAt);
    expect(await journal(draft.tradeId, "After the cancellation")).toEqual({ phase: "POST_TRADE", state: "CANCELLED" });
  });

  it("is no end once the plan was filled after the V1 skip", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    await lock(draft.tradeId);
    await legacyDecision(draft.proposalId, "SKIPPED");
    await db.actor(OWNER);
    await db.query("select public.record_planned_entry($1, '1.1', '0.25', clock_timestamp())", [draft.tradeId]);
    expect(await planEndedAt(draft.tradeId)).toBeNull();
    expect(await journal(draft.tradeId, "Filled after all")).toEqual({ phase: "LIVE", state: "LIVE" });
  });

  it("is never an end for open, executed or live-first trades", async () => {
    const a = await db.bootstrapAccount(OWNER);
    const draft = await createDraft(a);
    expect(await planEndedAt(draft.tradeId)).toBeNull();
    await lock(draft.tradeId);
    expect(await planEndedAt(draft.tradeId)).toBeNull();
    await db.actor(OWNER);
    const live = await value<string>("select public.record_live_trade($1, $2::jsonb, $3) as value", [a.accountId, JSON.stringify({ symbol: "XAUUSD", direction: "LONG" }), randomUUID()]);
    expect(await planEndedAt(live)).toBeNull();
  });
});
