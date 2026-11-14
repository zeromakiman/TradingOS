import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cache } from "react";
import { currentSession, type Session } from "./account-context";

/**
 * Schema gate (docs/V2_ARCHITECTURE.md §3.11, §13.10). `public.trading_os_schema()` names the database version the
 * deployment runs against. When the marker is missing or older than 2.1, every app page renders the "Database update
 * required" state and no server action writes anything. The check uses the signed-in user's session: the marker is
 * granted to `authenticated` only.
 */

export const REQUIRED_SCHEMA_VERSION = "2.1";
export const SCHEMA_OUTDATED_TITLE = "Database update required";
export const SCHEMA_OUTDATED_MESSAGE = "Database update required — this deployment expects Trading OS database version 2.1. No changes were made.";

export type SchemaStatus =
  | { ready: true; version: string }
  | { ready: false; reason: "MISSING" | "OUTDATED" | "UNRECOGNIZED"; version: string | null };

/** The marker could not be read for another reason (network, auth service): neither ready nor known to be outdated. */
export class SchemaUnavailableError extends Error {
  constructor() {
    super("Schema version unavailable");
    this.name = "SchemaUnavailableError";
  }
}

/** PostgREST (unknown function in the schema cache) and PostgreSQL (undefined function) codes: no marker exists. */
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);
const VERSION = /^(\d{1,4})\.(\d{1,4})$/;
const [REQUIRED_MAJOR, REQUIRED_MINOR] = REQUIRED_SCHEMA_VERSION.split(".").map(part => Number.parseInt(part, 10));

interface RpcResult {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
}

/** Interprets one `trading_os_schema()` call. Throws SchemaUnavailableError when the call failed for another reason. */
export function schemaStatusFromRpc(result: RpcResult): SchemaStatus {
  if (result.error) {
    if (result.error.code && MISSING_FUNCTION.has(result.error.code)) return { ready: false, reason: "MISSING", version: null };
    throw new SchemaUnavailableError();
  }
  if (typeof result.data !== "string") return { ready: false, reason: "UNRECOGNIZED", version: null };
  const match = VERSION.exec(result.data.trim());
  if (!match) return { ready: false, reason: "UNRECOGNIZED", version: result.data };
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const current = major > REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor >= REQUIRED_MINOR);
  return current ? { ready: true, version: result.data.trim() } : { ready: false, reason: "OUTDATED", version: result.data.trim() };
}

/** Reads the marker with an existing client (server actions pass the session they already hold). */
export async function checkSchema(db: Pick<SupabaseClient, "rpc">): Promise<SchemaStatus> {
  const { data, error } = await db.rpc("trading_os_schema");
  return schemaStatusFromRpc({ data, error });
}

/** Once per request for pages and layouts (React cache); redirects to sign-in without a session. */
export const getSchemaStatus = cache(async (): Promise<SchemaStatus> => {
  const { db } = await currentSession();
  return checkSchema(db);
});

/**
 * Server actions start here: the verified session when the database schema is current, null when it is missing or
 * older than 2.1 (the action then returns SCHEMA_OUTDATED_MESSAGE and writes nothing). Throws SchemaUnavailableError
 * when the marker cannot be read; redirects to sign-in without a session.
 */
export async function writableSession(): Promise<Session | null> {
  const session = await currentSession();
  return (await checkSchema(session.db)).ready ? session : null;
}
