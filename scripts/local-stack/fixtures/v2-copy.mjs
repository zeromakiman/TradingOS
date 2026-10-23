// Trader-language copy and AI interpretation fixtures for scripts/local-stack/seed-v2.mjs (SYNTHETIC data only).
// Every text is written as a trader would record it; nothing here is real market data or a real account.
// The AI outputs follow the stored shapes of the app's contracts (tests/fixtures/*.ts): analyzeOutput,
// challengeOutput, weeklyOutput and the REVIEW_TRADE_TIMELINE_V1 output. They cite only ids from the facts they are
// written for and are validated with the app's own validators before they are stored.

const LIQUIDITY_WORDS = {
  ARL_LOW: "the Asian range low", ARL_HIGH: "the Asian range high", PDL: "the previous day low", PDH: "the previous day high",
  PWL: "the previous week low", PWH: "the previous week high", EQUAL_LOWS: "the equal lows", EQUAL_HIGHS: "the equal highs",
  KZ_LOW: "the London kill zone low", KZ_HIGH: "the London kill zone high",
};

/** Liquidity swept before the setup and the draw it targets, by direction (ICT V1.0 vocabulary). */
export function liquidityStory(direction, random) {
  const sweep = direction === "LONG" ? random.pick(["ARL_LOW", "PDL", "EQUAL_LOWS", "KZ_LOW"]) : random.pick(["ARL_HIGH", "PDH", "EQUAL_HIGHS", "KZ_HIGH"]);
  const draw = direction === "LONG" ? random.pick(["PDH", "ARL_HIGH", "EQUAL_HIGHS", "PWH"]) : random.pick(["PDL", "ARL_LOW", "EQUAL_LOWS", "PWL"]);
  return { sweep, draw, sweepWords: LIQUIDITY_WORDS[sweep], drawWords: LIQUIDITY_WORDS[draw] };
}

/** Pre-trade thesis: why this trade and what would invalidate it (required by the Plan Trade form). */
export function thesis({ symbol, direction, model, entry, stop, target, story, kz }) {
  const side = direction === "LONG" ? "bullish" : "bearish";
  const session = kz === "LONDON" ? "London" : "New York";
  if (model === "OTE") {
    return `${session} ran ${story.sweepWords} and displaced ${direction === "LONG" ? "higher" : "lower"} with an M5 market structure shift. `
      + `Entry ${entry} sits in the 62–79% OTE of the displacement leg; stop ${stop} beyond the swing that took liquidity; `
      + `target ${target} at ${story.drawWords}. H4 order flow is ${side}. Invalidation: an M5 close beyond ${stop} before entry, `
      + `or price reaching the target without a retracement.`;
  }
  return `${session} swept ${story.sweepWords}, then an M5 MSS with clear displacement left a ${side} order block. `
    + `Entry ${entry} on the first touch of the proximal edge, stop ${stop} beyond the sweep, target ${target} at ${story.drawWords}. `
    + `${symbol} H1 is ${side} and the FVG above/below the OB is still open. Invalidation: a second touch of the OB before entry `
    + `or an M5 close through the sweep extreme.`;
}

export const PRE_ENTRY_NOTES = [
  "Price is a few ticks from the OB — not chasing. Limit sits at the proximal edge.",
  "News checked: no high-impact events until after the NY open. Waiting for the first touch.",
  "Waiting for the M5 candle to close before the limit becomes active.",
  "Asian range already respected twice; this is the first touch of today's OB.",
  "Spread widened briefly at the open; keeping the order at the planned entry, no adjustment.",
];

export const LIVE_NOTES = [
  "Clean first reaction from the OB. Holding; nothing has changed.",
  "Displacement continued after entry. Leaving the stop where the plan put it.",
  "Slow grind into the FVG — patience, the draw on liquidity is unchanged.",
  "Retest of entry held on M5. Not touching the position.",
  "Momentum stalled under the H1 FVG; watching, no action yet.",
];

