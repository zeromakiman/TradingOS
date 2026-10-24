/**
 * A text-styled action link with a full hit target: 40px tall, 44px on touch (docs/V2_ARCHITECTURE.md §13.5). Used for
 * "AI settings" and the Journal drill-down beside the review.
 */
export const ACTION_LINK = "inline-flex min-h-10 items-center gap-1.5 text-[0.8125rem] font-medium text-accent hover:underline pointer-coarse:min-h-11";

/** The same link beside a short heading: the full hit target overlaps the space around it instead of growing the row. */
export const INLINE_ACTION_LINK = `${ACTION_LINK} -my-2.5 pointer-coarse:-my-3`;

/**
 * The tab strip (Weekly · Recent trades · Monthly · History): below 360px the tabs' side padding shrinks from 12px to
 * 8px, so with the phone wording all four still fit a 320px screen (their 44px height is unchanged).
 */
export const TAB_STRIP = "max-[360px]:[&>.tab]:px-2";

/**
 * The two-column workspace (content, then budget and notes): side by side from 1280px, where the content column still
 * has room for the scope card's facts and the AI card; one column below, with the side notes after the content.
 */
export const REVIEW_COLUMNS = "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] 2xl:grid-cols-[minmax(0,1fr)_22rem]";
