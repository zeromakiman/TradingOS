import { unstable_rethrow } from "next/navigation";
import { type ReactNode, useId } from "react";
import type { PreTradePanel } from "@/ai/pre-trade-draft";
import { requestTradeAnalyzeSetup, requestTradeBiasChallenge } from "@/app/actions/ai";
import { WorkspaceSection } from "@/components/trade/section";
import { compareInstants, type TimeDisplay } from "@/domain/time-display";
import { loadTradeAnalyzeSetupPanel } from "@/lib/analyze-setup-data";
import { loadTradeBiasChallengePanel } from "@/lib/bias-challenge-data";
import { Callout } from "../ui/callout";
import { SectionHeader } from "../ui/page-header";
import type { AiRequestAction } from "./ai-action-button";
import { type AiEvidenceActionButton, AiEvidenceActions } from "./ai-evidence-actions";
import { AiHistoryList } from "./ai-history-list";
import { AiSettingsLink } from "./ai-settings-link";
import { estimateModel } from "./estimate";
import { type AiRiskLine, PRICING_UNAVAILABLE, type RiskLineDecision } from "./model";
import { AnalyzeSetupCard, ChallengeBiasCard, latestCompleted, type PreTradeResultEntry } from "./operation-cards";
import { availabilityReason, displayPreference, loadStoredRiskLines, optional } from "./panel-data";

/**
 * Pre-trade AI (docs/V2_ARCHITECTURE.md §2.4, §8.3, §11.1, §11.3). On an open planned draft of an active account:
 * Analyze setup and Challenge my bias with cost estimates and secondary styling. A blocked draft offers only "Analyze
 * blocked setup anyway · ≈ €0.02", and only while AI can run it. Then come the screenshots selected in the evidence
 * gallery, the latest result card of each tool with its stale-revision marker, and a compact history in which every
 * completed analysis opens in full. Nothing is sent until a button is clicked.
 *
 * Once the trade is no longer a draft, or its account is archived, the same results stay readable without any tool:
 * the state in words, the latest card of each tool led by the Risk Engine verdict stored with its request (history is
 * never reinterpreted, §0.3), and the history with every failure's reason and accounting outcome. Live-first and
 * imported trades never get pre-trade AI: the panel renders nothing for them. Loads its own data with the user's session.
 */

export interface PreTradeAiPanelProps {
  tradeId: string;
  /** The trade's trading account (AI settings and budgets are per account). */
  accountId: string;
  /** The account is archived: an open draft keeps its analyses readable but runs no new one (§3.2, §9). */
  accountArchived?: boolean;
  /** Latest draft revision shown on the page; requests are refused when the draft changed meanwhile. */
  currentRevision: number;
  /**
   * Decision of the latest deterministic check of that revision. `RECHECK` is an approval that is no longer current
   * ("Recheck needed", spec §2.3): the tools wait for a fresh check, like an unchecked draft.
   */
  riskDecision: RiskLineDecision;
  /** Its first reason in words, for example "Requested risk 1.00% exceeds your configured maximum of 0.75%." */
  riskLine: string;
  /**
   * "plan" (default): inside the draft's Plan section, under an "AI tools" heading. "section": a workspace section of
   * its own after the Plan, for a trade that is no longer a draft; nothing is rendered when it has no analyses.
   */
  frame?: "plan" | "section";
  developerMode?: boolean;
}

const CHECK_FIRST = "Run the free risk check first. AI tools need the Risk Engine result for the current revision.";
const RECHECK_FIRST = "Recheck risk first. The last check is no longer current, and AI tools need a current Risk Engine result.";
const TOOLS_UNAVAILABLE = "AI tools are unavailable right now. Your draft is unaffected.";
const ADVISORY = "Advisory only. The Risk Engine decision stays authoritative, and nothing is sent until you choose a tool.";
const ARCHIVED = "This trading account is archived, so no new analysis can run. Earlier analyses remain available as advisory history.";
const HISTORY_ADVISORY = "Advisory only: these analyses never changed your records or the Risk Engine's decisions.";
const PRE_TRADE_SECTION_TITLE = "Pre-trade AI";

function newestFirst(a: PreTradeResultEntry, b: PreTradeResultEntry): number {
  try {
    return compareInstants(b.requestedAt, a.requestedAt);
  } catch {
    return 0;
  }
}

/** Whether an analysis belongs to the revision the page shows. */
function isCurrent(entry: PreTradeResultEntry, currentRevision: number): boolean {
  return entry.revision === undefined || entry.revision.number >= currentRevision;
}

