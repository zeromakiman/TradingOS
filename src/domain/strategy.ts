export const ICT_V1 = {
  schema_version: 1, version: "ICT V1.0", utc_offset_minutes: -300,
  execution_models: ["OB_FIRST_TOUCH", "OTE"], minimum_rr: "3",
  context: ["Daily bias", "H4 context", "H1 context", "H4/H1 Fair Value Gaps", "Asian Range Liquidity", "Judas manipulation", "PDH", "PDL", "PWH", "PWL", "Kill Zone highs/lows", "internal liquidity", "external liquidity", "equal highs/lows", "previous-day 50%", "market structure", "displacement"],
  context_timeframes: ["D1", "H4", "H1"], execution_timeframes: ["M15", "M5", "M3"],
  sessions: { ACTIVE_KILL_ZONE: ["02:00", "12:00"], DEAD_POOL: ["12:00", "18:00"], ASIA: ["18:00", "01:00"], JUDAS: ["01:00", "02:00"] },
  rules: {
    OB_FIRST_TOUCH: "M5 Order Block first-touch mitigation after meaningful MSS/displacement. Bullish: bearish reversal candle that caused displacement, open/body down through lower unmitigated wick. Bearish: mirror using bullish reversal candle, open/body up through upper unmitigated wick. Exclude opposite/mitigated wick when appropriate. Entry is FIRST touch/mitigation of proximal edge. No additional confirmation inside OB or after valid first mitigation is required.",
    OTE: "Valid separate entry model, not strategy drift. Allowed when displacement leg is extended, OB too distant, OB inefficient, or OTE provides a better predefined execution location. Fibonacci thresholds and anchor conventions are not specified in this version.",
    MSS: "Evaluate meaningful broken structure, displacement quality, candle expansion, contextual importance of broken swing, preceding liquidity, and significance. A trivial crossed line is insufficient. Preserve ambiguity.",
    LIQUIDITY: "Record liquidity_swept, liquidity_target, liquidity_type, internal_or_external. ARL high/low, PDH/PDL, PWH/PWL, Kill Zone highs/lows, equal highs/lows, internal/external liquidity and prior major swing points. Equal highs/lows are not automatically a final external target.",
    TARGET: "Target must make contextual sense. ARL extremes, PDH/PDL, PWH/PWL, Kill Zone extremes, external liquidity, previous-day 50%, relevant structural liquidity.",
    SESSION: "Fixed UTC−5. Dead Pool normally blocks new discretionary trades. Judas is manipulation/fake-move window between Asia and London. Browser timezone never governs strategy sessions.",
    EVIDENCE: "Observed, user-reported and inferred evidence remain separate. Missing stays missing, uncertainty stays uncertain. Never invent levels, news or win probabilities.",
    PROCESS: "Written strategy is the source of truth. P&L never overrides process. AI cannot silently change definitions, risk or strategy versions."
  },
  ote_parameters: null, grade_policy: null
} as const;
