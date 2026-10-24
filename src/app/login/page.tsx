import { Info } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthFrame, AuthHeading } from "@/components/settings/auth-frame";
import { SignInForm } from "@/components/settings/auth-forms";
import { signInNotice, storedTheme } from "@/components/settings/auth-page-data";
import { Callout } from "@/components/ui/callout";
import { isConfigured, supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sign in · Trading OS" };
export const dynamic = "force-dynamic";

/** Public sign-in (docs/V2_ARCHITECTURE.md §14.12). A signed-in visitor goes straight to Today. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string | string[] }> }) {
  const { reason } = await searchParams;
  const configured = isConfigured();
  if (configured) {
    const db = await supabaseServer();
    const { data } = await db.auth.getUser();
    if (data.user) redirect("/today");
  }
  const notice = signInNotice(reason);
  return (
    <AuthFrame theme={await storedTheme()}>
      <AuthHeading
        title={configured ? "Sign in to Trading OS" : "Sign-in isn't set up yet"}
        description={configured ? "Access is invitation-only. Use the login provisioned for you." : undefined}
      />
      {notice && (
        <Callout role="status" tone={notice.tone} icon={notice.icon} title={notice.title} className="mb-5">
          {notice.body}
        </Callout>
      )}
      {configured ? (
        <SignInForm />
      ) : (
        <Callout tone="info" icon={<Info aria-hidden="true" />} title="No database is connected to this deployment">
          Connect the private Supabase project described in README.md to enable sign-in and saved records.
        </Callout>
      )}
    </AuthFrame>
  );
}
