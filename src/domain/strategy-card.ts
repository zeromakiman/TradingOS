import Decimal from "decimal.js";
import { z } from "zod";
import { firstSentence } from "./ai-summary";
import { formatDecimal, formatMoney, formatPercent } from "./format";

/**
 * Readable strategy card from the versioned rules JSON plus a risk plan version. Only the
 * structured rules are read: the strategy's `written_rules` text is never part of the card.
 */

const rulesSchema = z.object({
  version: z.string().min(1).optional(),
  execution_models: z.array(z.string()).optional(),
  minimum_rr: z.union([z.string(), z.number()]).optional(),
  context: z.array(z.string()).optional(),
  context_timeframes: z.array(z.string()).optional(),
  execution_timeframes: z.array(z.string()).optional(),
  sessions: z.record(z.string(), z.tuple([z.string(), z.string()])).optional(),
  rules: z.record(z.string(), z.string()).optional(),
});

export interface StrategyCardRiskPlan {
  version: string;
  maxRiskPercent: string;
  /** Null on legacy versions: the default equals the maximum. */
  defaultRiskPercent: string | null;
  minRR: string;
  rrPolicy: "BLOCK" | "WARN";
  newsPolicy: "BLOCK" | "WARN";
  maxDailyTrades: number;
  dailyRiskCap: string | null;
  dailyLossCap: string | null;
  /** Account currency of the caps. */
  currency: string;
}

export interface StrategyCardItem {
  label: string;
  value: string;
  /** Full rule text when `value` is a summary. */
  detail?: string;
  tone?: "warning";
}

export interface StrategyCardSection {
  id: string;
  title: string;
  items: StrategyCardItem[];
}

export interface StrategyCard {
  title: string;
  subtitle: string;
  sections: StrategyCardSection[];
  warnings: string[];
}

const MODEL_LABELS: Record<string, string> = { OB_FIRST_TOUCH: "OB first touch", OTE: "OTE" };
const SESSION_ORDER = [
  ["ASIA", "Asia", "Allowed with a warning"],
  ["JUDAS", "Judas", "Allowed with a warning"],
  ["ACTIVE_KILL_ZONE", "Kill zone", "Active window"],
  ["DEAD_POOL", "Dead Pool", "New plans blocked"],
] as const;
const PRINCIPLES = [
  ["MSS", "Market structure shift"],
  ["LIQUIDITY", "Liquidity"],
  ["TARGET", "Targets"],
  ["SESSION", "Sessions"],
  ["EVIDENCE", "Evidence"],
  ["PROCESS", "Process"],
] as const;

function textItem(label: string, text: string): StrategyCardItem {
  const summary = firstSentence(text);
  return summary === text.replace(/\s+/g, " ").trim() ? { label, value: summary } : { label, value: summary, detail: text };
}

function nonEmpty(section: StrategyCardSection): boolean {
  return section.items.length > 0;
}

export function strategyCard(rules: unknown, riskPlan: StrategyCardRiskPlan): StrategyCard {
  const parsed = rulesSchema.safeParse(rules);
  const strategy = parsed.success ? parsed.data : {};
  const ruleTexts = strategy.rules ?? {};
  const warnings: string[] = [];

  const models = (strategy.execution_models ?? []).map(model => {
    const text = ruleTexts[model];
    return text ? textItem(MODEL_LABELS[model] ?? model, text) : { label: MODEL_LABELS[model] ?? model, value: "Defined in the strategy version." };
  });

  const sessions = SESSION_ORDER.flatMap(([key, label, policy]) => {
    const window = strategy.sessions?.[key];
    return window ? [{ label: `${label} · ${window[0]}–${window[1]}`, value: policy }] : [];
  });

  const strategyMinimum = strategy.minimum_rr === undefined ? null : String(strategy.minimum_rr);
  const planMinimum = new Decimal(riskPlan.minRR);
  const belowStrategy = strategyMinimum !== null && /^\d+(\.\d+)?$/.test(strategyMinimum) && planMinimum.lt(strategyMinimum);
  if (belowStrategy && strategyMinimum !== null) {
    warnings.push(`Your risk plan minimum (${formatDecimal(riskPlan.minRR)}R) is below the strategy's documented ${formatDecimal(strategyMinimum)}R.`);
  }

  const risk: StrategyCardItem[] = [
    {
      label: "Default risk per trade",
      value: riskPlan.defaultRiskPercent === null ? `${formatPercent(riskPlan.maxRiskPercent)} (same as maximum)` : formatPercent(riskPlan.defaultRiskPercent),
    },
    { label: "Maximum risk per trade", value: formatPercent(riskPlan.maxRiskPercent) },
    { label: "Trades per day", value: String(riskPlan.maxDailyTrades) },
    {
      label: "Minimum planned RR",
      value: `${formatDecimal(riskPlan.minRR)}R · ${riskPlan.rrPolicy === "BLOCK" ? "blocks below the minimum" : "warns below the minimum"}`,
      ...(belowStrategy ? { tone: "warning" as const } : {}),
    },
    ...(strategyMinimum !== null && /^\d+(\.\d+)?$/.test(strategyMinimum) ? [{ label: "Strategy minimum RR", value: `${formatDecimal(strategyMinimum)}R` }] : []),
  ];

  const daily: StrategyCardItem[] = [
    { label: "Daily risk cap", value: riskPlan.dailyRiskCap === null ? "Not configured" : formatMoney(riskPlan.dailyRiskCap, riskPlan.currency) },
    { label: "Daily loss limit", value: riskPlan.dailyLossCap === null ? "Not configured" : formatMoney(riskPlan.dailyLossCap, riskPlan.currency) },
  ];

  const policies: StrategyCardItem[] = [
    { label: "Restricted news window", value: riskPlan.newsPolicy === "BLOCK" ? "Blocks new plans" : "Allowed with a warning" },
    { label: "News not checked", value: "Allowed with a warning" },
    { label: "Strategy contradiction flagged", value: "Blocks the plan" },
    { label: "Contract values", value: "Must be confirmed before locking" },
  ];

  const context: StrategyCardItem[] = [
    ...(strategy.context?.length ? [{ label: "Context", value: strategy.context.join(", ") }] : []),
    ...(strategy.context_timeframes?.length ? [{ label: "Context timeframes", value: strategy.context_timeframes.join(" · ") }] : []),
    ...(strategy.execution_timeframes?.length ? [{ label: "Execution timeframes", value: strategy.execution_timeframes.join(" · ") }] : []),
  ];

  const principles = PRINCIPLES.flatMap(([key, label]) => (ruleTexts[key] ? [textItem(label, ruleTexts[key])] : []));

  return {
    title: strategy.version ?? "Strategy",
    subtitle: `${riskPlan.version} · fixed UTC−5`,
    sections: [
      { id: "models", title: "Entry models", items: models },
      { id: "sessions", title: "Sessions (UTC−5)", items: sessions },
      { id: "risk", title: "Risk per trade", items: risk },
      { id: "daily", title: "Daily limits", items: daily },
      { id: "policies", title: "Policies", items: policies },
      { id: "context", title: "Context", items: context },
      { id: "principles", title: "Principles", items: principles },
    ].filter(nonEmpty),
    warnings,
  };
}
