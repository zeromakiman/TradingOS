import { BookOpen, ChartNoAxesCombined, ClipboardCheck, LayoutDashboard, type LucideIcon, Settings2, Wallet } from "lucide-react";
import type { NavKey } from "./navigation";

export const NAV_ICONS: Record<NavKey, LucideIcon> = {
  today: LayoutDashboard,
  journal: BookOpen,
  accounts: Wallet,
  edge: ChartNoAxesCombined,
  review: ClipboardCheck,
  settings: Settings2,
};
