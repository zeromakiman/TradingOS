import { z } from "zod";
import type { Timing } from "@/domain/timeline";

/**
 * Canonical citation sources of the timeline-aware trade review (spec §11.4). Every id is derived from the
 * already owner-scoped facts snapshot, never from caller-provided references. Timeline and evidence entries carry
 * the timing Trading OS computed, which the server-side hindsight guard relies on.
 */

export const TIMELINE_REVIEW_FACTS_VERSION = "REVIEW_TRADE_TIMELINE_FACTS_V1";
export const TIMELINE_REVIEW_SOURCES_VERSION = "REVIEW_TRADE_TIMELINE_SOURCES_V1";

/**
 * Bounds that keep a request inside the operation's 24,000 input tokens together with the prompt, the response
 * schema (which enumerates every source id twice) and up to four images. Facts are dense JSON (ids, timestamps) at
 * roughly 2.5–3 characters per token, and each high-detail image costs up to about 2,500 tokens, so every selected
 * image lowers the facts budget. Larger trades are refused before anything is written; nothing is truncated.
 */
export const TIMELINE_REVIEW_LIMITS = Object.freeze({ timelineItems: 40, evidence: 4, factsBytes: 40_000, factsBytesPerImage: 5_000 });

export function maxTimelineFactsBytes(imageCount: number): number {
  return TIMELINE_REVIEW_LIMITS.factsBytes - TIMELINE_REVIEW_LIMITS.factsBytesPerImage * imageCount;
}

