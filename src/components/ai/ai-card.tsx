import { Database, Hourglass, PanelRight, ShieldAlert, ShieldCheck, ShieldQuestion, Sparkles } from "lucide-react";
import { type ReactNode, useId } from "react";
import { aiStatusLabel, firstSentence } from "@/domain/ai-summary";
import { formatTime, STRATEGY_TIME, type TimeDisplay } from "@/domain/time-display";
import { StatusPill } from "../ui/badge";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { cx } from "../ui/cx";
import { TechnicalDetails } from "../ui/technical-details";
import {
  AI_INTERPRETATION_LABEL, type AiAssessmentModel, type AiCardItemModel, type AiCardSectionModel, type AiCardStatus, type AiFactModel, type AiRiskLine,
  dataToken, FROM_TRADING_OS_LABEL, type RiskLineDecision, riskLineText, VIEW_FULL_ANALYSIS, withKeys,
} from "./model";
import { SourceChipList } from "./source-chip";
import { StaleNotice } from "./stale-revision-marker";

/**
 * Concise AI result card (docs/V2_ARCHITECTURE.md §11.1), designed for a 10–20 second read: the deterministic zone
 * (Risk Engine line, "From Trading OS" facts) always comes first and looks different from the advisory zone, which
 * shows the headline and at most two first-sentence items per section. Everything else lives in the full analysis
 * and in Technical details. Server-compatible: no client hooks.
 */

export type { AiCardItemModel, AiCardSectionModel, AiCardStatus, AiRiskLine } from "./model";

export const CONCISE_ITEMS = 2;

export interface AiHeadlineModel extends AiCardItemModel {
  /** Small label above the headline, for example "Why your thesis might be wrong". */
  label?: string;
}

export interface AiCardFailure {
  /** Human reason, for example "The AI provider did not respond in time." */
  reason: string;
  /** Accounting outcome in plain words. */
  accounting?: string | null;
}

