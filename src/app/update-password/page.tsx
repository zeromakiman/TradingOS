import type { Metadata } from "next";
import { PasswordRecovery } from "@/components/password-recovery";
import { AuthFrame } from "@/components/settings/auth-frame";
import { storedTheme } from "@/components/settings/auth-page-data";

export const metadata: Metadata = { title: "Set a new password · Trading OS", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function UpdatePasswordPage() {
  return (
    <AuthFrame theme={await storedTheme()}>
      <PasswordRecovery />
    </AuthFrame>
  );
}
