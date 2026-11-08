import { CircleCheck, Lightbulb } from "lucide-react";
import type { ReactNode } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import type { TimeDisplay } from "@/domain/time-display";
import type { TradeDetail } from "@/lib/trades-data";
import { lessonsOf, lessonTiming, type ReviewMode, tagsSummary, whenLabel } from "./model";
import { AddLessonButton, MarkReviewedButton } from "./review-controls";
import { SubSection, WorkspaceSection } from "./section";
import { TagsDraftScope, TagsForm } from "./tags-form";

/**
 * Review section (docs/V2_ARCHITECTURE.md §2.2, §2.5, §3.8, §14.4). A closed trade: tags (grade, liquidity, MSS
 * timeframe, custom tags), lessons (journal entries of the Lesson kind), Mark reviewed / Reopen review and the AI
 * review card with its history. Tags and Mark reviewed share one `TagsDraftScope`: with unsaved tag changes the button
 * reads "Save tags and mark reviewed" and saves them first. A skipped or cancelled plan keeps tags and lessons; an open
 * trade shows its tags in words with the editor collapsed. Server component; the controls are client components.
 */

export interface ReviewSectionProps {
  detail: TradeDetail;
  mode: ReviewMode;
  now: string;
  display: TimeDisplay;
  keys: { review: string; reopen: string };
  /** AI review of a closed trade (rendered by the page inside a Suspense boundary). */
  ai?: ReactNode;
}

const TITLES: Readonly<Record<ReviewMode, string>> = { review: "Review", reflection: "Tags & lessons", tags: "Tags" };

function Lessons({ detail, now, display }: Pick<ReviewSectionProps, "detail" | "now" | "display">) {
  const lessons = lessonsOf(detail.timeline);
  return (
    <SubSection id="review-lessons" title="Lessons" actions={<AddLessonButton />}>
      {lessons.length === 0 ? (
        <p className="t-meta">No lessons yet. What would you repeat, and what would you do differently?</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lessons.map(lesson => (
            <li key={lesson.id} className="flex gap-2.5 rounded-control border border-border bg-surface-sunken px-3 py-2">
              <Lightbulb aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-3" />
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-text">{lesson.body ?? lesson.title}</p>
                <p className="t-caption num">
                  {lessonTiming(lesson, detail.state.lifecycle)} · {whenLabel(lesson.recordedAt, now, display)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SubSection>
  );
}

/**
 * Completing the review of a closed trade. Once reviewed, the header carries "Reopen review" and says when the review
 * was completed, so this box is shown only while the review is pending.
 */
function ReviewStatus({ detail, keys }: Pick<ReviewSectionProps, "detail" | "keys">) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-sunken p-3 @md:flex-row @md:items-center @md:justify-between sm:p-4" data-review="pending">
      <p className="flex items-start gap-2 text-text-2">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 flex-none text-text-3" />
        <span>When the tags and lessons say what you want to remember, mark the trade reviewed. You can reopen the review later.</span>
      </p>
      <MarkReviewedButton tradeId={detail.tradeId} requestKey={keys.review} />
    </div>
  );
}

/**
 * Tags of a trade that is still open: what is set, in words, with the editor behind "Edit tags" so the plan, the
 * execution and the journal stay in front. Tags remain editable in every state.
 */
function OpenTradeTags({ detail }: Pick<ReviewSectionProps, "detail">) {
  const summary = tagsSummary(detail.tags);
  return (
    <WorkspaceSection id="review" title={TITLES.tags} meta={summary ?? "No tags yet. Grade, liquidity, MSS timeframe and your own tags filter the Journal and EDGE."}>
      <Disclosure summary={summary ? "Edit tags" : "Add tags"} bodyClassName="pt-4">
        <TagsForm tradeId={detail.tradeId} initial={{ grade: detail.tags.grade, liquidity: detail.tags.liquidity, mss: detail.tags.mss, tags: detail.tags.tags }} source={detail.tags.source} />
      </Disclosure>
    </WorkspaceSection>
  );
}

export function ReviewSection({ detail, mode, now, display, keys, ai }: ReviewSectionProps) {
  if (mode === "tags") return <OpenTradeTags detail={detail} />;
  const reviewed = detail.state.lifecycle === "REVIEWED";
  const meta = mode === "review"
    ? reviewed ? `Reviewed${detail.review.completedAt ? ` ${whenLabel(detail.review.completedAt, now, display)}` : ""}` : "Review pending"
    : "What you learned from a plan you didn't take.";
  return (
    <WorkspaceSection id="review" title={TITLES[mode]} meta={meta}>
      <TagsDraftScope>
        <TagsForm tradeId={detail.tradeId} initial={{ grade: detail.tags.grade, liquidity: detail.tags.liquidity, mss: detail.tags.mss, tags: detail.tags.tags }} source={detail.tags.source} />
        <div className="border-t border-border pt-5">
          <Lessons detail={detail} now={now} display={display} />
        </div>
        {mode === "review" && !reviewed && <ReviewStatus detail={detail} keys={keys} />}
      </TagsDraftScope>
      {mode === "review" && ai && <div className="border-t border-border pt-5 empty:hidden">{ai}</div>}
    </WorkspaceSection>
  );
}
