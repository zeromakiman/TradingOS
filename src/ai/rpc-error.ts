/**
 * Stable error contract of the AI RPCs (spec §0.6): V2 messages start with a code prefix such as
 * `NOT_LATEST_REVISION: ...`; legacy 0009/0010 messages have none and are matched by their exact text.
 */
const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,63}):/;

export function rpcErrorCode(error: { message?: unknown } | null | undefined): string | null {
  const message = typeof error?.message === "string" ? error.message : "";
  return CODE_PREFIX.exec(message)?.[1] ?? null;
}

export function rpcErrorMessage(error: { message?: unknown } | null | undefined): string {
  return typeof error?.message === "string" ? error.message : "";
}
