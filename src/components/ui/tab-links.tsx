import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type TabLink = { href: string; label: ReactNode; current?: boolean };

/** Route-level tabs (each tab is a URL), for example Review: Weekly · Recent trades · Monthly · History. */
export function TabLinks({ label, items, className }: { label: string; items: TabLink[]; className?: string }) {
  return (
    <nav aria-label={label} className={cx("tabs-list", className)}>
      {items.map((item) => (
        <Link key={item.href} href={item.href} className="tab" aria-current={item.current ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
