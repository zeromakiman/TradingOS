// Types of fixtures.mjs (browser acceptance runner, local tooling only).

export interface LocalStack {
  publishableKey: string;
  secretKey: string;
  postgres: { superuserPassword: string; authenticatorPassword: string };
  [key: string]: unknown;
}

export interface AcceptanceUser {
  key: string;
  id: string;
  email: string;
  password: string;
  seeded: boolean;
  showcase: { trades: Record<string, string>; accounts: Record<string, string> } | null;
  seedSeconds?: number;
}

export declare function passwordGrant(stack: LocalStack, email: string, password: string): Promise<{ ok: boolean; status: number; token: string | null; error: string | null }>;
export declare function userRpc(stack: LocalStack, token: string, name: string, params: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown; message: string | null }>;

export declare class UserPool {
  constructor(options: { stack: LocalStack; runId: string; out: string; log: (message: string) => void });
  list(): { key: string; id: string; email: string; seeded: boolean; seedSeconds?: number }[];
  empty(key: string): Promise<AcceptanceUser>;
  seeded(key: string): Promise<AcceptanceUser>;
}

export declare function createAccountViaApi(stack: LocalStack, user: AcceptanceUser, input: Record<string, string>): Promise<string>;
export declare function tenantTables(stack: LocalStack): string[];
export declare function rowCountsFor(stack: LocalStack, userId: string): Record<string, number>;
export declare function identityFootprint(stack: LocalStack, userId: string): { authUsers: number; objects: number };
export declare function storageFilesFor(userId: string): number;
export declare function accountsOf(stack: LocalStack, userId: string): { id: string; name: string; status: string }[];
export declare function sharp(): unknown;
export declare function chartPng(spec: {
  seed: string;
  kind?: "HTF" | "SETUP" | "ENTRY" | "MANAGE" | "EXIT";
  symbol?: string;
  timeframe?: string;
  account?: string;
  direction?: "LONG" | "SHORT";
  entry?: number;
  stop?: number;
  target?: number;
  exit?: number | null;
  scale?: number;
}): Promise<Buffer>;
export declare function readZip(buffer: Buffer): Record<string, Buffer>;
