"use client";

import { RefreshCw, Unplug, Wrench } from "lucide-react";
import { useActionState, useEffect, useState, useTransition } from "react";
import { setDeveloperMode } from "@/app/actions/context";
import { type ConnectionActionState, createMockConnection, disconnectConnection, runMockSync } from "@/app/actions/connections";
import { idleState } from "@/app/actions/state";
import { Button } from "../ui/button";
import { Switch } from "../ui/choice";
import { FormAlert } from "../ui/form-alert";
import { useResultKey } from "./form-submit";

/**
 * Settings → Developer (docs/V2_ARCHITECTURE.md §13.9, §8.6): "Show technical details expanded" (cookie `tos_dev`)
 * and, only when the deployment enables TRADING_OS_ENABLE_MOCK_SYNC, the mock platform: connect, simulate a sync,
 * disconnect. The mock never contacts a real platform.
 */

export function DeveloperModeSwitch({ enabled }: { enabled: boolean }) {
  const [checked, setChecked] = useState(enabled);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [received, setReceived] = useState(enabled);
  if (received !== enabled) {
    setReceived(enabled);
    setChecked(enabled);
  }

  const change = (next: boolean) => {
    const previous = checked;
    setChecked(next);
    setMessage(null);
    startTransition(async () => {
      const form = new FormData();
      if (next) form.set("enabled", "on");
      try {
        const result = await setDeveloperMode(idleState, form);
        if (result.status === "error") {
          setChecked(previous);
          setMessage({ tone: "error", text: result.message });
        } else {
          setMessage({ tone: "success", text: (result.status === "success" && result.message) || "Saved." });
        }
      } catch {
        setChecked(previous);
        setMessage({ tone: "error", text: "The setting was not saved. Check your connection and try again." });
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <Switch
        label="Show technical details expanded"
        description="Ids, versions, raw reports and fingerprints open by default on every page. Otherwise they stay in a collapsed Technical details section."
        checked={checked}
        disabled={pending}
        onChange={event => change(event.target.checked)}
      />
      <div aria-live="polite">{message && <p className={message.tone === "error" ? "t-meta text-neg" : "t-meta"}>{message.text}</p>}</div>
    </div>
  );
}

const INITIAL: ConnectionActionState = {};

function Outcome({ state }: { state: ConnectionActionState }) {
  if (state.error) return <FormAlert tone="error">{state.error}</FormAlert>;
  if (state.success) return <FormAlert tone="success">{state.success}</FormAlert>;
  return null;
}

/** Connect the mock platform to one trading account (a fresh request key per attempt). */
function ConnectMock({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [state, dispatch, pending] = useActionState(createMockConnection, INITIAL);
  const resultKey = useResultKey(state);
  const [requestKey, setRequestKey] = useState<string | null>(null);
  useEffect(() => setRequestKey(crypto.randomUUID()), []);
  useEffect(() => {
    if (state.success || state.error) setRequestKey(crypto.randomUUID());
  }, [state]);
  return (
    <form action={dispatch} className="flex flex-col gap-2" aria-busy={pending}>
      <input type="hidden" name="accountId" value={accountId} />
      {requestKey && <input type="hidden" name="requestKey" value={requestKey} />}
      <div>
        <Button type="submit" variant="secondary" size="sm" icon={<Wrench aria-hidden="true" />} loading={pending} loadingText="Connecting…" disabled={!requestKey}>
          Connect mock platform<span className="sr-only"> to {accountName}</span>
        </Button>
      </div>
      <Outcome key={resultKey} state={state} />
    </form>
  );
}

function ConnectionCommands({ connectionId, accountName }: { connectionId: string; accountName: string }) {
  const [syncState, sync, syncing] = useActionState(runMockSync, INITIAL);
  const [disconnectState, disconnect, disconnecting] = useActionState(disconnectConnection, INITIAL);
  const syncKey = useResultKey(syncState);
  const disconnectKey = useResultKey(disconnectState);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <form action={sync}>
          <input type="hidden" name="connectionId" value={connectionId} />
          <Button type="submit" variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} loading={syncing} loadingText="Syncing…" disabled={disconnecting}>
            Simulate sync<span className="sr-only"> for {accountName}</span>
          </Button>
        </form>
        <form action={disconnect}>
          <input type="hidden" name="connectionId" value={connectionId} />
          <Button type="submit" variant="ghost" size="sm" icon={<Unplug aria-hidden="true" />} loading={disconnecting} loadingText="Disconnecting…" disabled={syncing}>
            Disconnect<span className="sr-only"> {accountName}</span>
          </Button>
        </form>
      </div>
      <Outcome key={`sync-${syncKey}`} state={syncState} />
      <Outcome key={`disconnect-${disconnectKey}`} state={disconnectState} />
    </div>
  );
}

export interface MockSyncRow {
  accountId: string;
  accountName: string;
  /** Pill-free status line, already in words ("Synced · Last synced Oct 22, 14:05 UTC−5."). */
  status: string;
  /** The active mock connection; null when the account has none (a real-provider connection also blocks a mock). */
  connectionId: string | null;
  /** True when another (non-mock) connection is active, so no mock can be added. */
  otherConnection: boolean;
}

export function MockSyncControls({ rows }: { rows: readonly MockSyncRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map(row => (
        <li key={row.accountId} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-start md:justify-between md:gap-6">
          {/* An account name of up to 100 characters, maybe without spaces, breaks instead of widening the list. */}
          <div className="min-w-0 wrap-anywhere">
            <p className="font-medium text-text">{row.accountName}</p>
            <p className="t-meta">{row.status}</p>
          </div>
          <div className="md:max-w-sm">
            {row.connectionId ? (
              <ConnectionCommands connectionId={row.connectionId} accountName={row.accountName} />
            ) : row.otherConnection ? (
              <p className="t-meta">Another connection is active on this account.</p>
            ) : (
              <ConnectMock accountId={row.accountId} accountName={row.accountName} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
