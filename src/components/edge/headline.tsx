import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Card, CardBody, CardFooter } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { Stat } from "@/components/ui/stat";
import { toneClass } from "./format";
import type { HeadlineModel } from "./model";

/**
 * Headline statistics (§14.6): Net R, Expectancy, Win rate, Profit factor, Max R drawdown and Closed trades, money per
 * currency (never added across currencies), and the sample caveat in words. Win rate, profit factor and expectancy
 * are muted with an "Early" tag below ten trades (§13.8). The footer opens the trades behind every figure in the
 * Journal.
 */
export function EdgeHeadline({ id, model, period, journal }: { id?: string; model: HeadlineModel; period: string; journal: { label: string; href: string } | null }) {
  return (
    <Card as="section" id={id} aria-labelledby="edge-headline-title" className="scroll-mt-20">
      <CardBody className="flex flex-col gap-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="edge-headline-title" className="text-base font-semibold">
            Results
          </h2>
          <p className="t-meta">{period}</p>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-6">
          {model.stats.map(stat => (
            <Stat
              key={stat.key}
              label={stat.label}
              size={stat.large ? "lg" : "md"}
              early={stat.early}
              value={<span className={toneClass(stat.tone)}>{stat.value}</span>}
              hint={stat.hint}
            />
          ))}
        </div>
        {model.money.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-10">
            <p className="stat-label">Net P&amp;L</p>
            {model.money.map(money => (
              <p key={money.currency} className="flex flex-wrap items-baseline gap-x-2">
                <span className={cx("text-lg font-semibold num", toneClass(money.tone))}>{money.label}</span>
                <span className="t-caption">{money.detail}</span>
              </p>
            ))}
          </div>
        )}
      </CardBody>
      <CardFooter className="flex-col items-start justify-start gap-1">
        {model.notes.map(note => (
          <p key={note} className="t-meta">
            {note}
          </p>
        ))}
        {journal && (
          <Link href={journal.href} prefetch={false} className="inline-flex min-h-10 items-center gap-1.5 font-medium text-accent underline-offset-2 hover:underline pointer-coarse:min-h-11">
            {journal.label}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        )}
      </CardFooter>
    </Card>
  );
}
