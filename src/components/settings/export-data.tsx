"use client";

import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { Checkbox } from "../ui/choice";
import { cx } from "../ui/cx";
import { FormAlert } from "../ui/form-alert";
import {
  buildDataExport, ExportCancelled, ExportError, type ExportProgress, type ExportResult, type ExportTableNames, formatBytes, progressView,
} from "./export-archive";
import { type ScreenshotCounts, screenshotSummary } from "./settings-model";

/**
 * Settings → Data → "Download my data (.zip)" (docs/V2_ARCHITECTURE.md §10.5). The archive is assembled in this
 * browser from the export routes and, when ticked, the screenshots (fingerprint-verified); nothing is uploaded and
 * nothing changes on the server. Progress is announced politely; leaving the page mid-export asks first.
 */

type ExportState =
  | { status: "idle" }
  | { status: "running"; progress: ExportProgress; includeScreenshots: boolean }
  | { status: "done"; result: ExportResult; url: string }
  | { status: "error"; message: string }
  | { status: "cancelled" };

const UNEXPECTED = "The export stopped unexpectedly. Nothing was downloaded. Please try again.";

function saveFile(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function ProgressBar({ fraction, label }: { fraction: number | null; label: string }) {
  const percent = fraction === null ? null : Math.round(fraction * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? "Working" : `${percent}%`}
      className="h-2 overflow-hidden rounded-pill bg-surface-sunken"
    >
      <div
        className={cx("h-full rounded-pill bg-accent transition-[width] duration-300", percent === null && "w-1/3 animate-pulse")}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

function ScreenshotResult({ result }: { result: ExportResult }) {
  const shots = result.screenshots;
  if (shots === null) return <>Screenshots were not included; their records are.</>;
  if (shots.expected === 0) return <>You have no screenshots yet.</>;
  return (
    <>
      {shots.included} of {shots.expected} screenshots included and verified against their recorded fingerprints.
    </>
  );
}

export function ExportData({ tables, screenshots }: { tables: ExportTableNames; screenshots: ScreenshotCounts | null }) {
  const hasScreenshots = screenshots === null || screenshots.total > 0;
  const [includeScreenshots, setIncludeScreenshots] = useState(hasScreenshots);
  const [state, setState] = useState<ExportState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const running = state.status === "running";

  // Revoke the archive's object URL on unmount; abort an export still running.
  useEffect(() => () => {
    controller.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const start = async () => {
    if (running) return;
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    const abort = new AbortController();
    controller.current = abort;
    const withScreenshots = includeScreenshots && hasScreenshots;
    setState({ status: "running", progress: { step: "records", done: 0, total: 1, part: "core" }, includeScreenshots: withScreenshots });
    try {
      const result = await buildDataExport({
        tables,
        includeScreenshots: withScreenshots,
        signal: abort.signal,
        onProgress: progress => setState(current => (current.status === "running" ? { ...current, progress } : current)),
      });
      const url = URL.createObjectURL(new Blob([result.archive as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
      objectUrl.current = url;
      setState({ status: "done", result, url });
      saveFile(url, result.fileName);
    } catch (error) {
      if (error instanceof ExportCancelled || abort.signal.aborted) setState({ status: "cancelled" });
      else setState({ status: "error", message: error instanceof ExportError ? error.message : UNEXPECTED });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };

  const view = state.status === "running" ? progressView(state.progress, state.includeScreenshots) : null;

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        name="includeScreenshots"
        label="Include screenshots"
        description={screenshotSummary(screenshots)}
        checked={includeScreenshots && hasScreenshots}
        disabled={running || !hasScreenshots}
        onChange={event => setIncludeScreenshots(event.target.checked)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" icon={<Download aria-hidden="true" />} loading={running} loadingText="Preparing your export…" onClick={start}>
          Download my data (.zip)
        </Button>
        {running && (
          <Button type="button" variant="secondary" icon={<X aria-hidden="true" />} onClick={() => controller.current?.abort()}>
            Cancel
          </Button>
        )}
      </div>
      {/* Announces each step once; the percentage and counts update visually only. */}
      <p aria-live="polite" className="sr-only">
        {view ? `${view.step}: ${view.title}` : ""}
      </p>
      <div className="flex flex-col gap-3">
        {view && (
          <div className="flex flex-col gap-2 rounded-card border border-border bg-surface-sunken p-3">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-semibold text-text">{view.title}</span>
              <span className="t-caption">{view.step}</span>
            </p>
            <ProgressBar fraction={view.fraction} label={view.title} />
            <p className="t-meta num">{view.detail}</p>
          </div>
        )}
        {state.status === "done" && (
          <>
            <FormAlert tone="success" title="Your export is ready">
              <p>
                {state.result.fileName} · {formatBytes(state.result.archive.length)}. <ScreenshotResult result={state.result} /> Your browser saved it to your
                downloads.{" "}
                <a className="font-semibold text-accent underline underline-offset-2" href={state.url} download={state.result.fileName}>
                  Download again
                </a>
              </p>
            </FormAlert>
            {state.result.screenshots && state.result.screenshots.issues.length > 0 && (
              <Callout tone="warning" title={`${state.result.screenshots.issues.length} ${state.result.screenshots.issues.length === 1 ? "screenshot" : "screenshots"} couldn't be included`}>
                Each is listed in screenshots/issues.json inside the archive, with the reason: it could not be downloaded, or its bytes did not match the
                fingerprint recorded when it was saved. Everything else was exported.
              </Callout>
            )}
          </>
        )}
        {state.status === "error" && <FormAlert tone="error" title="The export didn't finish">{state.message}</FormAlert>}
        {state.status === "cancelled" && (
          <p role="status" className="t-meta">
            Export cancelled. Nothing was downloaded.
          </p>
        )}
      </div>
    </div>
  );
}
