import type { Metadata } from "next";
import { AuthFrame, AuthHeading } from "@/components/settings/auth-frame";
import { BackToSignIn, RecoveryRequestForm } from "@/components/settings/auth-forms";
import { storedTheme } from "@/components/settings/auth-page-data";

export const metadata: Metadata = { title: "Reset password · Trading OS" };
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  return (
    <AuthFrame theme={await storedTheme()}>
      <AuthHeading
        title="Reset your password"
        description="Enter the email of your Trading OS login. If it can receive email, a recovery link arrives shortly. Open the newest link in this browser."
      />
      <RecoveryRequestForm />
      <BackToSignIn />
    </AuthFrame>
  );
}
