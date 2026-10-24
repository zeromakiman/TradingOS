"use client";

import { Link2, Link2Off, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { type FormEvent, useRef, useState, useTransition } from "react";
import { type ConnectionActionState, createMockConnection, disconnectConnection, linkExecution, runMockSync, unlinkExecution } from "@/app/actions/connections";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { useOptionalToast } from "@/components/ui/toast";
import { CONNECTION_COPY } from "./use-account-action";

/**
 * Connection controls (spec §8.6): the developer-only mock platform (connect, simulate sync, disconnect) and the
 * trader's confirmation of platform executions (link to a planned trade, unlink). The connection actions return
 * `{ error?, success? }`; failures stay on screen, successes are announced.
 */

type ConnectionAction = (state: ConnectionActionState, form: FormData) => Promise<ConnectionActionState>;

function useConnectionAction(action: ConnectionAction) {
  const toast = useOptionalToast();
  const [result, setResult] = useState<ConnectionActionState>({});
  const [pending, startTransition] = useTransition();
  const run = (form: FormData, onSuccess?: () => void) => {
    startTransition(async () => {
      let next: ConnectionActionState;
      try {
        next = await action({}, form);
      } catch (error) {
        unstable_rethrow(error);
        next = { error: CONNECTION_COPY };
      }
      startTransition(() => {
        setResult(next);
        if (next.success && !next.error) {
          toast?.toast({ title: next.success, tone: "positive" });
          onSuccess?.();
        }
      });
    });
  };
  return { result, pending, run };
}

function ErrorMessage({ result }: { result: ConnectionActionState }) {
  return result.error ? (
    <Callout tone="negative" role="alert">
      {result.error}
    </Callout>
  ) : null;
}

/** Confirmation dialogs expect a §12.2 error state to stay open with the message. */
async function confirmed(action: ConnectionAction, form: FormData): Promise<{ status: "error"; message: string } | { status: "success"; message?: string }> {
  const result = await action({}, form);
  return result.error ? { status: "error", message: result.error } : { status: "success", message: result.success };
}

export function MockConnectButton({ accountId }: { accountId: string }) {
  const requestKey = useRef<string | null>(null);
  const { result, pending, run } = useConnectionAction(createMockConnection);
  const connect = () => {
    requestKey.current ??= globalThis.crypto.randomUUID();
    const form = new FormData();
    form.set("accountId", accountId);
    form.set("requestKey", requestKey.current);
    run(form, () => {
      requestKey.current = null;
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" variant="secondary" size="sm" icon={<PlugZap aria-hidden="true" />} loading={pending} loadingText="Connecting…" onClick={connect}>
          Connect mock platform
        </Button>
      </div>
      <ErrorMessage result={result} />
    </div>
  );
}

export function MockSyncControls({ connectionId, connectionLabel }: { connectionId: string; connectionLabel: string }) {
  const toast = useOptionalToast();
  const { result, pending, run } = useConnectionAction(runMockSync);
  const form = () => {
    const data = new FormData();
    data.set("connectionId", connectionId);
    return data;
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" icon={<RefreshCw aria-hidden="true" />} loading={pending} loadingText="Syncing…" onClick={() => run(form())}>
          Simulate sync
        </Button>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="sm" icon={<Unplug aria-hidden="true" />}>
              Disconnect
            </Button>
          }
          title={`Disconnect ${connectionLabel}?`}
          description="Imported trades and their history are kept. The account is recorded manually again."
          confirmLabel="Disconnect"
          pendingLabel="Disconnecting…"
          tone="danger"
          onConfirm={async () => {
            const outcome = await confirmed(disconnectConnection, form());
            if (outcome.status === "success" && outcome.message) toast?.toast({ title: outcome.message, tone: "positive" });
            return outcome;
          }}
        />
      </div>
      <ErrorMessage result={result} />
    </div>
  );
}

export interface LinkOption {
  tradeId: string;
  label: string;
  suggested: boolean;
}

export function LinkExecutionForm({ executionId, options, executionLabel }: { executionId: string; options: LinkOption[]; executionLabel: string }) {
  const { result, pending, run } = useConnectionAction(linkExecution);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set("executionId", executionId);
    run(form);
  };
  if (options.length === 0) {
    return <p className="t-meta">No planned trade matches its instrument, direction and lock time. It stays here until one does.</p>;
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label={`Link ${executionLabel}`} aria-busy={pending}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Planned trade" className="min-w-0 flex-1">
          <Select name="tradeId" defaultValue={options[0].tradeId} disabled={pending}>
            {options.map(option => (
              <option key={option.tradeId} value={option.tradeId}>
                {option.suggested ? `${option.label} · suggested` : option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary" icon={<Link2 aria-hidden="true" />} loading={pending} loadingText="Linking…">
          Link
        </Button>
      </div>
      <ErrorMessage result={result} />
    </form>
  );
}

export function UnlinkExecutionButton({ tradeId, executionId, executionLabel }: { tradeId: string; executionId: string; executionLabel: string }) {
  const toast = useOptionalToast();
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="ghost" size="sm" icon={<Link2Off aria-hidden="true" />}>
          Unlink
        </Button>
      }
      title={`Unlink ${executionLabel}?`}
      description="The trade keeps everything you recorded. The execution returns to the unmatched list, and the change is kept in the history."
      confirmLabel="Unlink"
      pendingLabel="Unlinking…"
      tone="danger"
      onConfirm={async () => {
        const form = new FormData();
        form.set("tradeId", tradeId);
        form.set("executionId", executionId);
        const outcome = await confirmed(unlinkExecution, form);
        if (outcome.status === "success" && outcome.message) toast?.toast({ title: outcome.message, tone: "positive" });
        return outcome;
      }}
    />
  );
}