export const LESSONS = {
  WIN_TARGET: [
    "Followed the plan end to end: first touch, no interference, target hit at the draw on liquidity.",
    "Waiting for the MSS before arming the order kept the entry clean. Repeat this patience.",
  ],
  WIN_PARTIAL: [
    "Exited before the target because momentum stalled under the H1 FVG. Note the reason before closing next time.",
    "Partial was fine; closing the rest early cost about 1R of the planned move.",
  ],
  LOSS: [
    "Valid setup, the stop did its job. Loss is within planned risk; no rule was broken.",
    "Entered on the first touch but the sweep was shallow. Require a deeper sweep of the range next time.",
    "HTF bias was against the trade; the H4 FVG above should have been respected.",
  ],
  LOSS_SLIP: ["Stop filled a few ticks beyond the level during the news spike. Check the calendar again right before entry."],
  BREAKEVEN: ["Moved the stop to break-even after the M5 BOS and was taken out before the expansion. Acceptable by the plan."],
  SCRATCH: ["Closed early on a gut feeling with no new information. Record the reason in the journal before acting next time."],
  LIVE_FIRST: [
    "No pre-trade plan for this one — entered from the chart. Plan first, even for quick trades.",
    "Recorded the trade after entering. Without a plan the stop placement was improvised.",
  ],
};

export const SKIP_REASONS = [
  "Price never returned to the order block before 11:00 UTC−5. Plan expired untouched.",
  "Entry missed by two ticks; not chasing a worse price.",
];
export const CANCEL_REASONS = [
  "A high-impact release was moved into the window; the news window became restricted.",
  "H4 closed through the invalidation level before entry. Setup no longer valid.",
];
export const DISCARD_REASONS = [
  "The Asian range low was taken before I could finish the plan — the setup changed.",
  "Duplicated idea from yesterday; keeping only one draft for this level.",
  "Not my model: there was no displacement after the sweep.",
];

export const CAPTIONS = {
  HTF: ["H4 order flow and the draw on liquidity", "Daily bias: discount array below, PDH as the draw", "H4 FVG still open above"],
  PRE_ENTRY: ["M5 sweep of the range and MSS with displacement", "M15 OB after the London sweep", "Setup before the order went live"],
  ENTRY: ["Fill at the proximal edge of the OB", "Entry candle on M3"],
  MANAGEMENT: ["Holding: price respecting the FVG", "Stop moved after the M5 BOS"],
  EXIT: ["Exit at the draw on liquidity", "Stopped out: sweep failed to hold", "Exit before the H1 FVG"],
};

export const DAILY_CONTEXTS = [
  "Bias long while price holds above the Asian range low. High-impact USD news at 08:30 — no new orders 08:15–08:45.",
  "Range day expected after yesterday's expansion. Only A setups; one trade maximum unless the first one is a clean win.",
  "PWH is the draw this week. Looking for London to run the Asian low first.",
  "Tired today — half size on anything outside the London kill zone.",
];

// -----------------------------------------------------------------------------------------------------------------
// AI interpretation fixtures (stored shapes of the app's output contracts). Each builder receives the facts it
// annotates and cites only canonical ids those facts allow.
// -----------------------------------------------------------------------------------------------------------------

function observation(text, sourceRefs) {
  return { text, sourceRefs };
}

