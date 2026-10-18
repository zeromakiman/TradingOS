import Decimal from "decimal.js";
import { CircleHelp, Info, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { DivergingBarChart, Histogram } from "@/components/charts/bar-chart";
import { CalendarHeatmap } from "@/components/charts/calendar-heatmap";
import { formatTickMoney, formatTickR } from "@/components/charts/format";
import { HBarChart } from "@/components/charts/hbar-chart";
import { DrawdownChart, type DrawdownPoint, LineChart } from "@/components/charts/line-chart";
import { Sparkline } from "@/components/charts/sparkline";
import type { CalendarHeatmapDay, CalendarMode, ChartDatum, HistogramBin } from "@/components/charts/types";
import { AppShell } from "@/components/shell/app-shell";
import { isThemePreference } from "@/components/shell/preference-options";
import { ThemeSwitcher } from "@/components/shell/theme-switcher";
import { TimeDisplaySwitcher } from "@/components/shell/time-display-switcher";
import type { AccountContextSelection, PaletteIndex, ShellAccount, ThemePreference } from "@/components/shell/types";
import { Badge, StatusPill, type StatusTone } from "@/components/ui/badge";
import { Button, buttonClasses, IconButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, ChoiceChips, RadioCards, SegmentedControl, SegmentedLinks, Switch } from "@/components/ui/choice";
import { DecimalInput } from "@/components/ui/decimal-input";
import { ConfirmDialogDemo, DecimalInputDemo, FormAlertDemo, MenuDemo, ToastDemo } from "@/components/ui/dev-gallery-demos";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger, Sheet, SheetContent, SheetTrigger } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { FilterChips } from "@/components/ui/filter-chips";
import { Input, Select } from "@/components/ui/input";
import { Kbd, KbdCombo } from "@/components/ui/kbd";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LoadingState, Refetching, Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Stepper } from "@/components/ui/stepper";
import { TabLinks } from "@/components/ui/tab-links";
import { DataTable } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { formatMoney, formatR, formatSignedMoney } from "@/domain/format";

export const metadata: Metadata = { title: "UI gallery · Trading OS", robots: { index: false, follow: false } };

/** Developer-only: available outside production builds, or when TRADING_OS_DEV_PAGES=true. */
function galleryEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.TRADING_OS_DEV_PAGES === "true";
}

// ── Synthetic data (no real accounts, trades or money) ───────────────────────────────

const ACCOUNTS: ShellAccount[] = [
  { id: "0d8e5f2a-4c1b-4a7e-9f3d-6b2c8e1a5d70", name: "FTMO 100K", currency: "USD", status: "ACTIVE", type: "EVALUATION" },
  { id: "5a1c9e7b-2d4f-4b8a-8c6e-3f7d1b9a2e40", name: "Personal EUR", currency: "EUR", status: "ACTIVE", type: "PERSONAL" },
  { id: "9c3b7d1e-6a2f-4e5b-a1d8-4c7e2f9b3a60", name: "Demo 10K (2025)", currency: "USD", status: "ARCHIVED", type: "DEMO" },
];

const PALETTE: PaletteIndex = {
  accounts: ACCOUNTS,
  liveTrades: [{ id: "1f0e2d3c-4b5a-4968-8776-655443322110", symbol: "GBPUSD", direction: "SHORT", accountName: "FTMO 100K", dateLabel: "Oct 14", stateLabel: "Live", tags: ["london", "sweep"] }],
  recentTrades: [
    { id: "2e1d3c4b-5a69-4877-9665-544332211009", symbol: "EURUSD", direction: "LONG", accountName: "FTMO 100K", dateLabel: "Oct 13", stateLabel: "Reviewed", tags: ["breakout"], resultLabel: "+2.10R" },
    { id: "3d2c4b5a-6978-4866-a554-433221100998", symbol: "XAUUSD", direction: "SHORT", accountName: "Personal EUR", dateLabel: "Oct 12", stateLabel: "Closed · review pending", tags: [], resultLabel: "-1.00R" },
  ],
};

const R_RESULTS = ["1.2", "-1", "2.5", "-1", "-0.4", "3.1", "-1", "0", "1.8", "-1", "2.2", "-0.5", "1.1", "-1", "2.9", "-1", "0.6", "-1", "1.4", "2.05"];

