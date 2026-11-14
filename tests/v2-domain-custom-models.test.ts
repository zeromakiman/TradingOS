import { describe, expect, it, vi } from "vitest";
import { currentModels, reservedModelName } from "@/domain/custom-models";
import { LEDGER_COLUMNS, type LedgerTrade } from "@/domain/ledger";
import { breakdown } from "@/domain/performance";
import { breakdownFilters } from "@/lib/performance-data";
import { parseTradeFilters, tradeFilterParams } from "@/lib/trades-data";

vi.mock("server-only", () => ({}));

// 0020 custom models: the pure model list, the "By custom model" breakdown and the Journal filter. "By model" (the
// entry model) is never changed by a custom model.

const ACCOUNT = "20000000-0000-4000-8000-00000000000a";
const TSP = "c0000000-0000-4000-8000-000000000001";
const BREAKER = "c0000000-0000-4000-8000-000000000002";

let counter = 0;
function closed(r: string, changes: Partial<LedgerTrade> = {}): LedgerTrade {
  counter += 1;
  const blank = Object.fromEntries(LEDGER_COLUMNS.map(column => [column, null])) as unknown as LedgerTrade;
  return {
    ...blank, id: `10000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, account_id: ACCOUNT, origin: "LIVE_FIRST", created_at: "2026-09-01T10:00:00Z",
    currency: "USD", revision_count: 0, entry_time_known: true, lifecycle: "CLOSED", tags: [], evidence_count: 0, journal_count: 0, ai_review_count: 0,
    entered_at: "2026-09-01T14:00:00Z", exited_at: "2026-09-01T15:00:00Z", realized_r: r, net_pnl: String(Number(r) * 50), fees: "0",
    outcome: Number(r) > 0 ? "WIN" : "LOSS", entry_model: "OTHER", direction: "LONG", symbol: "EURUSD", ...changes,
  };
}

describe("custom model list", () => {
  it("takes each model's latest revision, sorts by name and marks models recorded on trades", () => {
    const models = currentModels(
      [{ id: TSP, account_id: ACCOUNT, created_at: "2026-11-01T10:00:00Z" }, { id: BREAKER, account_id: ACCOUNT, created_at: "2026-11-02T10:00:00Z" }],
      [
        { id: 1, model_id: TSP, name: "TSP", description: null, status: "ACTIVE" },
        { id: 2, model_id: BREAKER, name: "Breaker", description: "Old", status: "ACTIVE" },
        { id: 3, model_id: TSP, name: "TSP + IFVG + CISD", description: "Turtle soup", status: "ACTIVE" },
        { id: 4, model_id: BREAKER, name: "Breaker block", description: null, status: "ARCHIVED" },
      ],
      [{ model_id: TSP }, { model_id: null }],
    );
    expect(models.map(model => [model.name, model.status, model.used])).toEqual([["Breaker block", "ARCHIVED", false], ["TSP + IFVG + CISD", "ACTIVE", true]]);
  });

  it("reserves the Risk Engine's own model names, case- and spacing-insensitively", () => {
    for (const name of ["OB first touch", "ob_first_touch", " OTE ", "other", "OB  FIRST   touch"]) expect(reservedModelName(name), name).toBe(true);
    for (const name of ["OTE 2", "Breaker", "Other model"]) expect(reservedModelName(name), name).toBe(false);
  });
});

describe("By custom model", () => {
  it("groups only trades recorded with a custom model and leaves By model unchanged", () => {
    const trades = [
      closed("2", { custom_model_id: TSP, custom_model_name: "TSP + IFVG + CISD" }),
      closed("-1", { custom_model_id: TSP, custom_model_name: "TSP + IFVG + CISD" }),
      closed("1", { custom_model_id: BREAKER, custom_model_name: "Breaker" }),
      closed("3", { entry_model: "OTE", origin: "PLANNED" }),
      closed("-1"),
    ];
    const groups = breakdown(trades, "customModel");
    expect(groups.map(group => [group.label, group.value, group.closed, group.metrics.netR])).toEqual([["Breaker", BREAKER, 1, "1"], ["TSP + IFVG + CISD", TSP, 2, "1"]]);
    expect(breakdown(trades, "model").map(group => [group.value, group.closed])).toEqual([["OTE", 1], ["OTHER", 4]]);
    expect(breakdown(trades.slice(3), "customModel")).toEqual([]);
  });

  it("drills into the Journal's customModel filter, which round-trips through the URL", () => {
    expect(breakdownFilters("customModel", TSP, {})).toMatchObject({ customModel: TSP });
    const params = tradeFilterParams({ customModel: TSP });
    expect(params.get("customModel")).toBe(TSP);
    expect(parseTradeFilters(params)).toEqual({ filters: { customModel: TSP }, invalid: [] });
    expect(parseTradeFilters(new URLSearchParams("customModel=nope")).invalid).toEqual(["customModel"]);
  });
});