export const PLAN_STATUSES = ["LOCKED_PLAN", "NO_PLAN_RECORDED"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Prefixes of timeline source ids; each is followed by the uuid of the underlying record. */
export const TIMELINE_SOURCE_PREFIXES = ["revision", "check", "plan", "execution", "position", "journal", "event", "close"] as const;
export type TimelineSourcePrefix = (typeof TIMELINE_SOURCE_PREFIXES)[number];

export type TimelineSourceKind = "PLAN" | "STRATEGY" | "RISK_VERSION" | "CALCULATIONS" | "EXECUTION" | "TAGS" | "TIMELINE" | "EVIDENCE";

export interface TimelineSource {
  id: string;
  kind: TimelineSourceKind;
  path: string;
  description: string;
  /** Timing of timeline and evidence entries (spec §5.3); absent for the fixed sources. */
  timing?: Timing;
}

export interface TimelineSourceManifest {
  version: typeof TIMELINE_REVIEW_SOURCES_VERSION;
  tradeId: string;
  planStatus: PlanStatus;
  sources: TimelineSource[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const timelineSourceId = new RegExp(`^(?:${TIMELINE_SOURCE_PREFIXES.join("|")}):${UUID}$`);
const timing = z.enum(["BEFORE_ENTRY", "WHILE_LIVE", "AFTER_CLOSE"]);
const record = z.record(z.string(), z.unknown());
const factsShape = z.object({
  version: z.literal(TIMELINE_REVIEW_FACTS_VERSION),
  tradeId: z.uuid(),
  planStatus: z.enum(PLAN_STATUSES),
  plan: record.nullable(),
  strategy: record,
  riskVersion: record.nullable(),
  deterministic: record.nullable(),
  execution: record,
  tags: record,
  timeline: z.array(z.object({ sourceId: z.string().regex(timelineSourceId), timing }).loose()).max(TIMELINE_REVIEW_LIMITS.timelineItems),
  evidence: z.array(z.object({ id: z.uuid(), timing }).loose()).max(TIMELINE_REVIEW_LIMITS.evidence),
}).loose();

const TIMING_WORDS: Readonly<Record<Timing, string>> = {
  BEFORE_ENTRY: "recorded before entry",
  WHILE_LIVE: "recorded while the trade was live",
  AFTER_CLOSE: "recorded after close (hindsight)",
};
/** Fixed sources that describe what existed before entry: the locked plan, its versions and the Risk Engine result. */
const PRE_ENTRY_KINDS: ReadonlySet<TimelineSourceKind> = new Set(["PLAN", "STRATEGY", "RISK_VERSION", "CALCULATIONS"]);

/** Key-sorted JSON, so a manifest read back from JSONB (keys reordered) still compares equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v);
}

export function tradeTimelineSourceManifest(context: unknown): TimelineSourceManifest {
  const facts = factsShape.parse(context);
  const planned = facts.planStatus === "LOCKED_PLAN";
  if ([facts.plan, facts.riskVersion, facts.deterministic].some(part => (part !== null) !== planned)) {
    throw new Error("Plan status does not match the supplied plan facts");
  }
  const sources: TimelineSource[] = [];
  if (planned) sources.push({ id: "originalPlan", kind: "PLAN", path: "plan", description: "Locked pre-trade plan and thesis, recorded before entry" });
  sources.push({ id: "strategy", kind: "STRATEGY", path: "strategy", description: "Strategy version and rules supplied for this trade" });
  if (planned) {
    sources.push({ id: "riskVersion", kind: "RISK_VERSION", path: "riskVersion", description: "Risk plan version sealed with the locked plan" });
    sources.push({ id: "deterministic", kind: "CALCULATIONS", path: "deterministic", description: "Risk Engine result recorded when the plan was locked" });
  }
  sources.push({ id: "execution", kind: "EXECUTION", path: "execution", description: "Recorded entry, exit and result; realized R is authoritative" });
  sources.push({ id: "tags", kind: "TAGS", path: "tags", description: "Tags recorded for this trade; empty fields are not evidence" });
  facts.timeline.forEach((item, index) => {
    sources.push({ id: item.sourceId, kind: "TIMELINE", path: `timeline[${index}]`, description: `Trading OS record, ${TIMING_WORDS[item.timing]}`, timing: item.timing });
  });
  facts.evidence.forEach((item, index) => {
    sources.push({ id: `evidence:${item.id}`, kind: "EVIDENCE", path: `evidence[${index}]`, description: `Selected screenshot, ${TIMING_WORDS[item.timing]}`, timing: item.timing });
  });
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Duplicate timeline review source");
  return { version: TIMELINE_REVIEW_SOURCES_VERSION, tradeId: facts.tradeId, planStatus: facts.planStatus, sources };
}

export function withTimelineSources<T extends object>(facts: T): T & { sourceManifest: TimelineSourceManifest; sourceRefs: string[] } {
  const sourceManifest = tradeTimelineSourceManifest(facts);
  return { ...facts, sourceManifest, sourceRefs: sourceManifest.sources.map(source => source.id) };
}

/** Ids a thesis check may cite: plan, strategy, risk version and Risk Engine facts plus BEFORE_ENTRY records only. */
export function preEntrySourceIds(manifest: TimelineSourceManifest): string[] {
  return manifest.sources
    .filter(source => PRE_ENTRY_KINDS.has(source.kind) || ((source.kind === "TIMELINE" || source.kind === "EVIDENCE") && source.timing === "BEFORE_ENTRY"))
    .map(source => source.id);
}

export interface TimelineAllowedSources {
  manifest: TimelineSourceManifest;
  ids: string[];
  preEntryIds: string[];
}

/** Fails closed before dispatch (and when re-reading history) if the stored manifest differs from the facts. */
export function tradeTimelineAllowedSources(context: unknown): TimelineAllowedSources {
  const facts = record.parse(context);
  const manifest = tradeTimelineSourceManifest(facts);
  const ids = manifest.sources.map(source => source.id);
  if (stable(facts.sourceManifest) !== stable(manifest) || stable(facts.sourceRefs) !== stable(ids)) {
    throw new Error("Timeline review source manifest does not match the supplied facts");
  }
  return { manifest, ids, preEntryIds: preEntrySourceIds(manifest) };
}