function cumulative(values: string[]) {
  let total = new Decimal(0);
  let peak = new Decimal(0);
  return values.map((value) => {
    total = total.plus(value);
    peak = Decimal.max(peak, total);
    // Distance below the running peak (≥ 0), as the domain's drawdownSeries() reports it.
    return { total: total.toFixed(), drawdown: peak.minus(total).toFixed() };
  });
}

const CURVE = cumulative(R_RESULTS);
const NET_R = formatR(CURVE[CURVE.length - 1].total);

const tradePoint = (index: number, value: string, valueLabel: string, detail?: string): ChartDatum => ({
  key: `trade-${index}`,
  label: `Trade ${index + 1}`,
  value,
  valueLabel,
  href: `/journal?sequence=${index + 1}`,
  detail,
});

const CUMULATIVE_R = CURVE.map((point, index) => tradePoint(index, point.total, formatR(point.total), `Trade result ${formatR(R_RESULTS[index])}`));
const DRAWDOWN_R: DrawdownPoint[] = CURVE.map((point, index) => ({ key: `trade-${index}`, label: `Trade ${index + 1}`, value: point.drawdown, href: `/journal?sequence=${index + 1}` }));

const OCTOBER_DAYS = ["01", "02", "05", "06", "07", "08", "09", "12", "13", "14", "15", "16"];
const DAILY_R = ["1.2", "-1", "1.5", "-1.4", "3.1", "-1", "0", "0.8", "1.2", "-1.5", "2.9", "-0.4"];
const DAILY_TRADES = [1, 1, 2, 2, 1, 1, 1, 2, 2, 2, 1, 2];

const dayLabel = (day: string) => `Oct ${Number.parseInt(day, 10)}`;
const tradesLabel = (count: number) => `${count} ${count === 1 ? "trade" : "trades"}`;

const DAILY: ChartDatum[] = OCTOBER_DAYS.map((day, index) => ({
  key: `2026-10-${day}`,
  label: dayLabel(day),
  value: DAILY_R[index],
  valueLabel: formatR(DAILY_R[index]),
  href: `/journal?from=2026-10-${day}&to=2026-10-${day}`,
  detail: tradesLabel(DAILY_TRADES[index]),
}));

/** The heatmap formats each value for its mode; days carry only the value, details and links. */
const CALENDAR_DAYS: Record<CalendarMode, CalendarHeatmapDay[]> = {
  NET_R: DAILY.map((day) => ({ day: day.key, value: day.value, detail: day.detail, href: day.href })),
  NET_PNL: DAILY.map((day, index) => ({ day: day.key, value: new Decimal(DAILY_R[index]).mul(500).toFixed(), detail: day.detail, href: day.href })),
  GROSS_LOSS: DAILY.flatMap((day, index) => (new Decimal(DAILY_R[index]).isNegative() ? [{ day: day.key, value: new Decimal(DAILY_R[index]).mul(-500).toFixed(), detail: day.detail, href: day.href }] : [])),
  COUNT: DAILY.map((day, index) => ({ day: day.key, value: String(DAILY_TRADES[index]), href: day.href })),
};

const CALENDAR_VALUE_NAMES: Record<CalendarMode, string> = { NET_R: "Net R", NET_PNL: "Net P&L", GROSS_LOSS: "Gross realized loss", COUNT: "Closed trades" };

const CALENDAR_MODE_LABELS: [CalendarMode, string][] = [
  ["NET_R", "Net R"],
  ["NET_PNL", "Net P&L"],
  ["GROSS_LOSS", "Loss"],
  ["COUNT", "Trades"],
];

const isCalendarMode = (value: unknown): value is CalendarMode => CALENDAR_MODE_LABELS.some(([mode]) => mode === value);

const HISTOGRAM_BINS: HistogramBin[] = ["-1.5", "-1", "-0.5", "0", "0.5", "1", "1.5", "2", "2.5", "3"].map((from) => {
  const to = new Decimal(from).plus("0.5").toFixed();
  const count = R_RESULTS.filter((result) => new Decimal(result).gte(from) && new Decimal(result).lt(to)).length;
  return { label: `${formatTickR(from)} to ${formatTickR(to)}`, from, to, count, countLabel: tradesLabel(count), href: `/journal?rFrom=${from}&rTo=${to}` };
});

