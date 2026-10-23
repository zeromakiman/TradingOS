import { unstable_rethrow } from "next/navigation";
import { useId } from "react";
import type { PreTradePanel } from "@/ai/pre-trade-draft";
import { requestTradeAnalyzeSetup, requestTradeBiasChallenge } from "@/app/actions/ai";
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
 * Pre-trade AI on a planned draft (docs/V2_ARCHITECTURE.md §2.4, §8.3, §11.1, §11.3): Analyze setup and Challenge my
 * bias with cost estimates and secondary styling. A blocked draft offers only "Analyze blocked setup anyway · ≈ €0.02",
 * and only while AI can run it. Then come the screenshots selected in the evidence gallery, the latest result card of each tool with its stale-revision marker,
 * and a compact history. Loads its own data with the user's session; nothing is sent until a button is clicked.
 * Live-first and imported trades never get these tools: the panel renders nothing for them.
 */

export interface PreTradeAiPanelProps {
  tradeId: string;
  /** The trade's trading account (AI settings and budgets are per account). */
  accountId: string;
  /** Latest draft revision shown on the page; requests are refused when the draft changed meanwhile. */
  currentRevision: number;
  /**
   * Decision of the latest deterministic check of that revision. `RECHECK` is an approval that is no longer current
   * ("Recheck needed", spec §2.3): the tools wait for a fresh check, like an unchecked draft.
   */
  riskDecision: RiskLineDecision;
  /** Its first reason in words, for example "Requested risk 1.00% exceeds your configured maximum of 0.75%." */
  riskLine: string;
  developerMode?: boolean;
}

const CHECK_FIRST = "Run the free risk check first. AI tools need the Risk Engine result for the current revision.";
const RECHECK_FIRST = "Recheck risk first. The last check is no longer current, and AI tools need a current Risk Engine result.";
const TOOLS_UNAVAILABLE = "AI tools are unavailable right now. Your draft is unaffected.";
const ADVISORY = "Advisory only. The Risk Engine decision stays authoritative, and nothing is sent until you choose a tool.";

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

/**
 * The Risk Engine line of a result card. An analysis of the current revision leads with today's verdict; one of an
 * earlier revision keeps the verdict stored with its request (history is never reinterpreted, spec §0.3), labelled
 * with its revision, or shows no line when that verdict is unreadable. Today's verdict is never shown on an analysis
 * of an earlier draft.
 */
function cardRiskLine(entry: PreTradeResultEntry, currentRevision: number, current: AiRiskLine, stored: ReadonlyMap<string, AiRiskLine>): AiRiskLine | null {
  if (isCurrent(entry, currentRevision)) return current;
  const line = stored.get(entry.technical.requestId);
  if (!line || !entry.revision) return null;
  return { decision: line.decision, text: [line.text, `as checked for draft revision ${entry.revision.number}`].filter(Boolean).join(" · ") };
}

interface ViewProps extends PreTradeAiPanelProps {
  analyze: PreTradePanel;
  challenge: PreTradePanel;
  /** Stored Risk Engine verdicts of analyses of earlier revisions, keyed by request id. */
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

function PreTradeAiPanelView({
  tradeId, accountId, currentRevision, riskDecision, riskLine, developerMode, analyze, challenge, storedLines, timeDisplay, requestKeys,
}: ViewProps) {
  const headingId = useId();
  const line: AiRiskLine = { decision: riskDecision, text: riskLine };
  const open = analyze.state === "OPEN";
  const gate = toolGate(riskDecision);
  const history = [...analyze.history, ...challenge.history].sort(newestFirst);
  if (!open && history.length === 0) return null;

  const tool = (panel: PreTradePanel, label: string, action: AiRequestAction, requestKey: string, blockedLabel?: string): AiEvidenceActionButton => ({
    operation: panel.operation,
    label,
    action,
    payload: { tradeId, revision: String(currentRevision) },
    requestKey,
    estimate: estimateModel(panel.estimate),
    available: gate === null && !panel.error && panel.availability.status === "ENABLED",
    unavailableReason: gate ?? (panel.error ? TOOLS_UNAVAILABLE : availabilityReason(panel.availability)),
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
  const stateMessage = analyze.stateMessage;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-panel="pre-trade-ai">
      <SectionHeader as="h3" id={headingId} title="AI tools" description={ADVISORY} className="mb-0" />
      {stateMessage && <p className="t-meta">{stateMessage}</p>}
      {blockedUnavailable && <p className="t-meta">{blockedUnavailable}</p>}
      {buttons.length > 0 && (
        <AiEvidenceActions
          buttons={buttons}
          eligibleEvidenceIds={analyze.evidence.map(item => item.id)}
          maxEvidence={Math.min(...offered.map(panel => panel.maxEvidence))}
        />
      )}
      {needsSettings && <AiSettingsLink accountId={accountId} />}
      {(latestAnalysis || latestChallenge) && (
        <div className="flex flex-col gap-4">
          {latestAnalysis && (
            <AnalyzeSetupCard
              entry={latestAnalysis}
              riskLine={cardRiskLine(latestAnalysis, currentRevision, line, storedLines)}
              currentRevision={currentRevision}
              developerMode={developerMode}
              timeDisplay={timeDisplay}
              headingLevel={4}
            />
          )}
          {latestChallenge && (
            <ChallengeBiasCard
              entry={latestChallenge}
              riskLine={cardRiskLine(latestChallenge, currentRevision, line, storedLines)}
              currentRevision={currentRevision}
              developerMode={developerMode}
              timeDisplay={timeDisplay}
              headingLevel={4}
            />
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h4 className="text-[0.8125rem] font-semibold text-text">History</h4>
        <AiHistoryList rows={history} developerMode={developerMode} timeDisplay={timeDisplay} limit={5} label="Pre-trade AI history" emptyText="No analyses yet." />
        {(analyze.hasOlder || challenge.hasOlder) && <p className="t-caption">Showing the most recent requests of each tool.</p>}
      </div>
    </section>
  );
}

export async function PreTradeAiPanel(props: PreTradeAiPanelProps) {
  let panels: [PreTradePanel, PreTradePanel];
  try {
    panels = await Promise.all([loadTradeAnalyzeSetupPanel(props.tradeId), loadTradeBiasChallengePanel(props.tradeId)]);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <Callout tone="neutral" title="AI tools are unavailable">
        AI history and tools could not be loaded for this trade. Trade records are unaffected.
      </Callout>
    );
  }
  const [analyze, challenge] = panels;
  // Live-first and imported trades never get pre-trade tools (§8.3).
  if (analyze.state === "NOT_PLANNED") return null;
  // Only cards of earlier revisions need the verdict stored with their request; a failed read shows no line.
  const stale = [latestCompleted(analyze.history), latestCompleted(challenge.history)].flatMap(entry =>
    entry !== null && !isCurrent(entry, props.currentRevision) ? [entry.technical.requestId] : [],
  );
  const storedLines = stale.length > 0 ? ((await optional(loadStoredRiskLines(stale))) ?? new Map<string, AiRiskLine>()) : new Map<string, AiRiskLine>();
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
