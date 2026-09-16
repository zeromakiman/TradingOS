import Link from "next/link";
import { ActionForm, Field } from "@/components/forms";
import { requestPasswordRecovery } from "@/app/password-actions";
export const dynamic = "force-dynamic";
export default function ForgotPasswordPage() {
  return <main className="login-page"><section className="panel login-panel"><h1>Forgot password?</h1><p>Enter your account email to request a recovery link. Open the newest link in this browser.</p><ActionForm action={requestPasswordRecovery} label="Send recovery email" pendingLabel="Requesting email…"><Field label="Email"><input name="email" type="email" required maxLength={254} autoComplete="email"/></Field></ActionForm><Link href="/login">Back to sign in</Link></section></main>;
}