/** The verdict stored with a request, labelled with the revision it checked; null when it is unreadable. */
function storedLine(entry: PreTradeResultEntry, stored: ReadonlyMap<string, AiRiskLine>): AiRiskLine | null {
  const line = stored.get(entry.technical.requestId);
  if (!line || !entry.revision) return null;
  return { decision: line.decision, text: [line.text, `as checked for draft revision ${entry.revision.number}`].filter(Boolean).join(" · ") };
}

/**
 * The Risk Engine line of a result card. On an open draft, an analysis of the current revision leads with today's
 * verdict; any other analysis keeps the verdict stored with its request (history is never reinterpreted, spec §0.3),
 * labelled with its revision, or shows no line when that verdict is unreadable. Today's verdict is never shown on an
 * analysis of an earlier draft, nor on any analysis once the trade is no longer a draft (`current` is null then).
 */
function cardRiskLine(entry: PreTradeResultEntry, currentRevision: number, current: AiRiskLine | null, stored: ReadonlyMap<string, AiRiskLine>): AiRiskLine | null {
  if (current && isCurrent(entry, currentRevision)) return current;
  return storedLine(entry, stored);
}

interface ViewProps extends PreTradeAiPanelProps {
  analyze: PreTradePanel;
  challenge: PreTradePanel;
  /** Risk Engine verdicts stored with the completed requests, keyed by request id. */
  storedLines: ReadonlyMap<string, AiRiskLine>;
  timeDisplay: TimeDisplay;
  requestKeys: { analyze: string; challenge: string };
}

/** Why a tool cannot run, or null when it can (the reason its disabled button would show). */
function toolBlockedReason(tool: AiEvidenceActionButton): string | null {
  if (!tool.available) return tool.unavailableReason ?? TOOLS_UNAVAILABLE;
  return tool.estimate === null ? PRICING_UNAVAILABLE : null;
}

function toolGate(riskDecision: RiskLineDecision): string | null {
  if (riskDecision === "UNCHECKED") return CHECK_FIRST;
  if (riskDecision === "RECHECK") return RECHECK_FIRST;
  return null;
}

/** Both tools' requests, newest first; each history row's full analysis keeps the verdict stored with its request. */
export function preTradeHistory(analyze: Pick<PreTradePanel, "history">, challenge: Pick<PreTradePanel, "history">, stored: ReadonlyMap<string, AiRiskLine>) {
  return [...analyze.history, ...challenge.history].sort(newestFirst).map(entry => ({ ...entry, riskLine: storedLine(entry, stored) }));
}

/** Whether new pre-trade requests can be made: an open draft of an active account. */
function toolsOpen(analyze: PreTradePanel, accountArchived: boolean | undefined): boolean {
  return analyze.state === "OPEN" && !accountArchived;
}

