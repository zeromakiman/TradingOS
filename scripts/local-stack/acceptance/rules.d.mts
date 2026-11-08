// Types of rules.mjs (browser acceptance runner, local tooling only).

export type FlowName = "planned" | "live-first" | "analytics" | "accounts" | "ai" | "settings" | "ux";
export type ViewportName = "desktop" | "mobile";

export declare const FLOWS: readonly FlowName[];
export declare const FLOW_TITLES: Readonly<Record<FlowName, string>>;
export interface Viewport { readonly name: ViewportName; readonly width: number; readonly height: number; readonly mobile: boolean }
export declare const VIEWPORTS: Readonly<Record<ViewportName, Viewport>>;
export declare const DEFAULT_BASE: string;

export declare class OptionError extends Error {}
export interface RunOptions {
  flows: FlowName[];
  viewports: ViewportName[];
  out: string | null;
  base: string;
  browser: "edge" | "chrome" | null;
  headed: boolean;
  publish: boolean;
  help: boolean;
}
export declare function parseOptions(argv: readonly string[]): RunOptions;
export declare function usage(): string;
export declare function runIdFor(date: Date, suffix: string): string;
export declare function acceptanceEmail(runId: string, key: string): string;

export interface StrategySession { readonly name: string; readonly from: number; readonly to: number }
export declare const SESSIONS: readonly StrategySession[];
export interface StrategyClock {
  day: string;
  time: string;
  session: string;
  deadPool: boolean;
  minutesUntilLocksAllowed: number;
  minutesToSeedBoundary: number;
}
export declare function strategyClock(nowMs: number): StrategyClock;
export type DeadPoolExpectation = "blocked" | "open" | "either";
export declare function deadPoolExpectation(fromMs: number, toMs?: number, slackMinutes?: number): DeadPoolExpectation;
export declare function clockSpan(fromMs: number, toMs?: number): string;

export type ScanKind = "uuid" | "hash" | "provider-id" | "rule-code" | "enum" | "raw-json" | "prompt";
export interface ScanHit { kind: ScanKind; match: string; context: string }
export declare const SCAN_PATTERNS: readonly { readonly kind: ScanKind; readonly pattern: RegExp }[];
export declare function scanVisibleText(text: string | null | undefined, limit?: number): ScanHit[];
export declare function screenOf(pathname: string): string;
export interface ScanRecord {
  screen: string;
  viewport: string;
  theme: string;
  flow: string;
  hits: ScanHit[];
  selector: string | null;
  overflowPx: number;
  widest?: string;
}
export declare function widerThanPhone(scans: readonly ScanRecord[] | null | undefined): ScanRecord[];

export interface AnalysisParts { headings: string[]; items: string[] }
export declare function fullAnalysisGaps(card: AnalysisParts, sheet: AnalysisParts): string[];

export interface UxCriterion { readonly id: number; readonly text: string }
export declare const UX_CRITERIA: readonly UxCriterion[];
export interface CriterionRecord { criterion: number; ok: boolean; message: string; flow: string; viewport: string; step: string | null }
export interface CriterionVerdict { id: number; text: string; verdict: "pass" | "fail" | "not-run"; evidence: CriterionRecord[] }
export declare function judgeCriteria(records: readonly CriterionRecord[]): CriterionVerdict[];

export type StepStatus = "pass" | "fail" | "skipped" | "clock";
export declare const STEP_STATUSES: readonly StepStatus[];
export interface StepEvidence { ok: boolean; message: string; detail?: unknown; info?: boolean }
export interface StepRecord {
  flow: string;
  viewport: string;
  id: string;
  title: string;
  status: StepStatus;
  ms: number;
  evidence?: StepEvidence[];
  screenshots?: string[];
  error?: string;
  clockNote?: string;
}
export interface InputNote { kind: "tap" | "network" | string; screen: string; text: string }
export declare function foldInputNotes(record: { status: StepStatus; error?: string; evidence: StepEvidence[] }, notes: readonly InputNote[] | null | undefined): InputNote[];
export type FlowStatus = "pass" | "fail" | "skipped" | "not-run";
export declare function flowStatus(steps: readonly StepRecord[]): FlowStatus;
export interface MatrixCell { status: FlowStatus; passed: number; failed: number; skipped: number; clock: number; total: number }
export declare function passMatrix(steps: readonly StepRecord[], flows: readonly string[], viewports: readonly string[]): Record<string, Record<string, MatrixCell>>;
export declare function isFullRun(flows: readonly string[] | null | undefined, viewports: readonly string[] | null | undefined): boolean;
export type RunVerdict = "pass" | "fail" | "interrupted";
export declare function runVerdict(input: {
  steps?: readonly StepRecord[];
  criteria?: readonly CriterionVerdict[];
  flows?: readonly string[];
  viewports?: readonly string[];
  interrupted?: boolean;
}): { verdict: RunVerdict; reasons: string[] };
export declare function renderSummary(results: Record<string, unknown>): string;
