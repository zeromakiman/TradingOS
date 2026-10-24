import Link from "next/link";
import { HBarChart } from "@/components/charts/hbar-chart";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { BreakdownPanel, BreakdownSwitch } from "./breakdown-switch";
import type { BreakdownSection } from "./model";
import { EDGE_PATH } from "./params";
import { PendingLink } from "./pending";

const isEdgeHref = (href: string) => href === EDGE_PATH || href.startsWith(`${EDGE_PATH}?`);

/**
 * A group's sample line ("N = 26 · 2 without risk · Emerging tendency", "N = 19 · 2 without risk · +€876.81") may need
 * two lines in the label column: it wraps only after a "·", never inside a part, so "N = 26" stays whole and a
 * signed amount never loses its sign to the line above (a break is otherwise allowed between "+" and "€").
 */
export function keepPartsTogether(detail: string): string {
  return detail
    .split(" · ")
    .map(part => part.replace(/ /g, " ").replace(/^([+\-−])/, "$1⁠"))
    .join(" · ");
}

/**
 * Breakdowns (§13.6, §13.8, §14.6): net R per condition, each group with its own N, the trades its N leaves out and its
 * evidence label; bars and table rows open the Journal filtered to that group. No winner is ever declared. Phones
 * pick one breakdown at a time; wider screens show every card.
 */
export function Breakdowns({ sections }: { sections: BreakdownSection[] }) {
  return (
    <BreakdownSwitch options={sections.map(section => ({ value: section.key, label: section.title }))}>
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map(section => (
          <BreakdownPanel key={section.key} value={section.key}>
            <Card className="h-full">
              <CardBody>
                <HBarChart
                  // Phones: each group's name and sample above a full-width bar (side by side leaves the bar no room).
                  // A group's sample may name the trades without risk: it wraps instead of being cut off.
                  className="[&_.hbar-detail]:whitespace-normal max-md:[&_.hbar-row]:grid-cols-1 max-md:[&_.hbar-row]:gap-1 max-md:[&_.hbar-row]:py-2"
                  title={section.title}
                  question={section.question}
                  sample={section.sample}
                  data={section.empty ? [] : section.data.map(datum => (datum.detail ? { ...datum, detail: keepPartsTogether(datum.detail) } : datum))}
                  categoryLabel={section.categoryLabel}
                  valueName="Net R"
                  empty={
                    section.empty
                      ? {
                          title: section.empty.title,
                          description: section.empty.description,
                          actions: section.empty.links.length
                            ? section.empty.links.map(link =>
                                isEdgeHref(link.href) ? (
                                  // Another state of this page (the origin filter removed): the results dim until it arrives.
                                  <PendingLink key={link.href} href={link.href} prefetch={false} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                                    {link.label}
                                  </PendingLink>
                                ) : (
                                  <Link key={link.href} href={link.href} prefetch={false} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                                    {link.label}
                                  </Link>
                                ),
                              )
                            : undefined,
                        }
                      : { title: "No closed trades to compare yet.", description: "Groups appear here once trades are closed." }
                  }
                />
              </CardBody>
            </Card>
          </BreakdownPanel>
        ))}
      </div>
    </BreakdownSwitch>
  );
}