export interface AiCardProps {
  /** Short card heading, for example "Setup analysis" or "Week of Oct 6–12". */
  title: string;
  /** Operation in words, for example "Analyze Setup". */
  operationLabel: string;
  /** When the result was saved (or requested, while in progress); shown as a time in `timeDisplay`. */
  completedAt: string;
  status: AiCardStatus;
  /** The deterministic Risk Engine status line; always leads pre-trade cards. */
  riskLine?: AiRiskLine | null;
  /** Concise sections; the card shows at most two items per section, each cut to its first sentence. */
  sections: readonly AiCardSectionModel[];
  /** For example "Based on draft revision 2 · current revision is 3". */
  staleNote?: string | null;
  /**
   * The full-analysis trigger: an element (usually `<FullAnalysisSheet>`, works in server components) or, inside a
   * client component, a handler that opens it (rendered as a "View full analysis" button).
   */
  onOpenFull?: ReactNode | (() => void);
  /** Ids, versions, provider and accounting fields; rendered inside a collapsed Technical details disclosure. */
  technical?: ReactNode;
  /** First sentence of the result's headline field with its citations. */
  headline?: AiHeadlineModel | null;
  /** Trade review assessments (`Plan adherence · Aligned`). */
  assessments?: readonly AiAssessmentModel[];
  /** Deterministic facts from Trading OS (sample size, net R, plan status); never AI text. */
  facts?: readonly AiFactModel[];
  /** Caveat under the facts, for example the small-sample note. */
  factsNote?: string | null;
  /** Shown instead of the sections when the status is FAILED. */
  failure?: AiCardFailure | null;
  /** Opens Technical details by default (Settings → Developer); defaults to the shell's developer-mode context. */
  developerMode?: boolean;
  timeDisplay?: TimeDisplay;
  /** Heading level of the title; section headings use the next level. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

type HeadingTag = "h2" | "h3" | "h4" | "h5";

function safeTime(at: string, display: TimeDisplay): string | null {
  try {
    return formatTime(at, display);
  } catch {
    return null;
  }
}

const RISK_STYLES: Readonly<Record<RiskLineDecision, { icon: typeof ShieldCheck; className: string }>> = {
  APPROVED: { icon: ShieldCheck, className: "border-pos/30 bg-pos-soft text-pos" },
  BLOCKED: { icon: ShieldAlert, className: "border-neg-border bg-neg-soft text-neg" },
  UNCHECKED: { icon: ShieldQuestion, className: "border-border-strong bg-surface-sunken text-2" },
  RECHECK: { icon: ShieldQuestion, className: "border-warn-border bg-warn-soft text-warn" },
};

/** `Risk Engine · Blocked — …`: deterministic, so it never carries the AI marker. */
export function RiskEngineLine({ line, className }: { line: AiRiskLine; className?: string }) {
  const style = RISK_STYLES[line.decision];
  const Icon = style.icon;
  return (
    <p
      className={cx("flex items-start gap-2 rounded-control border px-3 py-2 text-[0.8125rem] font-medium leading-5", style.className, className)}
      data-zone="risk-engine"
      data-decision={dataToken(line.decision)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 flex-none" />
      <span>{riskLineText(line)}</span>
    </p>
  );
}

/** The "From Trading OS" strip: deterministic facts, visually distinct from AI text. */
export function TradingOsFacts({ facts, note, className }: { facts: readonly AiFactModel[]; note?: string | null; className?: string }) {
  if (facts.length === 0 && !note) return null;
  return (
    <div className={cx("rounded-control border border-border bg-surface-sunken px-3 py-2", className)} data-zone="trading-os">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-2">
        <Database aria-hidden="true" className="size-3.5 flex-none" />
        {FROM_TRADING_OS_LABEL}
      </p>
      {facts.length > 0 && (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] leading-5">
          {withKeys(facts, fact => fact.label).map(({ key, value: fact }) => (
            <div key={key} className="flex min-w-0 gap-1.5">
              <dt className="text-2">{fact.label}</dt>
              <dd className="num font-semibold text-text">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {note && <p className="t-caption mt-1">{note}</p>}
    </div>
  );
}

/** "AI interpretation · advisory": marks everything after it as advisory AI text. */
export function AiInterpretationLabel({ className }: { className?: string }) {
  return (
    <p className={cx("flex items-center gap-1.5 text-xs font-semibold text-2", className)} data-zone="ai-label">
      <Sparkles aria-hidden="true" className="size-3.5 flex-none text-accent" />
      {AI_INTERPRETATION_LABEL}
    </p>
  );
}

/** Assessment pills; the word always accompanies the tone. */
export function AssessmentList({ assessments, className }: { assessments: readonly AiAssessmentModel[]; className?: string }) {
  if (assessments.length === 0) return null;
  return (
    <ul aria-label="Assessments" className={cx("flex flex-wrap gap-1.5", className)}>
      {withKeys(assessments, assessment => assessment.label).map(({ key, value: assessment }) => (
        <li key={key}>
          <StatusPill tone={assessment.tone}>
            {assessment.label} · {assessment.value}
          </StatusPill>
        </li>
      ))}
    </ul>
  );
}

interface ConciseSection {
  heading: string;
  items: AiCardItemModel[];
  more: number;
}

function conciseSections(sections: readonly AiCardSectionModel[]): ConciseSection[] {
  return sections
    .filter(section => section.items.length > 0)
    .map(section => ({
      heading: section.heading,
      items: section.items.slice(0, CONCISE_ITEMS).map(item => ({ text: firstSentence(item.text), sources: item.sources })),
      more: Math.max(0, section.items.length - CONCISE_ITEMS),
    }));
}

function FullTrigger({ onOpenFull }: { onOpenFull: AiCardProps["onOpenFull"] }) {
  if (typeof onOpenFull === "function") {
    return (
      <Button type="button" variant="secondary" size="sm" icon={<PanelRight aria-hidden="true" />} onClick={onOpenFull}>
        {VIEW_FULL_ANALYSIS}
      </Button>
    );
  }
  return <>{onOpenFull}</>;
}

export function AiCard({
  title, operationLabel, completedAt, status, riskLine, sections, staleNote, onOpenFull, technical, headline, assessments = [], facts = [], factsNote,
  failure, developerMode, timeDisplay = STRATEGY_TIME, headingLevel = 3, className,
}: AiCardProps) {
  const titleId = useId();
  const Heading = `h${headingLevel}` as HeadingTag;
  const SectionHeading = `h${headingLevel + 1}` as HeadingTag;
  const time = safeTime(completedAt, timeDisplay);
  const concise = conciseSections(sections);
  const hasDeterministic = Boolean(riskLine) || facts.length > 0 || Boolean(factsNote);
  const hasFooter = Boolean(onOpenFull) || Boolean(technical);

  return (
    <article className={cx("card flex min-w-0 flex-col", className)} aria-labelledby={titleId} data-status={dataToken(status)}>
      <header className="flex flex-col gap-1.5 px-4 pt-4 md:px-5 md:pt-5">
        <p className="t-caption">
          {operationLabel} · {aiStatusLabel(status)}
          {time && (
            <>
              {" · "}
              <time dateTime={completedAt}>{time}</time>
            </>
          )}
        </p>
        <Heading id={titleId} className="card-title">
          {title}
        </Heading>
        {staleNote && <StaleNotice text={staleNote} className="self-start" />}
      </header>

      <div className="flex flex-col gap-3 p-4 md:p-5">
        {hasDeterministic && (
          <div className="flex flex-col gap-2" data-zone="deterministic">
            {riskLine && <RiskEngineLine line={riskLine} />}
            <TradingOsFacts facts={facts} note={factsNote} />
          </div>
        )}

        <div className={cx("flex flex-col gap-3", hasDeterministic && "border-t border-border pt-3")} data-zone="ai">
          {status === "COMPLETED" && (
            <>
              <AiInterpretationLabel />
              {headline && (
                <div className="flex flex-col gap-1.5">
                  {headline.label && <p className="text-xs font-semibold text-2">{headline.label}</p>}
                  <p className="text-[0.9375rem] leading-6 text-text">{firstSentence(headline.text)}</p>
                  <SourceChipList sources={headline.sources} />
                </div>
              )}
              <AssessmentList assessments={assessments} />
              {withKeys(concise, section => section.heading).map(({ key, value: section }) => (
                <div key={key} className="flex flex-col gap-1">
                  <SectionHeading className="text-[0.8125rem] font-semibold text-text">{section.heading}</SectionHeading>
                  <ul className="flex flex-col gap-2">
                    {withKeys(section.items, item => item.text).map(({ key: itemKey, value: item }) => (
                      <li key={itemKey} className="flex flex-col gap-1">
                        <p className="text-[0.8125rem] leading-5 text-2">{item.text}</p>
                        <SourceChipList sources={item.sources} />
                      </li>
                    ))}
                  </ul>
                  {section.more > 0 && <p className="t-caption">+{section.more} more in the full analysis</p>}
                </div>
              ))}
            </>
          )}
          {status === "FAILED" && (
            <Callout tone="warning" title={failure?.reason ?? "The request did not complete."}>
              {failure?.accounting ?? "Earlier results are unchanged."}
            </Callout>
          )}
          {status === "IN_PROGRESS" && (
            <p className="t-meta flex items-center gap-2" role="status">
              <Hourglass aria-hidden="true" className="size-4 flex-none" />
              Still running. The result appears here once it is saved; refresh to check.
            </p>
          )}
        </div>
      </div>

      {hasFooter && (
        <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 md:px-5">
          {onOpenFull && (
            <div className="flex flex-wrap items-center gap-2">
              <FullTrigger onOpenFull={onOpenFull} />
            </div>
          )}
          {technical && <TechnicalDetails developerMode={developerMode}>{technical}</TechnicalDetails>}
        </footer>
      )}
    </article>
  );
}
