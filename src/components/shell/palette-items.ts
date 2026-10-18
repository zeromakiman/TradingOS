import { scoreByQuery } from "./fuzzy";
import { accountTypeLabel, LIVE_TRADE_HREF, PLAN_TRADE_HREF, withAccountParam } from "./navigation";
import type { AccountContextSelection, PaletteIndex, PaletteTrade, ShellAccount } from "./types";

export type PaletteGroup = "recent" | "actions" | "navigation" | "accounts" | "live" | "trades" | "tags";

export const PALETTE_GROUP_LABELS: Record<PaletteGroup, string> = {
  recent: "Recent",
  actions: "Actions",
  navigation: "Go to",
  accounts: "Trading accounts",
  live: "Live trades",
  trades: "Recent trades",
  tags: "Tags",
};

export type PaletteIcon =
  | "plan"
  | "live"
  | "external-loss"
  | "account-values"
  | "today"
  | "journal"
  | "edge"
  | "accounts"
  | "review"
  | "settings"
  | "account"
  | "all-accounts"
  | "trade"
  | "tag";

export type PaletteItem = {
  /** Stable internal key (used for recents); never displayed. */
  id: string;
  group: Exclude<PaletteGroup, "recent">;
  title: string;
  subtitle?: string;
  /** Everything the item can be found by: title, subtitle, account, date, tags. */
  keywords: string;
  href: string;
  icon: PaletteIcon;
  /** Set on context switches: "all" or an account id, passed to the select-account action. */
  accountValue?: string;
};

export type PaletteSection = { group: PaletteGroup; items: PaletteItem[] };

const GROUP_ORDER: Exclude<PaletteGroup, "recent">[] = ["actions", "navigation", "accounts", "live", "trades", "tags"];

const directionLabel = (direction: PaletteTrade["direction"]) => (direction === "LONG" ? "Long" : direction === "SHORT" ? "Short" : null);

function tradeItem(trade: PaletteTrade, group: "live" | "trades"): PaletteItem {
  const title = [trade.symbol, directionLabel(trade.direction)].filter(Boolean).join(" · ");
  const subtitle = [trade.accountName, trade.dateLabel, trade.stateLabel, trade.resultLabel].filter(Boolean).join(" · ");
  return {
    id: `trade:${trade.id}`,
    group,
    title,
    subtitle,
    keywords: [title, subtitle, ...trade.tags].join(" "),
    href: `/trades/${encodeURIComponent(trade.id)}`,
    icon: group === "live" ? "live" : "trade",
  };
}

function accountActions(accounts: ShellAccount[], context: AccountContextSelection): PaletteItem[] {
  const targets = context.mode === "account" ? accounts.filter((account) => account.id === context.accountId) : accounts.filter((account) => account.status === "ACTIVE");
  return targets.flatMap((account) => [
    {
      id: `action:external-loss:${account.id}`,
      group: "actions" as const,
      title: "Add external loss",
      subtitle: account.name,
      keywords: `add external loss realized losses another platform ${account.name}`,
      href: `/accounts/${encodeURIComponent(account.id)}/manage?tab=external-losses`,
      icon: "external-loss" as const,
    },
    {
      id: `action:account-values:${account.id}`,
      group: "actions" as const,
      title: "Update account values",
      subtitle: account.name,
      keywords: `update account values balance equity confirm ${account.name}`,
      href: `/accounts/${encodeURIComponent(account.id)}/manage?tab=account-values`,
      icon: "account-values" as const,
    },
  ]);
}

const NAVIGATION: Omit<PaletteItem, "group">[] = [
  { id: "nav:today", title: "Today", keywords: "today home workstation", href: "/today", icon: "today" },
  { id: "nav:journal", title: "Journal", keywords: "journal trades list history", href: "/journal", icon: "journal" },
  { id: "nav:edge", title: "EDGE", keywords: "edge analytics performance calendar statistics", href: "/edge", icon: "edge" },
  { id: "nav:accounts", title: "Accounts", keywords: "accounts trading accounts manage", href: "/accounts", icon: "accounts" },
  { id: "nav:review", title: "Review", keywords: "review ai reviews", href: "/review", icon: "review" },
  { id: "nav:weekly", title: "Weekly review", keywords: "weekly review week", href: "/review/weekly", icon: "review" },
  { id: "nav:monthly", title: "Monthly review", keywords: "monthly review month", href: "/review/monthly", icon: "review" },
  { id: "nav:settings", title: "Settings", keywords: "settings preferences theme time display ai data security", href: "/settings", icon: "settings" },
];

/** Each trade once, first occurrence kept: a live trade is normally among the recent trades too. */
function distinctTrades(trades: PaletteTrade[]): PaletteTrade[] {
  const seen = new Set<string>();
  return trades.filter((trade) => {
    if (seen.has(trade.id)) return false;
    seen.add(trade.id);
    return true;
  });
}