function PreTradeAiPanelView({
  tradeId, accountId, accountArchived, currentRevision, riskDecision, riskLine, frame = "plan", developerMode, analyze, challenge, storedLines, timeDisplay, requestKeys,
}: ViewProps) {
  const headingId = useId();
  const open = toolsOpen(analyze, accountArchived);
  const history = preTradeHistory(analyze, challenge, storedLines);
  if (!open && history.length === 0) return null;
  // A trade that is no longer a draft has no "current" verdict: every card keeps the one stored with its request.
  const revision = open ? currentRevision : (analyze.revision ?? currentRevision);
  const current: AiRiskLine | null = open ? { decision: riskDecision, text: riskLine } : null;
  const gate = toolGate(riskDecision);

  const tool = (panel: PreTradePanel, label: string, action: AiRequestAction, requestKey: string, blockedLabel?: string): AiEvidenceActionButton => ({
    operation: panel.operation,
    label,
    action,
    payload: { tradeId, revision: String(currentRevision) },
    requestKey,
    estimate: estimateModel(panel.estimate),
    available: gate === null && !panel.error && panel.availability.status === "ENABLED",
    unavailableReason: gate ?? (panel.error ? TOOLS_UNAVAILABLE : availabilityReason({ ...panel.availability, accountArchived })),
    secondary: true,
    blockedLabel,
  });
  const blocked = riskDecision === "BLOCKED";
  // A blocked draft offers no Challenge my bias, and "Analyze blocked setup anyway" only while AI can run it (§2.4,
  // §8.3); otherwise one line says why no AI tool is offered.
  const offered = blocked ? [analyze] : [analyze, challenge];
  const analyzeTool = tool(analyze, "Analyze setup", requestTradeAnalyzeSetup, requestKeys.analyze, blocked ? "Analyze blocked setup anyway" : undefined);
  const blockedUnavailable = open && blocked ? toolBlockedReason(analyzeTool) : null;
  const buttons: AiEvidenceActionButton[] = [];
  if (open && !blocked) buttons.push(analyzeTool, tool(challenge, "Challenge my bias", requestTradeBiasChallenge, requestKeys.challenge));
  else if (open && blockedUnavailable === null) buttons.push(analyzeTool);
  const needsSettings = open && offered.some(panel => panel.availability.status === "ACCOUNT_OFF" || panel.availability.status === "BUDGET_REACHED");
  const latestAnalysis = latestCompleted(analyze.history);
  const latestChallenge = latestCompleted(challenge.history);
  // An archived account's open draft: the loader still reports the draft as open.
  const stateMessage = open ? null : analyze.state === "OPEN" ? ARCHIVED : analyze.stateMessage;
  const cardProps = { currentRevision: revision, developerMode, timeDisplay, headingLevel: frame === "section" ? (3 as const) : (4 as const) };

  const body: ReactNode = (
    <>
      {blockedUnavailable && <p className="t-meta">{blockedUnavailable}</p>}
      {buttons.length > 0 && (
        <AiEvidenceActions
          buttons={buttons}
          eligibleEvidenceIds={analyze.evidence.map(item => item.id)}
          maxEvidence={Math.min(...offered.map(panel => panel.maxEvidence))}
        />
      )}
      {needsSettings && <AiSettingsLink accountId={accountId} archived={accountArchived} />}
      {(latestAnalysis || latestChallenge) && (
        <div className="flex flex-col gap-4">
          {latestAnalysis && <AnalyzeSetupCard entry={latestAnalysis} riskLine={cardRiskLine(latestAnalysis, revision, current, storedLines)} {...cardProps} />}
          {latestChallenge && <ChallengeBiasCard entry={latestChallenge} riskLine={cardRiskLine(latestChallenge, revision, current, storedLines)} {...cardProps} />}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {frame === "section" ? <h3 className="text-[0.8125rem] font-semibold text-text">History</h3> : <h4 className="text-[0.8125rem] font-semibold text-text">History</h4>}
        <AiHistoryList rows={history} developerMode={developerMode} timeDisplay={timeDisplay} limit={5} label="Pre-trade AI history" emptyText="No analyses yet." />
        {(analyze.hasOlder || challenge.hasOlder) && <p className="t-caption">Showing the most recent requests of each tool.</p>}
      </div>
    </>
  );

  if (frame === "section") {
    return (
      <WorkspaceSection id="pre-trade-ai" title={PRE_TRADE_SECTION_TITLE} meta={stateMessage ?? ADVISORY}>
        <div className="flex min-w-0 flex-col gap-4" data-panel="pre-trade-ai" data-state={open ? "open" : "history"}>
          {body}
        </div>
      </WorkspaceSection>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-panel="pre-trade-ai" data-state={open ? "open" : "history"}>
      <SectionHeader as="h3" id={headingId} title={open ? "AI tools" : PRE_TRADE_SECTION_TITLE} description={open ? ADVISORY : HISTORY_ADVISORY} className="mb-0" />
      {stateMessage && <p className="t-meta">{stateMessage}</p>}
      {body}
    </section>
  );
}

export async function PreTradeAiPanel(props: PreTradeAiPanelProps) {
  let panels: [PreTradePanel, PreTradePanel];
  try {
    panels = await Promise.all([loadTradeAnalyzeSetupPanel(props.tradeId), loadTradeBiasChallengePanel(props.tradeId)]);
  } catch (error) {
    unstable_rethrow(error);
    const callout = (
      <Callout tone="neutral" title="AI tools are unavailable">
        AI history and tools could not be loaded for this trade. Trade records are unaffected.
      </Callout>
    );
    return props.frame === "section" ? <WorkspaceSection id="pre-trade-ai" title={PRE_TRADE_SECTION_TITLE}>{callout}</WorkspaceSection> : callout;
  }
  const [analyze, challenge] = panels;
  // Live-first and imported trades never get pre-trade tools (§8.3).
  if (analyze.state === "NOT_PLANNED") return null;
  // Each completed analysis opens in full with the verdict stored with its request; a failed read shows no line.
  const completed = [...analyze.history, ...challenge.history].flatMap(entry => (entry.status === "COMPLETED" ? [entry.technical.requestId] : []));
  const storedLines = completed.length > 0 ? ((await optional(loadStoredRiskLines(completed))) ?? new Map<string, AiRiskLine>()) : new Map<string, AiRiskLine>();
  return (
    <PreTradeAiPanelView
      {...props}
      analyze={analyze}
      challenge={challenge}
      storedLines={storedLines}
      timeDisplay={await displayPreference()}
      requestKeys={{ analyze: crypto.randomUUID(), challenge: crypto.randomUUID() }}
    />
  );
}
