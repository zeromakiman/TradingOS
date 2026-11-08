import { redirect } from "next/navigation";

/** Legacy V1 preview (docs/V2_ARCHITECTURE.md §1.2): there is no signed-out demo workspace in V2, so it opens sign-in. */
export default function LegacyPreviewPage() {
  redirect("/login");
}
