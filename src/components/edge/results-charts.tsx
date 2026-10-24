import { DivergingBarChart, Histogram } from "@/components/charts/bar-chart";
import { formatTickMoney, formatTickR } from "@/components/charts/format";
import { DrawdownChart, LineChart } from "@/components/charts/line-chart";
import { Card, CardBody } from "@/components/ui/card";
import { plural } from "@/domain/format";
import type { CurveData, DailyData } from "./model";
import type { HistogramBin } from "@/components/charts/types";
import { ViewPanel, ViewSwitch, ViewSwitchButtons } from "./view-switch";

/**
 * Results over time (§13.6): cumulative R with its drawdown, daily results as diverging bars (Net R, or net P&L in
 * one currency at a time), and the R distribution. Every chart names its trading question, shows its sample, has a
 * table view, and drills down to the trade, the day or the bin in the Journal.
 */
export function ResultsCharts({ curve, daily, bins, rSample, drawdownSample, distributionSample }: {
  curve: CurveData;
  daily: DailyData;
  bins: HistogramBin[];
  rSample: string;
  drawdownSample: string;
  distributionSample: string;
}) {
  const options = [
    { value: "r", label: "Net R" },
    ...daily.money.map(entry => ({ value: `pnl:${entry.currency}`, label: daily.money.length > 1 ? `Net P&L · ${entry.currency}` : "Net P&L" })),
  ];
  const daySample = `${plural(daily.days, "trading day")} · exit day (UTC−5)`;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardBody>
          <LineChart
            title="Cumulative R"
            question="Is the process compounding?"
            sample={rSample}
            series={[{ id: "cumulative-r", name: "Cumulative R", points: curve.cumulative }]}
            xLabel="Exit day"
            formatTick={formatTickR}
            size="lg"
            empty={{ title: "No R results yet.", description: "Trades with a recorded risk appear here after they close." }}
          />
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <DrawdownChart
            title="R drawdown"
            question="Where am I giving profits back?"
            sample={drawdownSample}
            points={curve.drawdown}
            xLabel="Exit day"
            formatTick={formatTickR}
            size="lg"
            empty={{ title: "No drawdown to show.", description: "It appears once trades with a recorded risk have closed." }}
          />
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardBody>
          {/* Remounts when the currencies change, so a choice that no longer exists never hides every variant. */}
          <ViewSwitch key={options.map(option => option.value).join("|")} defaultValue="r">
            <ViewPanel value="r">
              <DivergingBarChart
                title="Daily net R"
                question="Which days drive results?"
                sample={daySample}
                data={daily.r}
                valueName="Net R"
                formatTick={formatTickR}
                actions={<ViewSwitchButtons label="Daily results in" options={options} />}
              />
            </ViewPanel>
            {daily.money.map(entry => (
              <ViewPanel key={entry.currency} value={`pnl:${entry.currency}`}>
                <DivergingBarChart
                  title={`Daily net P&L · ${entry.currency}`}
                  question="Which days drive results?"
                  sample={`${plural(entry.data.length, "trading day")} with ${entry.currency} trades · exit day (UTC−5)`}
                  data={entry.data}
                  valueName="Net P&L"
                  formatTick={formatTickMoney(entry.currency)}
                  actions={<ViewSwitchButtons label="Daily results in" options={options} />}
                />
              </ViewPanel>
            ))}
          </ViewSwitch>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <Histogram
            title="R distribution"
            question="How are outcomes distributed?"
            sample={distributionSample}
            bins={bins}
            formatEdge={formatTickR}
            binLabel="Realized R"
            empty={{ title: "No outcomes to distribute yet.", description: "Trades with a recorded risk appear here after they close." }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
