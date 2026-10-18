"use client";

import { BookOpen, ChartNoAxesCombined, ClipboardCheck, Crosshair, Ellipsis, LayoutDashboard, LogOut, Plus, Radio, Settings2, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/choice";
import { Sheet, SheetContent } from "../ui/dialog";
import { activeNavKey, LIVE_TRADE_HREF, type NavKey, PLAN_TRADE_HREF } from "./navigation";
import { clearPaletteHistory } from "./palette-history";
import { THEME_OPTIONS, TIME_DISPLAY_OPTIONS } from "./preference-options";
import type { SignOutAction } from "./types";
import { type PreferenceControlsInput, usePreferenceControls, useSignOut } from "./use-preference-controls";

export type MobileTabBarProps = PreferenceControlsInput & {
  email: string;
  signOutAction?: SignOutAction;
};

const MORE_KEYS: NavKey[] = ["edge", "review", "settings"];

/** Bottom tab bar below 768px: Today · Journal · + · Accounts · More, with safe-area insets. */
export function MobileTabBar({ email, signOutAction, ...preferences }: MobileTabBarProps) {
  const active = activeNavKey(usePathname());
  const [sheet, setSheet] = useState<"new" | "more" | null>(null);
  const { theme, changeTheme, timeMode, changeTimeMode, canChangeTimeDisplay } = usePreferenceControls(preferences);
  const signOut = useSignOut(signOutAction);
  const close = () => setSheet(null);
  const current = (key: NavKey) => (active === key ? "page" : undefined);

  return (
    <nav className="mobile-tabbar" aria-label="Primary">
      <Link href="/today" className="tabbar-item" aria-current={current("today")}>
        <LayoutDashboard aria-hidden="true" />
        <span>Today</span>
      </Link>
      <Link href="/journal" className="tabbar-item" aria-current={current("journal")}>
        <BookOpen aria-hidden="true" />
        <span>Journal</span>
      </Link>
      <button type="button" className="tabbar-item" aria-haspopup="dialog" onClick={() => setSheet("new")}>
        <span className="tabbar-plus" aria-hidden="true">
          <Plus />
        </span>
        <span className="sr-only">New trade</span>
      </button>
      <Link href="/accounts" className="tabbar-item" aria-current={current("accounts")}>
        <Wallet aria-hidden="true" />
        <span>Accounts</span>
      </Link>
      <button type="button" className="tabbar-item" aria-haspopup="dialog" aria-current={active && MORE_KEYS.includes(active) ? "page" : undefined} onClick={() => setSheet("more")}>
        <Ellipsis aria-hidden="true" />
        <span>More</span>
      </button>

      <Sheet open={sheet === "new"} onOpenChange={(open) => setSheet(open ? "new" : null)}>
        <SheetContent side="bottom" title="New trade" description="Plan before entry, or journal a position that is already open.">
          <div className="action-options">
            <Link href={PLAN_TRADE_HREF} className="action-option" onClick={close}>
              <Crosshair aria-hidden="true" />
              <span>
                <span className="action-option-title">Plan Trade</span>
                <span className="action-option-description">Draft the setup and check risk before you enter.</span>
              </span>
            </Link>
            <Link href={LIVE_TRADE_HREF} className="action-option" onClick={close}>
              <Radio aria-hidden="true" />
              <span>
                <span className="action-option-title">Record Live Trade</span>
                <span className="action-option-description">Already in a position? Start the live journal now.</span>
              </span>
            </Link>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === "more"} onOpenChange={(open) => setSheet(open ? "more" : null)}>
        <SheetContent side="bottom" title="More" description={`Signed in as ${email}`}>
          <div className="action-options">
            <Link href="/edge" className="action-option" onClick={close} aria-current={current("edge")}>
              <ChartNoAxesCombined aria-hidden="true" />
              <span className="action-option-title">EDGE</span>
            </Link>
            <Link href="/review" className="action-option" onClick={close} aria-current={current("review")}>
              <ClipboardCheck aria-hidden="true" />
              <span className="action-option-title">Review</span>
            </Link>
            <Link href="/settings" className="action-option" onClick={close} aria-current={current("settings")}>
              <Settings2 aria-hidden="true" />
              <span className="action-option-title">Settings</span>
            </Link>
          </div>
          <p className="sheet-section-label">Preferences</p>
          <div className="flex flex-col gap-3">
            <SegmentedControl name="mobile-theme" legend="Theme" legendHidden={false} options={THEME_OPTIONS} value={theme} onValueChange={changeTheme} />
            <SegmentedControl
              name="mobile-time-display"
              legend="Time display"
              legendHidden={false}
              options={TIME_DISPLAY_OPTIONS.map((option) => ({ ...option, label: option.value === "strategy" ? "UTC−5" : option.label }))}
              value={timeMode}
              onValueChange={changeTimeMode}
              disabled={!canChangeTimeDisplay}
            />
          </div>
          {signOut && (
            <Button
              variant="secondary"
              icon={<LogOut aria-hidden="true" />}
              className="mt-5 w-full"
              onClick={() => {
                clearPaletteHistory();
                signOut();
              }}
            >
              Sign out
            </Button>
          )}
        </SheetContent>
      </Sheet>
    </nav>
  );
}
