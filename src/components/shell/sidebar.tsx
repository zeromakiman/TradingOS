"use client";

import { Activity, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip } from "../ui/tooltip";
import { NAV_ICONS } from "./nav-icons";
import { activeNavKey, NAV_ITEMS, type NavItem } from "./navigation";
import { useShellState } from "./shell-state";
import { useMediaQuery } from "./use-media-query";
import { UserMenu, type UserMenuProps } from "./user-menu";

const SIDEBAR_ID = "app-sidebar";

/** Desktop sidebar (232px, collapsible to a 64px icon rail) and tablet icon rail (§13.3). */
export function Sidebar(props: UserMenuProps) {
  const active = activeNavKey(usePathname());
  const { sidebarCollapsed, toggleSidebar } = useShellState();
  const desktop = useMediaQuery("(min-width: 64rem)", true);
  const rail = sidebarCollapsed || !desktop;

  return (
    <div className="app-sidebar" id={SIDEBAR_ID}>
      <Link href="/today" className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Activity />
        </span>
        <span className="brand-name">Trading OS</span>
      </Link>
      <nav aria-label="Primary">
        <ul className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <li key={item.key}>
              <NavLink item={item} current={active === item.key} rail={rail} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar-footer">
        <UserMenu {...props} />
        <button type="button" className="nav-link sidebar-collapse" aria-expanded={!sidebarCollapsed} aria-controls={SIDEBAR_ID} onClick={toggleSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          <span className="sidebar-label">{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
        </button>
      </div>
    </div>
  );
}

function NavLink({ item, current, rail }: { item: NavItem; current: boolean; rail: boolean }) {
  const Icon = NAV_ICONS[item.key];
  const link = (
    <Link href={item.href} className="nav-link" aria-current={current ? "page" : undefined}>
      <Icon aria-hidden="true" />
      <span className="sidebar-label">{item.label}</span>
    </Link>
  );
  return rail ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
