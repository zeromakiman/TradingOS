"use client";

import { ChevronsUpDown, Keyboard, LogOut, Settings2, UserRound } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { clearPaletteHistory } from "./palette-history";
import { THEME_OPTIONS, TIME_DISPLAY_OPTIONS } from "./preference-options";
import { useShellState } from "./shell-state";
import type { SignOutAction } from "./types";
import { type PreferenceControlsInput, usePreferenceControls, useSignOut } from "./use-preference-controls";

export type UserMenuProps = PreferenceControlsInput & {
  email: string;
  signOutAction?: SignOutAction;
};

/** Avatar-less account menu in the sidebar footer: theme, time display, shortcuts, settings, sign out. */
export function UserMenu({ email, signOutAction, ...preferences }: UserMenuProps) {
  const { setHelpOpen, singleKeyShortcuts } = useShellState();
  const { theme, changeTheme, timeMode, changeTimeMode, canChangeTimeDisplay } = usePreferenceControls(preferences);
  const signOut = useSignOut(signOutAction);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="user-button">
        <UserRound aria-hidden="true" />
        <span className="sr-only">Account menu, signed in as </span>
        <span className="user-email">{email}</span>
        <ChevronsUpDown aria-hidden="true" className="user-chevron" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel className="truncate">Signed in as {email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={changeTheme}>
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Time display</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={timeMode} onValueChange={changeTimeMode}>
          {TIME_DISPLAY_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} disabled={!canChangeTimeDisplay}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* Opened after the menu has closed so focus moves into the dialog, not back to the trigger. */}
        <DropdownMenuItem icon={<Keyboard aria-hidden="true" />} detail={singleKeyShortcuts ? "?" : undefined} onSelect={() => window.setTimeout(() => setHelpOpen(true), 0)}>
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings2 aria-hidden="true" />
            <span className="flex-1">Settings</span>
          </Link>
        </DropdownMenuItem>
        {signOut && (
          <DropdownMenuItem
            icon={<LogOut aria-hidden="true" />}
            onSelect={() => {
              clearPaletteHistory();
              signOut();
            }}
          >
            Sign out
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