/** Tags of the indexed trades, most used first (each trade counted once). */
function tagItems(trades: PaletteTrade[]): PaletteItem[] {
  const counts = new Map<string, number>();
  for (const trade of trades) for (const tag of new Set(trade.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({
      id: `tag:${tag}`,
      group: "tags" as const,
      title: `Tag: ${tag}`,
      subtitle: `${count} ${count === 1 ? "trade" : "trades"} · open in Journal`,
      keywords: `tag ${tag}`,
      href: `/journal?tag=${encodeURIComponent(tag)}`,
      icon: "tag" as const,
    }));
}

/**
 * Every palette entry for the current context (§13.4): actions, navigation, trading
 * accounts (context switch), live trades, recent trades and tags. `currentHref` is the path
 * and query of the current page, so a context switch keeps the page and its filters.
 */
export function buildPaletteItems(index: PaletteIndex, context: AccountContextSelection, currentHref = "/today"): PaletteItem[] {
  const activeAccounts = index.accounts.filter((account) => account.status === "ACTIVE");
  const archivedAccounts = index.accounts.filter((account) => account.status === "ARCHIVED");
  const liveIds = new Set(index.liveTrades.map((trade) => trade.id));

  const actions: PaletteItem[] = [
    { id: "action:plan", group: "actions", title: "Plan Trade", subtitle: "Create a draft and check risk", keywords: "plan trade new draft setup", href: PLAN_TRADE_HREF, icon: "plan" },
    { id: "action:live", group: "actions", title: "Record Live Trade", subtitle: "Journal a position that is already open", keywords: "record live trade open position journal", href: LIVE_TRADE_HREF, icon: "live" },
    ...accountActions(index.accounts, context),
  ];

  const accounts: PaletteItem[] = [
    {
      id: "account:all",
      group: "accounts",
      title: "All Accounts",
      subtitle: context.mode === "all" ? "Current context" : "Aggregate every trading account",
      keywords: "all accounts aggregate context switch",
      href: withAccountParam(currentHref, "all"),
      icon: "all-accounts",
      accountValue: "all",
    },
    ...activeAccounts.map((account) => {
      const current = context.mode === "account" && context.accountId === account.id;
      const subtitle = [account.currency, accountTypeLabel(account.type), current ? "Current context" : null].filter(Boolean).join(" · ");
      return {
        id: `account:${account.id}`,
        group: "accounts" as const,
        title: account.name,
        subtitle,
        keywords: `${account.name} ${subtitle} switch trading account`,
        href: withAccountParam(currentHref, account.id),
        icon: "account" as const,
        accountValue: account.id,
      };
    }),
    // Archived accounts cannot be the working context (§9.2); they open their dashboard instead.
    ...archivedAccounts.map((account) => {
      const subtitle = `${account.currency} · ${accountTypeLabel(account.type)} · Archived · view history`;
      return {
        id: `account:${account.id}`,
        group: "accounts" as const,
        title: account.name,
        subtitle,
        keywords: `${account.name} ${subtitle} archived trading account`,
        href: `/accounts/${encodeURIComponent(account.id)}`,
        icon: "account" as const,
      };
    }),
  ];

  return [
    ...actions,
    ...NAVIGATION.map((item) => ({ ...item, group: "navigation" as const })),
    ...accounts,
    ...index.liveTrades.map((trade) => tradeItem(trade, "live")),
    ...index.recentTrades.filter((trade) => !liveIds.has(trade.id)).map((trade) => tradeItem(trade, "trades")),
    ...tagItems(distinctTrades([...index.liveTrades, ...index.recentTrades])),
  ];
}

const DEFAULT_LIMITS: Partial<Record<PaletteGroup, number>> = { trades: 8, tags: 6 };
const QUERY_LIMIT = 12;

/**
 * Sections to display. Without a query: recently used items first, then every group (long
 * groups trimmed). With a query: fuzzy matches, best first within each group, and the group
 * holding the best match first.
 */
export function paletteSections(items: PaletteItem[], query: string, recentIds: readonly string[] = []): PaletteSection[] {
  const trimmed = query.trim();
  if (!trimmed) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds.map((id) => byId.get(id)).filter((item): item is PaletteItem => item !== undefined);
    const recentSet = new Set(recent.map((item) => item.id));
    const sections: PaletteSection[] = recent.length > 0 ? [{ group: "recent", items: recent }] : [];
    for (const group of GROUP_ORDER) {
      const groupItems = items.filter((item) => item.group === group && !recentSet.has(item.id));
      const limit = DEFAULT_LIMITS[group];
      if (groupItems.length > 0) sections.push({ group, items: limit ? groupItems.slice(0, limit) : groupItems });
    }
    return sections;
  }
  const scored = scoreByQuery(items, trimmed, (item) => item.keywords);
  return GROUP_ORDER.map((group, rank) => {
    const matches = scored.filter((entry) => entry.item.group === group).slice(0, QUERY_LIMIT);
    return { rank, best: matches[0]?.score ?? 0, section: { group, items: matches.map((entry) => entry.item) } };
  })
    .filter((candidate) => candidate.section.items.length > 0)
    .sort((a, b) => b.best - a.best || a.rank - b.rank)
    .map((candidate) => candidate.section);
}
