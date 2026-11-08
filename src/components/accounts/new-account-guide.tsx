import { CalendarCheck, ListPlus, ShieldCheck, Target } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";

/** What happens after an account is created (shown beside the form on /accounts/new). */

const STEPS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <ShieldCheck aria-hidden="true" />,
    title: "Review the risk plan",
    body: "Change risk per trade, trades per day or daily caps in Manage → Risk policy. A new version starts on the next trading day; earlier trades keep theirs.",
  },
  {
    icon: <ListPlus aria-hidden="true" />,
    title: "Check the instruments",
    body: "Each instrument stores its tick size and tick value in the account currency, so position sizes are exact. Add the symbols you trade.",
  },
  {
    icon: <CalendarCheck aria-hidden="true" />,
    title: "Confirm values each trading day",
    body: "Plans lock only when today's balance is recorded. One click confirms unchanged values.",
  },
  {
    icon: <Target aria-hidden="true" />,
    title: "Plan or record a trade",
    body: "Plan Trade checks a setup against the risk plan before entry; Record Live Trade journals a position that is already open.",
  },
];

export function NewAccountGuide() {
  return (
    <Card as="section" aria-labelledby="new-account-guide">
      <CardHeader>
        <CardTitle id="new-account-guide">After you create it</CardTitle>
      </CardHeader>
      <CardBody>
        <ol className="flex flex-col gap-4">
          {STEPS.map(step => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-8 flex-none items-center justify-center rounded-control bg-accent-soft text-accent [&_svg]:size-4">{step.icon}</span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-medium text-text">{step.title}</p>
                <p className="t-meta">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
