import { describe, expect, it } from "vitest";
import { type StrategyCardRiskPlan, strategyCard } from "@/domain/strategy-card";
import { ICT_V1 } from "@/domain/strategy";

const riskPlan: StrategyCardRiskPlan = {
  version: "Risk Plan V1.0", maxRiskPercent: "0.50000000", defaultRiskPercent: null, minRR: "3.00000000", rrPolicy: "BLOCK", newsPolicy: "WARN",
  maxDailyTrades: 2, dailyRiskCap: null, dailyLossCap: null, currency: "USD",
};
const WRITTEN_RULES = "You are my lead software architect, senior full-stack engineer and product designer.";

describe("strategy card", () => {
  const card = strategyCard(ICT_V1, riskPlan);
  const section = (id: string) => card.sections.find(s => s.id === id);

  it("titles the card with the strategy and risk plan versions", () => {
    expect(card.title).toBe("ICT V1.0");
    expect(card.subtitle).toBe("Risk Plan V1.0 · fixed UTC−5");
    expect(card.sections.map(s => s.title)).toEqual(["Entry models", "Sessions (UTC−5)", "Risk per trade", "Daily limits", "Policies", "Context", "Principles"]);
    expect(card.warnings).toEqual([]);
  });

  it("summarises both entry models from the rules", () => {
    const models = section("models")?.items ?? [];
    expect(models.map(item => item.label)).toEqual(["OB first touch", "OTE"]);
    expect(models[0].value).toBe("M5 Order Block first-touch mitigation after meaningful MSS/displacement.");
    expect(models[0].detail).toBe(ICT_V1.rules.OB_FIRST_TOUCH);
    expect(models[1].value).toBe("Valid separate entry model, not strategy drift.");
  });

  it("lists sessions in day order with their policy", () => {
    expect(section("sessions")?.items).toEqual([
      { label: "Asia · 18:00–01:00", value: "Allowed with a warning" },
      { label: "Judas · 01:00–02:00", value: "Allowed with a warning" },
      { label: "Kill zone · 02:00–12:00", value: "Active window" },
      { label: "Dead Pool · 12:00–18:00", value: "New plans blocked" },
    ]);
  });

  it("formats the risk policy exactly", () => {
    expect(section("risk")?.items).toEqual([
      { label: "Default risk per trade", value: "0.50% (same as maximum)" },
      { label: "Maximum risk per trade", value: "0.50%" },
      { label: "Trades per day", value: "2" },
      { label: "Minimum planned RR", value: "3.00R · blocks below the minimum" },
      { label: "Strategy minimum RR", value: "3.00R" },
    ]);
    expect(section("daily")?.items).toEqual([{ label: "Daily risk cap", value: "Not configured" }, { label: "Daily loss limit", value: "Not configured" }]);
    expect(section("policies")?.items[0]).toEqual({ label: "Restricted news window", value: "Allowed with a warning" });
  });

  it("shows configured caps in the account currency and an explicit default", () => {
    const configured = strategyCard(ICT_V1, { ...riskPlan, defaultRiskPercent: "0.25", newsPolicy: "BLOCK", rrPolicy: "WARN", dailyRiskCap: "150", dailyLossCap: "200.5", currency: "EUR" });
    const find = (id: string) => configured.sections.find(s => s.id === id)?.items ?? [];
    expect(find("risk")[0].value).toBe("0.25%");
    expect(find("risk")[3].value).toBe("3.00R · warns below the minimum");
    expect(find("daily").map(item => item.value)).toEqual(["€150.00", "€200.50"]);
    expect(find("policies")[0].value).toBe("Blocks new plans");
  });

  it("warns when the risk plan minimum is below the strategy's documented minimum", () => {
    const loose = strategyCard(ICT_V1, { ...riskPlan, minRR: "2.5" });
    expect(loose.warnings).toEqual(["Your risk plan minimum (2.50R) is below the strategy's documented 3.00R."]);
    expect(loose.sections.find(s => s.id === "risk")?.items[3].tone).toBe("warning");
  });

  it("never includes the written rules text", () => {
    const withWritten = strategyCard({ ...ICT_V1, written_rules: WRITTEN_RULES, writtenRules: WRITTEN_RULES }, riskPlan);
    expect(JSON.stringify(withWritten)).not.toContain("lead software architect");
    expect(withWritten).toEqual(card);
  });

  it("survives unexpected rules JSON without inventing content", () => {
    const minimal = strategyCard({ schema_version: 2 }, riskPlan);
    expect(minimal.title).toBe("Strategy");
    expect(minimal.sections.map(s => s.id)).toEqual(["risk", "daily", "policies"]);
    expect(strategyCard("not an object", riskPlan).sections.map(s => s.id)).toEqual(["risk", "daily", "policies"]);
  });
});
