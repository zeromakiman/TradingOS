"use client";

import { useState } from "react";
import { Callout } from "../ui/callout";
import { useAccountContextSelection } from "./account-context-sync";
import { noticeOnScreen, type ShownNotice } from "./context-sync";
import { useCurrentHref } from "./use-current-href";

const ALL_ACCOUNTS = { mode: "all" } as const;

/**
 * The layout's one-time context notice, for example "That trading account isn't available. Showing All Accounts."
 * (§9.2), on the page it was rendered for: it leaves when the person moves to another page or picks another context
 * (see noticeOnScreen). `renderKey` identifies the layout render that passed `notice`.
 */
export function ContextNotice({ notice, renderKey }: { notice?: string | null; renderKey: string }) {
  const href = useCurrentHref();
  const page = useAccountContextSelection(ALL_ACCOUNTS);
  const [shown, setShown] = useState<ShownNotice>(() => (notice ? { text: notice, href } : null));
  const [seenKey, setSeenKey] = useState(renderKey);
  const current = noticeOnScreen(shown, seenKey, { notice, renderKey, href, allAccounts: page.mode === "all" });
  // Derived state, updated while rendering: React renders this component again at once, before the screen updates.
  if (renderKey !== seenKey) setSeenKey(renderKey);
  if (current !== shown) setShown(current);
  if (!current) return null;
  return (
    <Callout tone="info" role="status" className="app-notice">
      {current.text}
    </Callout>
  );
}
