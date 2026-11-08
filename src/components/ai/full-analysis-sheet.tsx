import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetTrigger } from "../ui/dialog";
import { TechnicalDetails } from "../ui/technical-details";
import { AiInterpretationLabel, type AiHeadlineModel, AssessmentList, RiskEngineLine, TradingOsFacts } from "./ai-card";
import { type AiAssessmentModel, type AiCardSectionModel, type AiFactModel, type AiRiskLine, citationsOf, VIEW_FULL_ANALYSIS, withKeys } from "./model";
import { SourceChipList } from "./source-chip";
import { CitationIds } from "./technical";

/**
 * "View full analysis" (docs/V2_ARCHITECTURE.md §11.1): a side sheet (Radix dialog: focus trap, Escape, focus
 * restore) with every section, every item in full and every citation. Raw citation ids appear only in its Technical
 * details. Server-compatible: it composes the client Sheet primitives with server-rendered content.
 */

/**
 * A section of the full analysis. `note` is a deterministic caveat from Trading OS shown under the section heading,
 * never AI text (a monthly review's "What improved" and "What degraded" carry one, `CHANGE_EVIDENCE_NOTE`).
 */
export type FullAnalysisSectionModel = AiCardSectionModel & { note?: string };

export interface FullAnalysisSheetProps {
  /** Sheet title, for example "Setup analysis". */
  title: string;
  /** Every section with full texts (no truncation). */
  sections: readonly FullAnalysisSectionModel[];
  /** Trigger label; "View full analysis" by default. */
  triggerLabel?: string;
  /**
   * The trigger's accessible name when several triggers share one label (history rows): it starts with the visible
   * label, for example "View full analysis · Analyze Setup · Completed · Oct 14, 08:00".
   */
  triggerAriaLabel?: string;
  /** "button" (default): a secondary button. "link": a compact text link for lists, with a 40px (44px touch) hit area. */
  triggerStyle?: "button" | "link";
  /** Accessible description under the title, for example "Analyze Setup · Completed · Oct 14, 08:00". */
  description?: string;
  riskLine?: AiRiskLine | null;
  /** Shown before the sections when it is not already one of them. */
  headline?: AiHeadlineModel | null;
  assessments?: readonly AiAssessmentModel[];
  facts?: readonly AiFactModel[];
  factsNote?: string | null;
  /** Limitations the AI stated about its own analysis. */
  limitations?: readonly string[];
  /** Extra technical fields (request ids, versions, accounting) shown with the citation ids. */
  technical?: ReactNode;
  developerMode?: boolean;
}

/** The sheet's content; also usable inline (and in tests, where a closed Radix dialog renders nothing). */
export function FullAnalysisBody({
  sections, riskLine, headline, assessments = [], facts = [], factsNote, limitations = [], technical, developerMode,
}: Omit<FullAnalysisSheetProps, "title" | "triggerLabel" | "triggerAriaLabel" | "triggerStyle" | "description">) {
  const citations = citationsOf(sections, headline);
  const hasDeterministic = Boolean(riskLine) || facts.length > 0 || Boolean(factsNote);
  return (
    <div className="flex flex-col gap-4">
      {hasDeterministic && (
        <div className="flex flex-col gap-2" data-zone="deterministic">
          {riskLine && <RiskEngineLine line={riskLine} />}
          <TradingOsFacts facts={facts} note={factsNote} />
        </div>
      )}
      <div className="flex flex-col gap-4" data-zone="ai">
        <AiInterpretationLabel />
        {headline && (
          <div className="flex flex-col gap-1.5">
            {headline.label && <h3 className="text-[0.8125rem] font-semibold text-text">{headline.label}</h3>}
            <p className="leading-6 text-text">{headline.text}</p>
            <SourceChipList sources={headline.sources} />
          </div>
        )}
        <AssessmentList assessments={assessments} />
        {withKeys(
          sections.filter(section => section.items.length > 0),
          section => section.heading,
        ).map(({ key, value: section }) => (
          <section key={key} className="flex flex-col gap-1.5">
            <h3 className="text-[0.8125rem] font-semibold text-text">{section.heading}</h3>
            {section.note && (
              <p role="note" className="t-caption" data-zone="trading-os-note">
                {section.note}
              </p>
            )}
            <ul className="flex flex-col gap-3">
              {withKeys(section.items, item => item.text).map(({ key: itemKey, value: item }) => (
                <li key={itemKey} className="flex flex-col gap-1.5">
                  <p className="text-[0.875rem] leading-6 text-2">{item.text}</p>
                  <SourceChipList sources={item.sources} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {limitations.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[0.8125rem] font-semibold text-text">What the AI could not assess</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.8125rem] leading-5 text-2">
              {withKeys(limitations, text => text).map(({ key, value }) => (
                <li key={key}>{value}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {(citations.some(chip => chip.technicalId) || technical) && (
        <TechnicalDetails developerMode={developerMode}>
          <div className="flex flex-col gap-3">
            <CitationIds citations={citations} />
            {technical}
          </div>
        </TechnicalDetails>
      )}
    </div>
  );
}

/**
 * The compact trigger of a list row: link styling, and an invisible extension that reaches a 40px (44px on touch) hit
 * area without making the row taller (§13.5). It grows over the text above it and only 4px down, so it never covers
 * the row's Technical details toggle below.
 */
const LINK_TRIGGER =
  "relative self-start text-[0.8125rem] after:absolute after:inset-x-0 after:-top-4 after:-bottom-1 after:content-[''] pointer-coarse:after:-top-5";

export function FullAnalysisSheet({ title, triggerLabel = VIEW_FULL_ANALYSIS, triggerAriaLabel, triggerStyle = "button", description, ...body }: FullAnalysisSheetProps) {
  const link = triggerStyle === "link";
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant={link ? "link" : "secondary"}
          size="sm"
          icon={<PanelRight aria-hidden="true" />}
          aria-label={triggerAriaLabel}
          className={link ? LINK_TRIGGER : undefined}
        >
          {triggerLabel}
        </Button>
      </SheetTrigger>
      <SheetContent title={title} description={description} className="md:w-[min(100vw,36rem)]">
        <FullAnalysisBody {...body} />
      </SheetContent>
    </Sheet>
  );
}