/** Outliers collect in open-ended edge bins, as `distributionR` returns them. */
const OUTLIER_BINS: HistogramBin[] = [
  { label: "Below -2.0R", from: null, to: "-2", count: 1, countLabel: tradesLabel(1) },
  ...HISTOGRAM_BINS.filter((bin) => bin.from !== null && new Decimal(bin.from).gte("-1")),
  { label: "+3.5R and above", from: "3.5", to: null, count: 2, countLabel: tradesLabel(2) },
];

const BY_MODEL: ChartDatum[] = [
  { key: "OB_FIRST_TOUCH", label: "OB first touch", value: "6.8", valueLabel: formatR("6.8"), detail: "N = 12 · emerging tendency", href: "/journal?model=OB_FIRST_TOUCH" },
  { key: "OTE", label: "OTE", value: "-1.35", valueLabel: formatR("-1.35"), detail: "N = 8 · insufficient evidence", href: "/journal?model=OTE" },
];

const BY_SESSION: ChartDatum[] = [
  { key: "KZ", label: "Kill zone", value: "8.1", valueLabel: formatR("8.1"), detail: "N = 14", href: "/journal?session=ACTIVE_KILL_ZONE" },
  { key: "JUDAS", label: "Judas", value: "-0.4", valueLabel: formatR("-0.4"), detail: "N = 3", href: "/journal?session=JUDAS" },
  { key: "ASIA", label: "Asia", value: "-2.25", valueLabel: formatR("-2.25"), detail: "N = 3", href: "/journal?session=ASIA" },
];

const CONTRIBUTION: ChartDatum[] = [
  { key: "ftmo", label: "FTMO 100K", value: "72.5", valueLabel: "72.5%", detail: "+7.98R · +$7,980.00", href: `/accounts/${ACCOUNTS[0].id}` },
  { key: "personal", label: "Personal EUR", value: "27.5", valueLabel: "27.5%", detail: "+3.02R · +€1,510.00", href: `/accounts/${ACCOUNTS[1].id}` },
];

const BALANCE = (() => {
  let balance = new Decimal("100000");
  return R_RESULTS.map((result, index) => {
    balance = balance.plus(new Decimal(result).mul(500));
    return tradePoint(index, balance.toFixed(), formatMoney(balance.toFixed(), "USD"), `Trade result ${formatSignedMoney(new Decimal(result).mul(500).toFixed(), "USD")}`);
  });
})();

const PER_ACCOUNT = (() => {
  let ftmo = new Decimal(0);
  let personal = new Decimal(0);
  return R_RESULTS.slice(0, 12).map((result, index) => {
    if (index % 3 === 2) personal = personal.plus(result);
    else ftmo = ftmo.plus(result);
    return { ftmo: tradePoint(index, ftmo.toFixed(), formatR(ftmo.toFixed())), personal: tradePoint(index, personal.toFixed(), formatR(personal.toFixed())) };
  });
})();

const TONES: { tone: StatusTone; label: string }[] = [
  { tone: "neutral", label: "Draft" },
  { tone: "danger", label: "Blocked" },
  { tone: "positive", label: "Ready to lock" },
  { tone: "warning", label: "Recheck needed" },
  { tone: "info", label: "Locked · waiting for entry" },
  { tone: "live", label: "Live" },
  { tone: "neutral", label: "Closed · review pending" },
  { tone: "positive-muted", label: "Reviewed" },
  { tone: "muted", label: "Skipped" },
];

const TOKENS = ["--bg", "--surface", "--surface-raised", "--surface-sunken", "--border", "--border-strong", "--text", "--text-2", "--text-3", "--accent", "--accent-soft", "--pos-text", "--pos-soft", "--neg-text", "--neg-soft", "--warn-text", "--warn-soft", "--live"];
const CHART_TOKENS = ["--chart-pos", "--chart-neg", "--series-1", "--series-2", "--series-3", "--chart-grid", "--chart-axis"];

type JournalRow = { id: string; trade: string; date: string; account: string; result: string; negative: boolean; state: { tone: StatusTone; label: string } };

const JOURNAL_ROWS: JournalRow[] = [
  { id: "a", trade: "EURUSD · Long", date: "Oct 13 · 09:42", account: "FTMO 100K", result: "+2.10R · +$1,050.00", negative: false, state: { tone: "positive-muted", label: "Reviewed" } },
  { id: "b", trade: "XAUUSD · Short", date: "Oct 12 · 03:15", account: "Personal EUR", result: "-1.00R · -€500.00", negative: true, state: { tone: "neutral", label: "Closed · review pending" } },
  { id: "c", trade: "GBPUSD · Short", date: "Oct 14 · 08:05", account: "FTMO 100K", result: "Open", negative: false, state: { tone: "live", label: "Live" } },
];

