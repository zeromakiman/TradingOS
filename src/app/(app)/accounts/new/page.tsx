import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateAccountForm } from "@/components/accounts/create-account-form";
import { NewAccountGuide } from "@/components/accounts/new-account-guide";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "New trading account · Trading OS" };

/** Create a trading account (docs/V2_ARCHITECTURE.md §1.2, §3.2). */
export default function NewAccountPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        className="mb-0"
        eyebrow={
          <Link href="/accounts" className="inline-flex min-h-10 items-center gap-1 text-text-2 hover:text-text pointer-coarse:min-h-11">
            <ChevronLeft aria-hidden="true" className="size-4" />
            Accounts
          </Link>
        }
        title="New trading account"
        description="A broker, prop-firm or demo account you trade. Trading OS records your plans and trades for it; it never places orders."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
        <Card>
          <CardBody>
            <CreateAccountForm />
          </CardBody>
        </Card>
        <NewAccountGuide />
      </div>
    </div>
  );
}
