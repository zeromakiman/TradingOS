"use client";

import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cx } from "@/components/ui/cx";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import type { StrategyCard } from "@/domain/strategy-card";

/**
 * The strategy and risk plan a draft is checked against, or the versions a plan was locked with
 * (docs/V2_ARCHITECTURE.md §12.1 `strategy-card.ts`, §14.4): models, sessions, risk per trade, daily limits and
 * policies in readable sections, in a side sheet. Only the structured rules are shown, never the written prompt.
 */

export function StrategyCardSheet({ card, context }: { card: StrategyCard; context: string }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary" size="sm" icon={<BookOpen aria-hidden="true" />}>
          Strategy card
        </Button>
      </SheetTrigger>
      <SheetContent title={card.title} description={card.subtitle}>
        <div className="flex flex-col gap-5">
          <p className="t-meta">{context}</p>
          {card.warnings.map(warning => (
            <Callout key={warning} tone="warning">
              {warning}
            </Callout>
          ))}
          {card.sections.map(section => (
            <section key={section.id} aria-labelledby={`strategy-${section.id}`} className="flex flex-col gap-2">
              <h3 id={`strategy-${section.id}`} className="text-[0.8125rem] font-semibold uppercase tracking-wide text-text-3">
                {section.title}
              </h3>
              <dl className="flex flex-col divide-y divide-border rounded-card border border-border">
                {section.items.map(item => (
                  <div key={item.label} className="flex flex-col gap-1 px-3 py-2">
                    {/* Short values sit beside their label; rule sentences read below it. */}
                    <div className={item.detail || item.value.length > 40 ? "flex flex-col gap-0.5" : "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5"}>
                      <dt className="text-text-2">{item.label}</dt>
                      <dd className={cx("num font-medium", item.tone === "warning" ? "text-warn" : "text-text")}>{item.value}</dd>
                    </div>
                    {item.detail && (
                      <Disclosure summary="Full rule" className="border-0 bg-transparent [&>summary]:min-h-9 [&>summary]:px-0">
                        <p className="whitespace-pre-wrap text-text-2">{item.detail}</p>
                      </Disclosure>
                    )}
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