// ── Page ─────────────────────────────────────────────────────────────────────────────

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section className="gallery-section" aria-labelledby={id}>
      <SectionHeader id={id} title={title} description={description} />
      {children}
    </section>
  );
}

function Swatches({ tokens }: { tokens: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tokens.map((token) => (
        <li key={token} className="flex items-center gap-2">
          <span className="size-8 flex-none rounded-control border border-border" style={{ background: `var(${token})` }} aria-hidden="true" />
          <code className="t-caption">{token}</code>
        </li>
      ))}
    </ul>
  );
}

function ChartsSection({ calendarMode }: { calendarMode: CalendarMode }) {
  return (
    <Section id="charts" title="Charts" description="Hand-written SVG and HTML marks with a client tooltip layer, keyboard focusable marks, drill-down links and a table view.">
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardBody>
            <LineChart title="Cumulative R" question="Is the process compounding?" sample="20 closed trades · developing sample" series={[{ id: "cumulative", name: "Cumulative R", points: CUMULATIVE_R }]} xLabel="Trade" formatTick={formatTickR} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <DrawdownChart title="R drawdown" question="Where am I giving profits back?" sample="20 closed trades" points={DRAWDOWN_R} xLabel="Trade" formatTick={formatTickR} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <DivergingBarChart title="Daily net R" question="Which days drive results?" sample="12 trading days" data={DAILY} valueName="Net R" formatTick={formatTickR} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <CalendarHeatmap
              title="Calendar"
              question="When am I winning or losing?"
              sample={calendarMode === "NET_PNL" || calendarMode === "GROSS_LOSS" ? "12 trading days · USD · UTC−5 strategy days" : "12 trading days · UTC−5 strategy days"}
              month="2026-10"
              mode={calendarMode}
              currency="USD"
              valueName={CALENDAR_VALUE_NAMES[calendarMode]}
              days={CALENDAR_DAYS[calendarMode]}
              today="2026-10-14"
              previousMonth={{ href: "/dev/ui?month=2026-09", label: "September 2026" }}
              nextMonth={{ href: "/dev/ui?month=2026-11", label: "November 2026" }}
              modeLinks={CALENDAR_MODE_LABELS.map(([mode, label]) => ({ href: `/dev/ui?calendar=${mode}`, label, current: calendarMode === mode }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-8">
            <Histogram title="R distribution" question="How are outcomes distributed?" sample="20 closed trades · 0.5R bins" bins={HISTOGRAM_BINS} formatEdge={formatTickR} binLabel="R range" />
            <Histogram title="R distribution with outliers" question="How are outcomes distributed?" sample="Open-ended edge bins" bins={OUTLIER_BINS} formatEdge={formatTickR} binLabel="R range" />
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-8">
            <HBarChart title="Net R by model" question="Which conditions perform?" sample="20 closed trades" data={BY_MODEL} categoryLabel="Model" valueName="Net R" />
            <HBarChart title="Net R by session" question="Which conditions perform?" data={BY_SESSION} categoryLabel="Session" valueName="Net R" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <HBarChart title="Account contribution" question="Which account contributes most?" sample="Share of net R · R is per-trade risk units" data={CONTRIBUTION} tone="series-1" categoryLabel="Account" valueName="Share of net R" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <LineChart title="Balance from trades" question="How has the balance moved with recorded results?" sample="Starting balance + realized P&L recorded in Trading OS" series={[{ id: "balance", name: "Balance from trades", points: BALANCE }]} xLabel="Trade" includeZero={false} formatTick={formatTickMoney("USD")} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <LineChart
              title="Cumulative R by account"
              question="Is each account compounding?"
              sample="12 closed trades · early sample"
              series={[
                { id: "ftmo", name: "FTMO 100K", points: PER_ACCOUNT.map((point) => point.ftmo) },
                { id: "personal", name: "Personal EUR", points: PER_ACCOUNT.map((point) => point.personal) },
              ]}
              xLabel="Trade"
              formatTick={formatTickR}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <LineChart
              title="Cumulative R"
              question="Is the process compounding?"
              sample="No closed trades"
              series={[{ id: "empty", name: "Cumulative R", points: [] }]}
              empty={{ title: "No closed trades yet.", description: "Record or plan a trade; results appear here after you close it.", actions: <Link href="/trades/new" className={buttonClasses({ variant: "secondary", size: "sm" })}>Plan Trade</Link> }}
            />
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

function ThemePreview({ theme }: { theme: "light" | "dark" }) {
  return (
    <div data-theme={theme} className="theme-preview flex flex-col gap-4">
      <p className="t-meta font-semibold">{theme === "light" ? "Light" : "Dark"}</p>
      <div className="gallery-row">
        <Button>Plan Trade</Button>
        <Button variant="secondary">Record Live Trade</Button>
        <Button variant="danger">Discard</Button>
      </div>
      <div className="gallery-row">
        {TONES.slice(0, 6).map((item) => (
          <StatusPill key={item.label} tone={item.tone}>
            {item.label}
          </StatusPill>
        ))}
      </div>
      <Callout tone="negative" title="Blocked">
        Requested risk 0.504% exceeds your configured maximum of 0.50%.
      </Callout>
      <StatGroup>
        <Stat label="Net R" value={<span className="value-pos">{NET_R}</span>} hint="20 closed trades" />
        <Stat label="Realized losses today" value="$50.00" hint="1 closed trade" />
      </StatGroup>
      <DivergingBarChart title="Daily net R" question="Which days drive results?" data={DAILY.slice(0, 8)} valueName="Net R" formatTick={formatTickR} />
    </div>
  );
}

export default async function UiGalleryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  if (!galleryEnabled()) notFound();

  const params = await searchParams;
  const requested = typeof params.account === "string" ? params.account : "all";
  const context: AccountContextSelection = ACCOUNTS.some((account) => account.id === requested) ? { mode: "account", accountId: requested } : { mode: "all" };
  // ?theme=light|dark|system pins the theme (for screenshots); ?calendar=NET_R|NET_PNL|GROSS_LOSS|COUNT switches the calendar mode.
  const theme: ThemePreference = typeof params.theme === "string" && isThemePreference(params.theme) ? params.theme : "system";
  const calendarMode: CalendarMode = isCalendarMode(params.calendar) ? params.calendar : "NET_R";

  return (
    <AppShell user={{ email: "gallery@example.com" }} accounts={ACCOUNTS} context={context} clock={{ nowIso: new Date().toISOString() }} paletteIndex={PALETTE} developerMode={false} theme={theme}>
      <PageHeader
        eyebrow="Developer"
        title="Design system gallery"
        description="Every primitive, chart and shell component with synthetic data. Switch the theme here or from the account menu; the side-by-side section shows both themes at once."
        actions={<ThemeSwitcher theme={theme} name="gallery-theme" legendHidden />}
      />

      <Section id="tokens" title="Tokens" description="Semantic colour is reserved for meaning; the accent is for interaction only.">
        <Swatches tokens={TOKENS} />
        <SectionHeader as="h3" title="Chart colours" description="Validated with the dataviz checks (CVD separation, contrast)." />
        <Swatches tokens={CHART_TOKENS} />
      </Section>

      <Section id="type" title="Typography" description="System UI stack; 12 · 13 · 14 · 16 · 18 · 20 · 24 · 30; tabular figures in tables and axes.">
        <div className="flex flex-col gap-1">
          <p className="text-xs">12 — Caption and axis labels</p>
          <p className="t-meta">13 — Meta lines and hints</p>
          <p className="text-sm">14 — Body text on desktop</p>
          <p className="text-base">16 — Section titles</p>
          <p className="text-lg font-semibold">18 — Dialog titles</p>
          <p className="text-xl font-semibold">20 — Large values</p>
          <p className="text-2xl font-semibold">24 — Page titles</p>
          <p className="text-3xl font-semibold">30 — Hero figures {NET_R}</p>
          <p className="num t-meta">Tabular: 1.10000 · 1.09800 · 1.10600</p>
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <div className="gallery-row">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="gallery-row">
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
          <Button icon={<Plus aria-hidden="true" />}>Plan Trade</Button>
          <Button loading loadingText="Checking risk…">
            Check risk
          </Button>
          <Button disabled variant="secondary">
            Disabled
          </Button>
          <IconButton label="Search" icon={<Search />} tooltip />
          <IconButton label="Help" icon={<CircleHelp />} variant="secondary" size="sm" tooltip />
          <Button asChild variant="secondary">
            <Link href="/journal">Link as button</Link>
          </Button>
        </div>
      </Section>

      <Section id="status" title="Status pills and badges" description="Every state has a word; colour is never the only signal.">
        <div className="gallery-row">
          {TONES.map((item) => (
            <StatusPill key={item.label} tone={item.tone}>
              {item.label}
            </StatusPill>
          ))}
        </div>
        <div className="gallery-row">
          <Badge>Planned</Badge>
          <Tooltip content="No pre-trade plan was recorded before execution">
            <button type="button" className="badge">
              Live-first
            </button>
          </Tooltip>
          <Badge>Imported</Badge>
          <Badge tone="accent">Selected for AI</Badge>
        </div>
      </Section>

      <Section id="cards" title="Cards and statistics">
        <div className="gallery-grid">
          <Card as="section" aria-labelledby="gallery-card-title">
            <CardHeader>
              <div>
                <CardTitle id="gallery-card-title" as="h3">
                  Trading status
                </CardTitle>
                <CardDescription>FTMO 100K · USD · Evaluation</CardDescription>
              </div>
              <StatusPill tone="positive">You can trade</StatusPill>
            </CardHeader>
            <CardBody>
              <StatGroup>
                <Stat label="Trades left" value="1 of 2" />
                <Stat label="Risk left" value="$250.00" hint="Cap $500.00" />
                <Stat label="Today" value={<span className="value-pos">+1.20R</span>} delta={{ value: "+$600.00", tone: "positive", label: "today" }} />
              </StatGroup>
            </CardBody>
            <CardFooter>
              <Button variant="secondary" size="sm">
                Add external loss
              </Button>
              <Button size="sm">Plan Trade</Button>
            </CardFooter>
          </Card>
          <Card>
            <CardBody className="flex flex-col gap-4">
              <Stat size="lg" label="Net R" value={<span className="value-pos">{NET_R}</span>} hint="20 closed trades · R is per-trade risk units" />
              <Sparkline values={CURVE.map((point) => point.total)} tone="series-1" label={`Cumulative R over the last 20 trades, ending at ${NET_R}`} />
              <StatGroup>
                <Stat label="Win rate" value="50.00%" early hint="Early sample — more data is needed before drawing strong conclusions." />
                <Stat label="Profit factor" value="2.31" early />
              </StatGroup>
            </CardBody>
          </Card>
        </div>
      </Section>

      <Section id="callouts" title="Callouts">
        <div className="flex flex-col gap-3">
          <Callout tone="info" title="Strategy days use fixed UTC−5">
            Sessions and daily limits follow the strategy clock.
          </Callout>
          <Callout tone="positive" title="Ready to lock">
            Every rule passes for revision 2.
          </Callout>
          <Callout
            tone="warning"
            title="Recheck needed"
            action={
              <Button size="sm" variant="secondary">
                Recheck risk
              </Button>
            }
          >
            The session changed since the last check.
          </Callout>
          <Callout tone="negative" title="Blocked">
            Planned RR 2.99R is below the required minimum of 3.00R.
          </Callout>
          <Callout tone="neutral" icon={<Info aria-hidden="true" />}>
            No pre-trade plan was recorded before execution.
          </Callout>
        </div>
      </Section>

      <Section id="forms" title="Forms" description="Labels, hints and errors are linked with aria-describedby; decimals stay exact strings.">
        <div className="gallery-grid">
          <div className="flex flex-col gap-4">
            <Field label="Trading Account" required hint="Plan Trade always names the account explicitly.">
              <Select name="account" defaultValue={ACCOUNTS[0].id}>
                {ACCOUNTS.filter((account) => account.status === "ACTIVE").map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </Select>
            </Field>
            <DecimalInputDemo />
            <Field label="Risk per trade" error="Risk per trade must not exceed the maximum of 0.75%." required>
              <DecimalInput name="risk" defaultValue="0.80" endAdornment="%" />
            </Field>
            <Field label="Search" optional>
              <Input type="search" placeholder="Instrument, tag or note" />
            </Field>
            <Field label="Why this trade? What would invalidate it?" required hint="Thesis, recorded Before entry.">
              <Textarea name="thesis" defaultValue="Liquidity taken below Asia low; M5 market structure shift into the H1 order block." />
            </Field>
          </div>
          <div className="flex flex-col gap-4">
            <SegmentedControl
              name="direction"
              legend="Direction"
              legendHidden={false}
              defaultValue="LONG"
              options={[
                { value: "LONG", label: "Long" },
                { value: "SHORT", label: "Short" },
              ]}
            />
            <RadioCards
              name="model"
              legend="Model"
              defaultValue="OB_FIRST_TOUCH"
              options={[
                { value: "OB_FIRST_TOUCH", label: "OB first touch", description: "First mitigation of the order block." },
                { value: "OTE", label: "OTE", description: "Predefined retracement into the optimal trade entry." },
              ]}
            />
            <ChoiceChips
              name="risk-preset"
              legend="Risk presets"
              defaultValue="0.50"
              options={[
                { value: "0.25", label: "0.25%" },
                { value: "0.50", label: "0.50%" },
                { value: "0.75", label: "0.75%" },
                { value: "1.00", label: "1.00%", disabled: true },
              ]}
            />
            <Checkbox name="contract" label="Contract values match my broker" description="EURUSD · tick 0.00001 · $1.00 per tick · 0.01 lots minimum" />
            <Switch name="developer" label="Show technical details expanded" description="Developer mode (cookie tos_dev)." />
            <FormAlertDemo />
          </div>
        </div>
      </Section>

      <Section id="navigation" title="Navigation">
        <Tabs defaultValue="profile">
          <TabsList aria-label="Manage account">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="values">Account values</TabsTrigger>
            <TabsTrigger value="losses">External losses</TabsTrigger>
          </TabsList>
          <TabsContent value="profile">Name, broker, platform, type and starting balance.</TabsContent>
          <TabsContent value="values">Confirm today&apos;s balance and equity.</TabsContent>
          <TabsContent value="losses">External realized losses today.</TabsContent>
        </Tabs>
        <TabLinks
          label="Review"
          items={[
            { href: "/review/weekly", label: "Weekly", current: true },
            { href: "/review/recent", label: "Recent trades" },
            { href: "/review/monthly", label: "Monthly" },
            { href: "/review", label: "History" },
          ]}
        />
        <SegmentedLinks
          label="Calendar mode"
          items={[
            { href: "/dev/ui?calendar=NET_R", label: "Net R", current: true },
            { href: "/dev/ui?calendar=NET_PNL", label: "Net P&L" },
            { href: "/dev/ui?calendar=COUNT", label: "Trade count" },
          ]}
        />
        <Stepper label="Trade progress" current="locked" steps={["Draft", "Validated", "Locked", "Live", "Closed", "Reviewed"].map((label) => ({ id: label.toLowerCase(), label }))} />
        <Stepper label="Trade progress" current="reviewed" complete steps={["Draft", "Validated", "Locked", "Live", "Closed", "Reviewed"].map((label) => ({ id: label.toLowerCase(), label }))} />
        <FilterChips
          chips={[
            { key: "model", label: "Model: OTE", removeHref: "/dev/ui?result=win" },
            { key: "result", label: "Result: Win", removeHref: "/dev/ui?model=OTE" },
          ]}
          clearHref="/dev/ui"
        />
        <Pagination previous={{ href: "/dev/ui?page=1" }} next={{ href: "/dev/ui?page=3" }} summary="Page 2 · 50 per page" />
      </Section>

      <Section id="preferences" title="Preferences" description="Settings → General. The time display is formatted on the server, so its switch is disabled until a server action is wired, as here.">
        <div className="flex flex-col gap-4">
          <ThemeSwitcher theme={theme} name="gallery-theme-settings" />
          <TimeDisplaySwitcher mode="strategy" name="gallery-time-display" />
        </div>
      </Section>

      <Section id="overlays" title="Dialogs, sheets, menus and notifications" description="Focus is trapped and restored; Escape closes; toasts are announced politely.">
        <div className="gallery-row">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">Update account values</Button>
            </DialogTrigger>
            <DialogContent title="Update account values" description="FTMO 100K · USD">
              <div className="flex flex-col gap-4">
                <Field label="Balance" required>
                  <DecimalInput name="balance" defaultValue="100000.00" startAdornment="$" />
                </Field>
                <Field label="Equity" required>
                  <DecimalInput name="equity" defaultValue="100120.40" startAdornment="$" />
                </Field>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Save values</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">View full analysis</Button>
            </SheetTrigger>
            <SheetContent title="Analyze Setup" description="AI interpretation · advisory">
              <div className="flex flex-col gap-3">
                <Callout tone="neutral" title="Risk Engine · Ready to lock">
                  Every deterministic rule passes.
                </Callout>
                <p>Setup: liquidity sweep below the Asia low followed by an M5 shift in structure.</p>
                <TechnicalDetails>Operation ANALYZE_SETUP · contract ANALYZE_SETUP_V1 · synthetic response</TechnicalDetails>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">Bottom sheet</Button>
            </SheetTrigger>
            <SheetContent side="bottom" title="New trade" description="Plan before entry, or journal a position that is already open.">
              <div className="action-options">
                <Link href="/trades/new" className="action-option">
                  <span className="action-option-title">Plan Trade</span>
                </Link>
                <Link href="/trades/live/new" className="action-option">
                  <span className="action-option-title">Record Live Trade</span>
                </Link>
              </div>
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost">Risk details</Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="font-semibold">0.50% · $500.00</p>
              <p className="t-meta">Sizing uses the stop distance only; fees, gaps and slippage are not included.</p>
            </PopoverContent>
          </Popover>
          <MenuDemo />
        </div>
        <ConfirmDialogDemo />
        <ToastDemo />
      </Section>

      <Section id="data" title="Tables, keys and disclosures">
        <DataTable
          caption="Journal"
          cards
          rows={JOURNAL_ROWS}
          rowKey={(row) => row.id}
          columns={[
            { key: "trade", header: "Trade", cell: (row) => <Link className="ui-table-link" href="/journal">{row.trade}</Link> },
            { key: "date", header: "Date", cell: (row) => row.date },
            { key: "account", header: "Account", cell: (row) => row.account },
            { key: "result", header: "Result", align: "end", cell: (row) => <span className={row.result === "Open" ? undefined : row.negative ? "value-neg" : "value-pos"}>{row.result}</span> },
            { key: "state", header: "State", cell: (row) => <StatusPill tone={row.state.tone}>{row.state.label}</StatusPill> },
          ]}
        />
        <div className="gallery-row">
          <KbdCombo keys={["Ctrl", "K"]} label="Control K" /> <Kbd>/</Kbd> <Kbd>P</Kbd> <Kbd>L</Kbd> <Kbd>J</Kbd> <Kbd>?</Kbd>
        </div>
        <Disclosure summary="Calculation definitions">Expectancy is the mean realized R per closed trade. R is per-trade risk units, not money.</Disclosure>
        <TechnicalDetails>
          Trade 2e1d3c4b-5a69-4877-9665-544332211009 · risk report 1.2 · engine 1.1 · rule RISK_LIMIT: PASS
        </TechnicalDetails>
        <TechnicalDetails developerMode summary="Technical details (developer mode)">
          Evidence sha256 4f2a…c9 · reservation held €0.06 · response id synthetic
        </TechnicalDetails>
      </Section>

      <Section id="states" title="Empty, loading and error states">
        <div className="gallery-grid">
          <EmptyState
            title="No closed trades yet."
            description="Record or plan a trade; results appear here after you close it."
            actions={
              <>
                <Link href="/trades/new" className={buttonClasses()}>
                  Plan Trade
                </Link>
                <Link href="/trades/live/new" className={buttonClasses({ variant: "secondary" })}>
                  Record Live Trade
                </Link>
              </>
            }
          />
          <ErrorState headingLevel={3} retry={<Button>Try again</Button>} homeHref="/dev/ui" homeLabel="Back to the gallery" />
          <LoadingState label="Loading trades">
            <div className="flex flex-col gap-3">
              <Skeleton height="1.25rem" width="40%" />
              <SkeletonText lines={3} />
              <Skeleton height="6rem" />
            </div>
          </LoadingState>
          <Refetching pending>
            <Card>
              <CardBody>Previous results stay visible, dimmed, while new data loads.</CardBody>
            </Card>
          </Refetching>
        </div>
      </Section>

      <ChartsSection calendarMode={calendarMode} />

      <Section id="themes" title="Light and dark side by side" description="Nested data-theme scopes use the same tokens as the document theme.">
        <div className="grid gap-4 lg:grid-cols-2">
          <ThemePreview theme="light" />
          <ThemePreview theme="dark" />
        </div>
      </Section>
    </AppShell>
  );
}
