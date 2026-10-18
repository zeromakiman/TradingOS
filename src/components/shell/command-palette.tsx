"use client";

import {
  BookOpen,
  ChartNoAxesCombined,
  ClipboardCheck,
  CornerDownLeft,
  Crosshair,
  Hash,
  Layers,
  LayoutDashboard,
  type LucideIcon,
  CircleMinus,
  Radio,
  Scale,
  Search,
  Settings2,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog as RadixDialog } from "radix-ui";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useMemo, useState, useTransition } from "react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { switchAccountContext } from "./actions";
import { readPaletteHistory, recentItemIds, rememberPaletteItem } from "./palette-history";
import { buildPaletteItems, PALETTE_GROUP_LABELS, type PaletteIcon, type PaletteItem, paletteSections } from "./palette-items";
import { useShellState } from "./shell-state";
import type { AccountContextSelection, PaletteIndex, SelectAccountAction } from "./types";
import { useCurrentHref } from "./use-current-href";

const ICONS: Record<PaletteIcon, LucideIcon> = {
  plan: Crosshair,
  live: Radio,
  "external-loss": CircleMinus,
  "account-values": Scale,
  today: LayoutDashboard,
  journal: BookOpen,
  edge: ChartNoAxesCombined,
  accounts: Wallet,
  review: ClipboardCheck,
  settings: Settings2,
  account: Wallet,
  "all-accounts": Layers,
  trade: TrendingUp,
  tag: Hash,
};

export type CommandPaletteProps = {
  index: PaletteIndex;
  context: AccountContextSelection;
  /** The signed-in user's email: recently used entries are remembered per user. */
  userEmail: string;
  selectAccountAction?: SelectAccountAction;
};

/**
 * Command palette (§13.4), opened with Ctrl/⌘+K or "/": actions, navigation, trading
 * accounts, live and recent trades, tags. Combobox + listbox semantics; arrow keys and
 * Enter operate it, Escape closes it and focus returns to where it was.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { paletteOpen, setPaletteOpen } = useShellState();
  return (
    <RadixDialog.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay" />
        <RadixDialog.Content className="palette" data-command-palette="" aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">Search and commands</RadixDialog.Title>
          <CommandPaletteBody {...props} onClose={() => setPaletteOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

type Entry = { key: string; item: PaletteItem };

/**
 * Search field, results and keyboard handling of the palette. It renders inside the palette
 * dialog (its Cancel button closes that dialog); `CommandPalette` is the component to mount.
 */
export function CommandPaletteBody({ index, context, userEmail, selectAccountAction, onClose }: CommandPaletteProps & { onClose: () => void }) {
  const currentHref = useCurrentHref();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const baseId = useId();

  useEffect(() => setHistory(readPaletteHistory(userEmail)), [userEmail]);

  const items = useMemo(() => buildPaletteItems(index, context, currentHref), [index, context, currentHref]);
  const recentIds = useMemo(
    () =>
      recentItemIds(
        items.map((item) => item.id),
        history,
      ),
    [items, history],
  );
  const sections = useMemo(() => paletteSections(items, query, recentIds), [items, query, recentIds]);
  const entries = useMemo<Entry[]>(() => sections.flatMap((section) => section.items.map((item) => ({ key: `${section.group}:${item.id}`, item }))), [sections]);
  const current = entries.some((entry) => entry.key === activeKey) ? activeKey : (entries[0]?.key ?? null);
  const optionId = (key: string) => `${baseId}-option-${entries.findIndex((entry) => entry.key === key)}`;
  const listId = `${baseId}-list`;
  const currentValue = context.mode === "all" ? "all" : context.accountId;

  useEffect(() => {
    if (!current) return;
    const position = entries.findIndex((entry) => entry.key === current);
    document.getElementById(`${baseId}-option-${position}`)?.scrollIntoView({ block: "nearest" });
  }, [current, entries, baseId]);

  const move = (delta: number) => {
    if (entries.length === 0) return;
    const position = entries.findIndex((entry) => entry.key === current);
    setActiveKey(entries[(position + delta + entries.length) % entries.length].key);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      document.getElementById(optionId(current))?.click();
    }
  };

  const choose = (event: MouseEvent<HTMLAnchorElement>, item: PaletteItem) => {
    setHistory(rememberPaletteItem(userEmail, item.id));
    onClose();
    const value = item.accountValue;
    const plainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    // An explicit ?account= in the URL overrides the cookie, so those switches navigate instead.
    if (value === undefined || !selectAccountAction || !plainClick || new URL(window.location.href).searchParams.has("account")) return;
    event.preventDefault();
    startTransition(() => switchAccountContext(selectAccountAction, value, item.href, (target) => router.push(target)));
  };

  return (
    <>
      <div className="palette-search">
        <Search aria-hidden="true" />
        <input
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-label="Search trades, accounts and commands"
          placeholder="Search trades, accounts and commands…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(null);
          }}
          onKeyDown={handleKeyDown}
        />
        <Kbd aria-hidden="true" className="palette-esc">
          Esc
        </Kbd>
        {/* Below 768px the palette fills the screen, so touch needs a visible way out. */}
        <RadixDialog.Close asChild>
          <Button variant="ghost" size="sm" className="palette-cancel">
            Cancel
          </Button>
        </RadixDialog.Close>
      </div>
      <div className="palette-list" id={listId} role="listbox" aria-label="Results">
        {sections.map((section) => {
          const labelId = `${baseId}-group-${section.group}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: listbox options are grouped with role="group"; a fieldset is not allowed inside a listbox.
            <div key={section.group} className="palette-group" role="group" aria-labelledby={labelId}>
              <div id={labelId} className="palette-group-label" role="presentation">
                {PALETTE_GROUP_LABELS[section.group]}
              </div>
              {section.items.map((item) => {
                const key = `${section.group}:${item.id}`;
                const Icon = ICONS[item.icon];
                return (
                  <Link
                    key={key}
                    id={optionId(key)}
                    href={item.href}
                    role="option"
                    aria-selected={key === current}
                    tabIndex={-1}
                    className="palette-option"
                    prefetch={false}
                    onClick={(event) => choose(event, item)}
                    onPointerMove={() => setActiveKey(key)}
                  >
                    <Icon aria-hidden="true" className="palette-option-icon" />
                    <span className="palette-option-text">
                      <span className="palette-option-title">{item.title}</span>
                      {item.subtitle && <span className="palette-option-subtitle">{item.subtitle}</span>}
                    </span>
                    {item.accountValue !== undefined && item.accountValue === currentValue && <span className="palette-option-meta">Current</span>}
                  </Link>
                );
              })}
            </div>
          );
        })}
        {entries.length === 0 && <p className="palette-empty">No results for “{query.trim()}”.</p>}
      </div>
      <p className="sr-only" aria-live="polite">
        {query.trim() ? `${entries.length} ${entries.length === 1 ? "result" : "results"}` : ""}
      </p>
      <div className="palette-footer" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>
            <CornerDownLeft className="size-3" />
          </Kbd>{" "}
          to open
        </span>
        <span>
          <Kbd>Esc</Kbd> to close
        </span>
      </div>
    </>
  );
}