/** ANALYZE_SETUP_V1 output (analyzeSetupOutput). `evidenceIds` are the selected screenshots' evidence:<id> refs. */
export function analyzeOutput({ evidenceRefs, blocked }) {
  const evidence = evidenceRefs.length ? evidenceRefs : ["currentThesis"];
  return {
    setupStructure: observation(
      "The saved draft defines entry, stop and target around a reported liquidity sweep followed by a structure shift. The sweep and displacement are described in the thesis and selected charts; they are not independently verified.",
      ["proposal", "currentThesis", ...evidenceRefs.slice(0, 2)]),
    entryModelAssessment: observation(
      "The entry is placed at the proximal edge of the order block, which matches the supplied first-touch definition only if no earlier touch occurred. The charts do not establish whether the block was touched before.",
      ["strategy", "proposal"]),
    confluences: [
      observation("The recorded target sits at the liquidity named in the thesis, so the draw is stated before entry.", ["currentThesis", "proposal"]),
      ...(evidenceRefs.length ? [observation("The selected M5 chart shows the structure shift the thesis describes; this is the user's annotation, not verified market data.", evidence.slice(0, 1))] : []),
    ],
    weaknesses: [
      observation(evidenceRefs.length
        ? "Higher-timeframe context is limited to one screenshot; the H4 premium/discount position is not shown."
        : "Visual evidence was not supplied, so the sweep, the displacement and the first touch rest on the narrative alone.",
      evidenceRefs.length ? evidence.slice(0, 1) : ["currentThesis"]),
      ...(blocked ? [observation("The recorded Risk Engine result blocks this draft; this analysis does not change it.", ["deterministic"])] : []),
    ],
    invalidation: [observation("A documented earlier touch of the order block, or an M5 close beyond the sweep extreme, would contradict the stated model.", ["strategy", "currentThesis"])],
    observations: [observation("The thesis states both the reason for the trade and its invalidation, which makes a later review straightforward.", ["currentThesis"])],
    evidenceStatus: evidenceRefs.length ? "SELECTED_NOT_INDEPENDENTLY_VERIFIED" : "NONE_SELECTED",
  };
}

/** CHALLENGE_BIAS_V1 output (biasChallengeOutput). */
export function challengeOutput({ evidenceRefs }) {
  const chart = evidenceRefs.length ? evidenceRefs.slice(0, 1) : ["currentThesis"];
  return {
    counterArgument: observation(
      "The thesis treats the sweep as proof of demand, but a sweep can also start a deeper run toward higher-timeframe liquidity. Nothing recorded rules out that the move continues through the stop.",
      ["currentThesis", "proposal"]),
    invalidation: [
      observation("If the order block was already touched earlier in the session, the first-touch condition of the strategy no longer holds.", ["strategy", "proposal"]),
      observation("An M5 close back through the sweep extreme would show the structure shift failed.", ["currentThesis"]),
    ],
    missingEvidence: [observation(evidenceRefs.length
      ? "The selected charts show the setup timeframe only; no higher-timeframe chart supports the stated bias."
      : "No chart is selected, so the reported sweep and displacement are unverified.", chart)],
    questions: [
      observation("What would you need to see on H4 to abandon the bias before the order fills?", ["currentThesis"]),
      observation("Is the target the nearest opposing liquidity, or is there an untested level before it?", ["proposal", "currentThesis"]),
    ],
  };
}

/** Raw provider output that fails the ANALYZE_SETUP_V1 schema (sections missing): stored as a FAILED attempt. */
export function invalidAnalysisRaw() {
  return {
    setupStructure: { text: "The draft describes a long from an order block after a sweep.", sourceRefs: ["proposal"] },
    summary: "Response truncated before the remaining sections.",
  };
}

/** WEEKLY_REVIEW_V1 output (weeklyOutput) for weekly facts with at least one trade. */
export function weeklyOutput(facts) {
  const trades = (facts.trades ?? []).map(t => `trade:${t.tradeId}`);
  const first = trades.slice(0, 2);
  const sample = facts.sample?.count ?? trades.length;
  return {
    weekSummary: observation(`${sample} completed trade${sample === 1 ? "" : "s"} this week, all from locked plans. The sample is small, so every pattern below is tentative.`, ["sample", "period"]),
    processQuality: [observation("Each included trade has a locked plan with a written thesis before entry.", first.length ? first : ["sample"])],
    ruleAdherence: [observation("The recorded entries stayed on the valid side of the planned stop and the Risk Engine approved every lock.", first.length ? first : ["sample"])],
    setupModelPatterns: [observation("Both entry models appear; the sample is too small to compare them.", ["edge", "sample"])],
    executionMistakes: [observation("No execution mistake can be established from the recorded events alone; notes during the trades are sparse.", ["sample"])],
    behavioralPatterns: [observation("No recurring behaviour can be established from one week of records.", ["sample"])],
    whatImproved: [observation("Improvement cannot be established without a comparable earlier week in this request.", ["sample"])],
    needsAttention: [observation("Record a short note when a position is closed before the target, so the reason is reviewable.", trades.slice(0, 1).length ? trades.slice(0, 1) : ["sample"])],
    focusNextWeek: [observation("Keep writing the invalidation in every thesis and add one live note per trade.", ["sample"])],
  };
}

