import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findUnusedExports, KEPT, lex } from "../scripts/check-unused-exports.mjs";

// Dead-code guard (scripts/check-unused-exports.mjs, run by `pnpm lint` too): every exported value of src/ has a caller
// in the application or the repository scripts. Tests never count as callers, so code only tests exercise is reported.
// Callers are resolved per module (what a file imports, from which module), so a same-named function, method, string or
// object key elsewhere cannot hide a dead export.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("unused exports", () => {
  it("finds no export of src/ without a caller, and no stale KEPT entry", () => {
    expect(findUnusedExports({ root: ROOT })).toEqual({ unused: [], stale: [] });
  });

  it("gives every kept export a reason", () => {
    for (const [key, reason] of Object.entries(KEPT)) {
      expect(key).toMatch(/^src\/.+\.(?:ts|tsx)#[A-Za-z_$][\w$]*$/);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe("the unused-export scanner", () => {
  let tree: string | null = null;
  afterEach(() => {
    if (tree) fs.rmSync(tree, { recursive: true, force: true });
    tree = null;
  });

  function write(files: Record<string, string>): string {
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "unused-exports-"));
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(tree, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return tree;
  }

  const unusedIn = (files: Record<string, string>) => {
    const { unused, stale } = findUnusedExports({ root: write(files), kept: {} });
    expect(stale).toEqual([]);
    return unused.map(item => `${item.file}#${item.name}`).sort();
  };

  const files = {
    "src/lib/module.ts": [
      "export function deadOne() { return 1; }",
      "export async function calledElsewhere() { return 2; }",
      "export const usedInside = 3;",
      "const total = usedInside + 1;",
      "export function testOnly() { return total; }",
      "export function scriptOnly() { return 4; }",
      "export function mentionedInComment() { return 5; }",
      "export class DeadClass {}",
      "export enum DeadEnum { A }",
      "export type NotChecked = string;",
      "export interface AlsoNotChecked { a: string }",
      "export default function Anything() { return null; }",
      "const listed = 6;",
      "export { listed };",
      "export { reexported } from \"./other\";",
    ].join("\r\n"),
    "src/lib/caller.ts": "import { calledElsewhere } from \"./module\";\n// mentionedInComment is only named in this comment.\n/* deadOne too */\nexport const result = calledElsewhere();\nconsole.log(result);\n",
    "src/app/trades/page.tsx": "export const metadata = { title: \"Trades\" };\nexport const dynamic = \"force-dynamic\";\nexport function pageHelper() { return 1; }\nexport default function Page() { return null; }\n",
    "src/app/api/thing/route.ts": "export async function GET() { return new Response(); }\nexport const runtime = \"nodejs\";\n",
    "src/proxy.ts": "export function proxy() { return null; }\nexport const config = { matcher: [] };\n",
    "scripts/tool.mjs": "import { scriptOnly } from \"../src/lib/module.ts\";\nscriptOnly();\n",
    "scripts/check-unused-exports.mjs": "// The checker itself names exports in its KEPT list: deadOne\nexport const KEPT = { \"src/lib/module.ts#deadOne\": \"named here\" };\n",
    "tests/module.test.ts": "import { testOnly, deadOne } from \"../src/lib/module\";\ntestOnly(); deadOne();\n",
  };

  it("reports exports that only tests or nothing call, and nothing that has a caller", () => {
    const root = write(files);
    const { unused, stale } = findUnusedExports({ root, kept: {} });
    expect(unused.map(item => `${item.file}#${item.name}`).sort()).toEqual([
      "src/app/trades/page.tsx#pageHelper",
      "src/lib/module.ts#DeadClass",
      "src/lib/module.ts#DeadEnum",
      "src/lib/module.ts#deadOne",
      "src/lib/module.ts#listed",
      "src/lib/module.ts#mentionedInComment",
      "src/lib/module.ts#testOnly",
    ]);
    expect(unused.find(item => item.name === "testOnly")?.tests).toEqual(["tests/module.test.ts"]);
    expect(unused.find(item => item.name === "mentionedInComment")?.tests).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("keeps a reasoned KEPT entry quiet and reports one that no longer applies", () => {
    const root = write(files);
    const kept = {
      "src/lib/module.ts#deadOne": "kept on purpose for this test",
      "src/lib/module.ts#calledElsewhere": "has a caller, so the entry is stale",
      "src/lib/gone.ts#removed": "no such export any more",
    };
    const { unused, stale } = findUnusedExports({ root, kept });
    expect(unused.map(item => item.name)).not.toContain("deadOne");
    expect(stale.sort()).toEqual(["src/lib/gone.ts#removed", "src/lib/module.ts#calledElsewhere"]);
  });

  it("never lets a same-named function, method, string, key or export elsewhere hide a dead export", () => {
    // The shapes that hid euros, pricingFor, sessions, readZip and fieldError from the earlier whole-word scan.
    expect(unusedIn({
      "src/ai/budget.ts": "export function euros(micros: number) { return micros / 1e6; }\nexport function budgetCents(v: string) { return Number(v); }\n",
      "src/ai/pricing.ts": "export function pricingFor(model: string) { return model; }\nexport function operationPricing() { return 1; }\n",
      "src/domain/analytics.ts": "export const sessions = [\"JUDAS\"] as const;\nexport function realizedR() { return { realizedR: \"1\" }; }\n",
      "src/lib/zip.ts": "export function readZip(bytes: Uint8Array) { return bytes; }\nexport function createZip() { return new Uint8Array(); }\n",
      "src/trade/use-trade-action.ts": "export function fieldError() { return undefined; }\nexport function useTradeAction() { return null; }\n",
      "src/accounts/use-account-action.ts": "export function fieldError() { return \"live\"; }\n",
      "src/components/estimate.ts": [
        "import { budgetCents } from \"@/ai/budget\";",
        "import { createZip } from \"@/lib/zip\";",
        "import { useTradeAction } from \"../trade/use-trade-action\";",
        "import { fieldError } from \"../accounts/use-account-action\";",
        "function euros(value: number) { return value.toFixed(2); }",
        "const labels = { sessions: \"Sessions\", realizedR: 1 };",
        "console.log([euros(budgetCents(\"5\")), labels.sessions, \"sessions\", createZip(), useTradeAction(), fieldError()]);",
      ].join("\n"),
      "scripts/seed.mjs": "import { operationPricing } from \"../src/ai/pricing.ts\";\nconst seeded = { pricingFor(id) { return operationPricing(id); } };\nseeded.pricingFor(\"A\");\n",
      "scripts/fixtures.mjs": "export function readZip(buffer) { return buffer; }\nreadZip(null);\n",
    })).toEqual([
      "src/ai/budget.ts#euros",
      "src/ai/pricing.ts#pricingFor",
      "src/domain/analytics.ts#realizedR",
      "src/domain/analytics.ts#sessions",
      "src/lib/zip.ts#readZip",
      "src/trade/use-trade-action.ts#fieldError",
    ]);
  });

  it("resolves every import form to the module it names", () => {
    expect(unusedIn({
      "src/lib/a.ts": "export function viaAlias() {}\nexport function viaRelative() {}\nexport function viaExtension() {}\nexport function viaJs() {}\nexport function renamed() {}\nexport function typeOnly() {}\nexport function inlineType() {}\nexport function unused() {}\n",
      "src/lib/b/index.ts": "export function viaIndex() {}\nexport function notImported() {}\n",
      "src/lib/ns.ts": "export function read() {}\nexport function unread() {}\nexport function destructured() {}\n",
      "src/lib/whole.ts": "export function passedAlong() {}\nexport function alsoPassedAlong() {}\n",
      "src/lib/lazy.ts": "export function lazyNamed() {}\nexport function lazyUnused() {}\n",
      "src/lib/lazy-ns.ts": "export function lazyMember() {}\nexport function lazyNsUnused() {}\n",
      // A binding whose name also occurs inside `await`.
      "src/lib/lazy-w.ts": "export function wMember() {}\nexport function wUnused() {}\n",
      "src/lib/source.ts": "export function forwarded() {}\nexport function forwardedDead() {}\nexport function starUsed() {}\nexport function starUnused() {}\n",
      "src/lib/barrel.ts": "export { forwarded, forwardedDead as deadAlias } from \"./source\";\n",
      "src/lib/star.ts": "export * from \"./source\";\n",
      "src/app/use.tsx": [
        "import Default, { viaAlias, renamed as other, type inlineType } from \"@/lib/a\";",
        "import type { typeOnly } from \"@/lib/a\";",
        "import { viaRelative } from \"../lib/a\";",
        "import { viaExtension } from \"../lib/a.ts\";",
        "import { viaJs } from \"../lib/a.js\";",
        "import { viaIndex } from \"@/lib/b\";",
        "import * as ns from \"@/lib/ns\";",
        "import * as whole from \"@/lib/whole\";",
        "import { forwarded } from \"@/lib/barrel\";",
        "import { starUsed } from \"@/lib/star\";",
        "const { destructured } = ns;",
        "export async function run(x: typeof typeOnly, y: inlineType) {",
        "  const { lazyNamed } = await import(\"@/lib/lazy\");",
        "  const lazyNs = await import(\"@/lib/lazy-ns\");",
        "  const w = await import(\"@/lib/lazy-w\");",
        "  return [Default, viaAlias(), other(), viaRelative(), viaExtension(), viaJs(), viaIndex(), ns.read(), destructured(), keep(whole), forwarded(), starUsed(), lazyNamed(), lazyNs.lazyMember(), w.wMember(), x, y];",
        "}",
        "function keep(value: unknown) { return value; }",
        "run(null as never, null as never);",
      ].join("\n"),
    })).toEqual([
      "src/lib/a.ts#inlineType",
      "src/lib/a.ts#typeOnly",
      "src/lib/a.ts#unused",
      "src/lib/b/index.ts#notImported",
      "src/lib/barrel.ts#deadAlias",
      "src/lib/lazy-ns.ts#lazyNsUnused",
      "src/lib/lazy-w.ts#wUnused",
      "src/lib/lazy.ts#lazyUnused",
      "src/lib/ns.ts#unread",
      "src/lib/source.ts#forwardedDead",
      "src/lib/source.ts#starUnused",
    ]);
  });

  it("follows the modules a script loads by path to the members the scripts read", () => {
    // As scripts/local-stack/seed-v2.mjs does: modules loaded by a path string, bound by position, passed on as `app`.
    expect(unusedIn({
      "src/ai/operations.ts": "export function operationFor() {}\nexport function setupOperation() {}\n",
      "src/ai/pricing.ts": "export const PRICING_PROFILES = {};\nexport function operationPricing() {}\nexport function pricingFor() {}\n",
      "src/lib/one.ts": "export function used() {}\nexport function unusedOne() {}\n",
      "src/lib/two.ts": "export function anything() {}\n",
      "scripts/seed.mjs": [
        "import path from \"node:path\";",
        "import { seedPricing } from \"./seed-pricing.mjs\";",
        "const load = file => import(path.join(\"src\", file));",
        "const [operations, pricing] = await Promise.all([load(\"ai/operations.ts\"), load(\"ai/pricing.ts\")]);",
        "const app = { operations, pricing };",
        "const single = await load(\"lib/one.ts\");",
        "single.used();",
        "register(load(\"lib/two.ts\"));",
        "seedPricing(app).pricingFor(\"A\");",
      ].join("\n"),
      "scripts/seed-pricing.mjs": "export function seedPricing(app) {\n  app.operations.operationFor(\"A\");\n  const profile = app.pricing.PRICING_PROFILES.A;\n  return { pricingFor() { return app.pricing.operationPricing(profile); } };\n}\n",
    })).toEqual([
      "src/ai/operations.ts#setupOperation",
      "src/ai/pricing.ts#pricingFor",
      "src/lib/one.ts#unusedOne",
    ]);
  });

  it("counts uses inside the module itself, but not member accesses, keys, strings or a function's typeof", () => {
    expect(unusedIn({
      "src/lib/self.ts": [
        "export function keyOnly() { return { keyOnly: 1 }; }",
        "export function memberOnly() { return config.memberOnly; }",
        "export function stringOnly() { return \"stringOnly\"; }",
        "export function typeOnly() { return 1; }",
        "export type FromTypeOnly = ReturnType<typeof typeOnly>;",
        "export function calledInside() { return 2; }",
        "export const tuple = [\"A\", \"B\"] as const;",
        "export type Letter = (typeof tuple)[number];",
        "const config = { memberOnly: calledInside() };",
        "export default config;",
      ].join("\n"),
    })).toEqual(["src/lib/self.ts#keyOnly", "src/lib/self.ts#memberOnly", "src/lib/self.ts#stringOnly", "src/lib/self.ts#typeOnly"]);
  });

  it("lexes comments out, strings and regular expressions into placeholders, and keeps template expressions", () => {
    /** The placeholder of the first string literal (a private-use character around its index). */
    const first = "\uE000" + "0" + "\uE000";
    expect(lex("a // b\nc /* d */ e")).toEqual({ code: "a \nc   e", strings: [] });
    expect(lex("import { a } from \"@/lib/x\"; // note")).toEqual({ code: `import { a } from ${first}; `, strings: ["@/lib/x"] });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the lexer's input is source text holding template literals
    expect(lex("const t = `a${b + `c${d}`}e`, u = `plain`;")).toEqual({ code: `const t = \`\${b + \`\${d}\`}\`, u = ${first};`, strings: ["plain"] });
    expect(lex("const r = /[\"/]`/g; const s = 'a';")).toEqual({ code: `const r = 0; const s = ${first};`, strings: ["a"] });
    expect(lex("if (/^a/.test(v)) return x / y / z;").code).toBe("if (0.test(v)) return x / y / z;");
    // An apostrophe in JSX text opens no string, so the rest of the line is still code.
    expect(lex("<p>Don't {name}</p>").code).toBe("<p>Don't {name}</p>");
  });
});