/**
 * REVIEW_TRADE_TIMELINE_V1 output for timeline facts. `refsOf(timing)` lists the timeline/evidence ids of one band.
 * Locked plans get CONSISTENT/ALIGNED (or DEVIATION for an oversized fill); trades without a plan get NOT_RECORDED/NO_PLAN.
 */
export function timelineReviewOutput(facts) {
  const sources = facts.sourceManifest.sources;
  const ofTiming = timing => sources.filter(s => (s.kind === "TIMELINE" || s.kind === "EVIDENCE") && s.timing === timing).map(s => s.id);
  const before = ofTiming("BEFORE_ENTRY"), live = ofTiming("WHILE_LIVE"), after = ofTiming("AFTER_CLOSE");
  const planned = facts.planStatus === "LOCKED_PLAN";
  const flagged = (facts.timeline ?? []).filter(item => (item.flags ?? []).includes("RECORDED_AFTER_EXECUTION_BEGAN")).map(item => item.sourceId);
  const oversize = facts.execution?.oversize === true;
  return {
    headline: observation(planned
      ? `The recorded execution followed the locked plan${oversize ? " except for the position size" : ""}; ${live.length ? "live management is documented" : "nothing was recorded while the trade was live"}.`
      : "No pre-trade plan was recorded, so the review can only describe the execution and the notes written while the trade was open.",
    ["execution", ...(planned ? ["originalPlan"] : [])]),
    thesisCheck: planned
      ? { assessment: "CONSISTENT", text: "The locked thesis names the sweep, the entry model and an invalidation level, and the pre-entry records do not change it before the entry.", sourceRefs: ["originalPlan", ...before.slice(0, 2)] }
      : { assessment: "NOT_RECORDED", text: "No thesis was recorded before execution; later notes cannot stand in for a pre-trade plan.", sourceRefs: ["strategy"] },
    executionVsPlan: planned
      ? (oversize
        ? { assessment: "DEVIATION", text: "The filled size is above the planned quantity, so the money at risk at the stop exceeded the locked risk even though the entry and stop followed the plan.", sourceRefs: ["execution", "originalPlan"] }
        : { assessment: "ALIGNED", text: "The recorded entry, stop and size match the locked plan within the recorded slippage.", sourceRefs: ["execution", "originalPlan"] })
      : { assessment: "NO_PLAN", text: "There is no locked plan to compare the execution with.", sourceRefs: ["execution"] },
    liveManagement: live.length
      ? { assessment: "DISCIPLINED", text: `${live.length} record${live.length === 1 ? " was" : "s were"} written while the trade was live and they describe holding the position as planned.${flagged.length ? " One note was recorded after the reported entry time but before the entry was logged; it is treated as a live record." : ""}`, sourceRefs: live.slice(0, 4) }
      : { assessment: "NO_LIVE_RECORDS", text: "Nothing was recorded while the trade was live, so management cannot be assessed.", sourceRefs: ["execution"] },
    patterns: flagged.length ? [observation("The entry was logged later than the reported entry time; recording the fill right away keeps the timeline unambiguous.", flagged.slice(0, 1))] : [],
    keyLesson: observation(after.length
      ? "Keep the post-trade note separate from the plan: it explains the outcome in hindsight and does not show what was known before entry."
      : "Add a short post-trade note so the outcome can be reviewed against the plan.", after.length ? after.slice(0, 1) : ["execution"]),
    limitations: ["One trade cannot establish a recurring pattern.", ...(facts.evidence?.length ? [] : ["No screenshots were selected for this review."])],
  };
}

/** A provider output whose thesis check cites an after-close record: the hindsight guard rejects it (FAILED). */
export function hindsightRaw(facts) {
  const output = timelineReviewOutput(facts);
  const after = facts.sourceManifest.sources.filter(s => s.timing === "AFTER_CLOSE").map(s => s.id);
  return { ...output, thesisCheck: { ...output.thesisCheck, sourceRefs: [...output.thesisCheck.sourceRefs.slice(0, 1), after[0]] } };
}
