#!/usr/bin/env node
// Unused-export check (part of `pnpm lint`): every exported value of src/ (function, class, const, let, var, enum, and
// the names a module re-exports) needs a caller in the application or in the repository scripts. An export that only
// tests import, or that nothing uses at all, is dead code, and tests of it protect nothing the app runs (V1 leftovers
// were found this way).
//
// Usage: node scripts/check-unused-exports.mjs [--root=<repo>]
//   Exits 1 when an export has no caller, or when an entry of KEPT below no longer applies.
//
// Callers are resolved per module, not by name: an export N of module M has a caller when another file under src/ or
// scripts/ (tests never count)
//   - imports N from a specifier that resolves to M (`@/` is src/, relative paths, with or without an extension):
//     `import { N } from`, `const { N } = await import(...)`, or `export { N } from`, which counts once the re-exported
//     name itself has a caller (likewise `export * from`);
//   - binds M as a namespace (`import * as ns`, `const ns = await import(...)`) and reads `ns.N` or destructures N from
//     it; a namespace used any other way (passed along whole) counts as a use of every export;
//   - loads M through a path string (scripts/local-stack/seed-v2.mjs: `load("ai/pricing.ts")`, bound to a name directly
//     or by its position in a `const [a, b] = await Promise.all([...])`) and some script reads `<binding>.N`
//     (`app.pricing.operationPricing`); a load whose binding cannot be told counts as a use of every export.
// Inside M itself, an identifier use of N beyond its declaration also counts (then only the `export` keyword is
// superfluous, which is not dead code); member accesses (`x.N`), object keys (`{ N: 1 }`), strings and comments do not,
// and for a function neither does `typeof N` (a function that only gives a type is never called). A same-named
// function, method, string or key in another file therefore never hides a dead export. Types and interfaces are not
// checked, and neither are default exports nor the exports Next.js reads by name from its route files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exports kept on purpose although no application code or script calls them, each with its reason. An entry that no
 * longer applies (the export is gone, or now has a caller) fails the check, so this list cannot go stale.
 */
export const KEPT = Object.freeze({
  "src/ai/trade-review-contract.ts#validateTradeReview":
    "V1 REVIEW_TRADE contract validator: V2 no longer starts that review (spec §11.4), but stored V1 reviews still render, the contract keeps its contract and citation tests, and the mock provider's output is checked against it",
  "src/domain/analytics.ts#filterTrades":
    "V1 EDGE filter semantics, kept with tests/analytics.test.ts, which also reads enrichTrades' daily sequence and predecessor fields through it (enrichTrades feeds the periodic AI facts)",
  "src/domain/fixtures.ts#previewProposal": "synthetic fixture shared by the risk, AI, database and screen tests (src/domain/fixtures.ts)",
  "src/domain/fixtures.ts#previewContext": "synthetic fixture shared by the risk, AI, database and screen tests (src/domain/fixtures.ts)",
  "src/domain/fixtures.ts#usageFixture": "synthetic fixture shared by the risk and screen tests (src/domain/fixtures.ts)",
  "src/components/evidence/dev-demo.tsx#EvidenceJournalDemo":
    "development demo of the evidence, composer and timeline components working together, rendered by its own test",
  "src/components/evidence/types.ts#CAPTURE_METHODS": "the closed capture-method vocabulary, pinned next to the label and timeframe lists by the stager test",
  "src/components/ui/dialog.tsx#SheetClose": "UI primitive set: the sheet's close slot, covered by the slot-trigger test",
  "src/components/ui/popover.tsx#PopoverClose": "UI primitive set: the popover's close slot, covered by the slot-trigger test",
  "src/components/ui/dropdown-menu.tsx#DropdownMenuGroup": "UI primitive set: the menu's item group",
  "src/lib/zip.ts#readZip":
    "the strict reader of the archives createZip writes (headers against the central directory, every CRC-32): the export tests read each downloaded archive with it, and it shares the writer's constants and CRC table, so it lives beside it",
  "src/ai/monthly-review-context.ts#monthlyReviewContext":
    "MONTHLY_REVIEW_FACTS_V1 builder: the app builds only V2 facts now (monthlyReviewContextV2), but the stored-V1-history fixture (tests/fixtures/monthly-review.ts) and the mock-provider, contract and citation tests build their V1 facts with it",
  "src/ai/recent-trades-context.ts#recentTradesContext":
    "RECENT_TRADES_FACTS_V1 builder: the app builds only V2 facts now (recentTradesContextV2), but the stored-V1-history fixture (tests/fixtures/recent-trades.ts) and the mock-provider and contract tests build their V1 facts with it",
});

const SELF = "scripts/check-unused-exports.mjs";
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** Every export of a module (a namespace used whole, an unresolvable load). */
const ALL = "*";

/** Names Next.js reads from its file conventions (src/app route files, src/proxy.ts, src/instrumentation.ts). */
const NEXT_ROUTE_FILE = /^src\/app\/(?:.*\/)?(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(?:ts|tsx|js|jsx)$/;
const NEXT_ROUTE_NAMES = new Set([
  "metadata", "generateMetadata", "viewport", "generateViewport", "generateStaticParams", "generateImageMetadata", "generateSitemaps",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "experimental_ppr",
  "alt", "size", "contentType", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS",
]);
const NEXT_ROOT_FILES = new Map([
  ["src/proxy.ts", new Set(["proxy", "config"])],
  ["src/middleware.ts", new Set(["middleware", "config"])],
  ["src/instrumentation.ts", new Set(["register", "onRequestError"])],
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lexing: comments removed, every string literal (and every template literal without `${}`) replaced by a numbered
// placeholder, template text dropped while its `${}` expressions stay, regular-expression literals replaced by 0.
// ---------------------------------------------------------------------------------------------------------------
const MARK = "\uE000";
const PLACEHOLDER = /\uE000(\d+)\uE000/g;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function regexMayStart(out) {
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1])) end--;
  if (end === 0) return true;
  const last = out[end - 1];
  // `<` and `}` are left out on purpose: in JSX text they start `</tag>` and follow `{expression}`.
  if ("(,=:[!&|?+-*%~^;{>".includes(last)) return true;
  let start = end;
  while (start > 0 && /[\w$]/.test(out[start - 1])) start--;
  return start < end && REGEX_AFTER_WORD.has(out.slice(start, end));
}

/**
 * `{ code, strings }`: the source as described above, and the values of its string literals, indexed by placeholder
 * (`\uE000<index>\uE000`). A quote with no closing quote on its line is JSX text (an apostrophe), not a string.
 */
export function lex(source) {
  const strings = [];
  let i = 0;
  const placeholder = value => {
    strings.push(value);
    return `${MARK}${strings.length - 1}${MARK}`;
  };
  function read(insideTemplate) {
    let out = "";
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      const d = source[i + 1];
      if (c === "/" && d === "/") {
        while (i < source.length && source[i] !== "\n") i++;
      } else if (c === "/" && d === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
        out += " ";
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        let value = "";
        while (j < source.length && source[j] !== c && source[j] !== "\n") {
          if (source[j] === "\\") {
            value += source[j + 1] ?? "";
            j += 2;
          } else value += source[j++];
        }
        if (source[j] === c) {
          out += placeholder(value);
          i = j + 1;
        } else {
          out += c;
          i++;
        }
      } else if (c === "`") {
        i++;
        let raw = "";
        let expressions = "";
        let plain = true;
        while (i < source.length && source[i] !== "`") {
          if (source[i] === "\\") {
            raw += source[i + 1] ?? "";
            i += 2;
          } else if (source[i] === "$" && source[i + 1] === "{") {
            i += 2;
            plain = false;
            expressions += `\${${read(true)}}`;
            i++;
          } else raw += source[i++];
        }
        i++;
        out += plain ? placeholder(raw) : `\`${expressions}\``;
      } else if (c === "/" && regexMayStart(out)) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length && source[j] !== "\n") {
          if (source[j] === "\\") j++;
          else if (source[j] === "[") inClass = true;
          else if (source[j] === "]") inClass = false;
          else if (source[j] === "/" && !inClass) break;
          j++;
        }
        if (source[j] === "/") {
          j++;
          while (j < source.length && /[a-z]/i.test(source[j])) j++;
          out += "0";
          i = j;
        } else {
          out += c;
          i++;
        }
      } else {
        if (insideTemplate && c === "{") depth++;
        if (insideTemplate && c === "}") {
          if (depth === 0) return out;
          depth--;
        }
        out += c;
        i++;
      }
    }
    return out;
  }
  return { code: read(false), strings };
}

// ---------------------------------------------------------------------------------------------------------------
// Module syntax
// ---------------------------------------------------------------------------------------------------------------
const VALUE_EXPORT = /(?<![\w$.])export[ \t]+(?:declare[ \t]+)?(?:async[ \t]+)?(function\*?|const|let|var|class|enum|abstract[ \t]+class)[ \t]+([A-Za-z_$][\w$]*)/g;
const LOCAL_EXPORT_LIST = /(?<![\w$.])export[ \t]*\{([^}]*)\}(?![ \t]*from\b)/g;
const IMPORT_FROM = /(?<![\w$.])import\s+(type\s+)?([\w$\s,{}*]*?)\s*from\s*\uE000(\d+)\uE000/g;
const EXPORT_FROM = /(?<![\w$.])export\s+(type\s+)?(?:\*(?:\s+as\s+([\w$]+))?|\{([^}]*)\})\s*from\s*\uE000(\d+)\uE000/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*\uE000(\d+)\uE000\s*\)/g;
const BOUND_BEFORE = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?$/;
const LOADED_BEFORE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?[\w$.]+\s*\(\s*$/;
const PROMISE_ALL = /(?:const|let|var)\s*\[([^\]]*)\]\s*=\s*(?:await\s+)?Promise\.all\(\s*\[/g;
const MODULE_PATH = /^[\w@./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The imported names of a `{ a, b as c, type T }` list (type-only entries left out). */
function importedNames(list) {
  return list.split(",").map(part => part.trim()).filter(part => part && !/^type\s/.test(part)).map(part => part.split(/\s+as\s+/)[0].trim());
}

/** The property names a `{ a, b: c, d = 1, ...rest }` pattern reads (`*` for a rest element). */
function destructuredNames(pattern) {
  return pattern.replace(/^\{|\}$/g, "").split(",").map(part => part.trim()).filter(Boolean)
    .map(part => (part.startsWith("...") ? ALL : part.split(/[:=]/)[0].trim()));
}

/**
 * Uses of `name` as an identifier: not a member access (`x.name`), an object key (`{ name: 1 }`) or part of a word.
 * With `runtimeOnly` (for a function), `typeof name` does not count either: a function that only gives a type is
 * never called.
 */
function identifierUses(code, name, runtimeOnly = false) {
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  let count = 0;
  for (const match of code.matchAll(pattern)) {
    const before = code.slice(Math.max(0, match.index - 200), match.index).trimEnd();
    if (before.endsWith(".") && !before.endsWith("...")) continue;
    if (runtimeOnly && /(?<![\w$])typeof$/.test(before)) continue;
    if (/[{,]$/.test(before) && /^\s*:(?!:)/.test(code.slice(match.index + name.length))) continue;
    count++;
  }
  return count;
}

/** Exported values of one module: `name` as importers see it, `local` as the module itself uses it. */
function exportsOf(rel, code, strings, resolveFrom) {
  const found = [];
  for (const match of code.matchAll(VALUE_EXPORT)) found.push({ name: match[2], local: match[2], declared: 1, isFunction: match[1].startsWith("function") });
  // `export { a, b as c };` names locals declared (or imported) elsewhere in the module: two occurrences each.
  for (const match of code.matchAll(LOCAL_EXPORT_LIST)) {
    for (const part of match[1].split(",").map(value => value.trim())) {
      if (!part || part.startsWith("type ")) continue;
      const [local, name = local] = part.split(/\s+as\s+/).map(value => value.trim());
      found.push({ name, local, declared: 2 });
    }
  }
  // `export { a as b } from "./x"` and `export * as ns from "./x"`: names of this module that forward to another one.
  for (const match of code.matchAll(EXPORT_FROM)) {
    if (match[1] || !resolveFrom(strings[Number(match[4])])) continue;
    if (match[2]) found.push({ name: match[2], reexport: true });
    else if (match[3] !== undefined) {
      for (const part of match[3].split(",").map(value => value.trim())) {
        if (!part || part.startsWith("type ")) continue;
        const pieces = part.split(/\s+as\s+/).map(value => value.trim());
        found.push({ name: pieces[1] ?? pieces[0], reexport: true });
      }
    }
  }
  const framework = NEXT_ROOT_FILES.get(rel) ?? (NEXT_ROUTE_FILE.test(rel) ? NEXT_ROUTE_NAMES : null);
  return found.filter(({ name }) => !framework?.has(name));
}

// ---------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------

/**
 * Exported values of src/ without a caller in src/ or scripts/ (`tests` lists the test files that import them by
 * name), and the KEPT entries that no longer apply.
 */
export function findUnusedExports({ root, kept = KEPT } = {}) {
  const rel = file => path.relative(root, file).split(path.sep).join("/");
  const srcRoot = path.join(root, "src");
  const sources = walk(srcRoot);
  const sourceSet = new Set(sources);
  // This file names the KEPT exports, which is no use of them.
  const callers = [...sources, ...walk(path.join(root, "scripts")).filter(file => rel(file) !== SELF)];
  const tests = walk(path.join(root, "tests"));
  const lexed = new Map([...callers, ...tests].map(file => [file, lex(fs.readFileSync(file, "utf8"))]));

  const asModule = base => {
    const candidates = [base, ...EXTENSIONS.map(extension => base + extension), ...EXTENSIONS.map(extension => path.join(base, `index${extension}`))];
    if (/\.[cm]?jsx?$/.test(base)) candidates.push(base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"));
    const hit = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return hit && sourceSet.has(hit) ? hit : null;
  };
  /** The src module an import specifier names, or null (packages, files outside src/). */
  const resolve = (from, specifier) => {
    if (typeof specifier !== "string") return null;
    if (specifier.startsWith("@/")) return asModule(path.join(srcRoot, specifier.slice(2)));
    if (/^\.\.?(?:\/|$)/.test(specifier)) return asModule(path.resolve(path.dirname(from), specifier));
    return null;
  };
  /** The src module a path string names (`ai/pricing.ts` from src/, `src/...` from the root, or relative). */
  const resolvePath = (from, value) =>
    resolve(from, value) ?? asModule(path.join(srcRoot, value)) ?? asModule(path.join(root, value)) ?? asModule(path.resolve(path.dirname(from), value));

  /** Collects the uses the files make: `onUse(module, name, file)` with `*` for every export. */
  function collect(files, onUse) {
    const forwards = [];
    const loadBindings = [];
    for (const file of files) {
      const { code, strings } = lexed.get(file);
      const specifiers = new Set();
      const namespace = (target, alias, declaredAt) => {
        const pattern = new RegExp(`(?<![\\w$])${alias.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
        for (const match of code.matchAll(pattern)) {
          if (match.index === declaredAt) continue;
          const before = code.slice(Math.max(0, match.index - 200), match.index).trimEnd();
          if (before.endsWith(".") && !before.endsWith("...")) continue;
          const member = code.slice(match.index + alias.length).match(/^\s*\??\.\s*([\w$]+)/);
          const destructured = before.match(/(\{[^{}]*\})\s*=$/);
          if (member) onUse(target, member[1], file);
          else if (destructured) for (const name of destructuredNames(destructured[1])) onUse(target, name, file);
          else onUse(target, ALL, file);
        }
      };
      for (const match of code.matchAll(IMPORT_FROM)) {
        specifiers.add(Number(match[3]));
        const target = resolve(file, strings[Number(match[3])]);
        if (!target || match[1]) continue;
        const clause = match[2];
        const braces = clause.match(/\{([^}]*)\}/);
        if (braces) for (const name of importedNames(braces[1])) onUse(target, name, file);
        const star = clause.match(/\*\s*as\s+([\w$]+)/);
        if (star) namespace(target, star[1], match.index + match[0].indexOf(star[1], match[0].indexOf("*")));
      }
      for (const match of code.matchAll(EXPORT_FROM)) {
        specifiers.add(Number(match[4]));
        const target = resolve(file, strings[Number(match[4])]);
        if (!target || match[1]) continue;
        if (match[2]) forwards.push({ from: file, name: match[2], target, imported: ALL });
        else if (match[3] === undefined) forwards.push({ from: file, name: ALL, target, imported: ALL });
        else {
          for (const part of match[3].split(",").map(value => value.trim())) {
            if (!part || part.startsWith("type ")) continue;
            const [imported, name = imported] = part.split(/\s+as\s+/).map(value => value.trim());
            forwards.push({ from: file, name, target, imported });
          }
        }
      }
      for (const match of code.matchAll(DYNAMIC_IMPORT)) {
        specifiers.add(Number(match[1]));
        const target = resolve(file, strings[Number(match[1])]);
        if (!target) continue;
        const start = Math.max(0, match.index - 400);
        const bound = code.slice(start, match.index).match(BOUND_BEFORE);
        if (!bound) onUse(target, ALL, file);
        else if (bound[1].startsWith("{")) for (const name of destructuredNames(bound[1])) onUse(target, name, file);
        else namespace(target, bound[1], start + bound.index + bound[0].indexOf(bound[1], bound[0].search(/\s/)));
      }
      // Modules loaded through a path string, bound by their position in a Promise.all destructuring or directly.
      const byPosition = new Map();
      for (const match of code.matchAll(PROMISE_ALL)) {
        const names = match[1].split(",").map(value => value.trim());
        let position = 0;
        let depth = 0;
        for (let k = match.index + match[0].length; k < code.length; k++) {
          const c = code[k];
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) {
            if (depth === 0) break;
            depth--;
          } else if (c === "," && depth === 0) position++;
          else if (c === MARK) {
            const end = code.indexOf(MARK, k + 1);
            const binding = names[position];
            if (binding && /^[\w$]+$/.test(binding)) byPosition.set(Number(code.slice(k + 1, end)), binding);
            k = end;
          }
        }
      }
      for (const match of code.matchAll(PLACEHOLDER)) {
        const index = Number(match[1]);
        if (specifiers.has(index) || !MODULE_PATH.test(strings[index])) continue;
        const target = resolvePath(file, strings[index]);
        if (!target) continue;
        const binding = byPosition.get(index) ?? code.slice(Math.max(0, match.index - 400), match.index).match(LOADED_BEFORE)?.[1];
        if (binding) loadBindings.push({ binding, target });
        else onUse(target, ALL, file);
      }
    }
    // A bound module travels under its binding's name (`app.pricing`): `<binding>.N` in any of the files reads N.
    for (const { binding, target } of loadBindings) {
      const name = binding.replace(/\$/g, "\\$");
      for (const file of files) {
        const { code } = lexed.get(file);
        for (const match of code.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\??\\.\\s*([\\w$]+)`, "g"))) onUse(target, match[1], file);
        for (const match of code.matchAll(new RegExp(`(\\{[^{}]*\\})\\s*=\\s*(?:[\\w$]+\\s*\\??\\.\\s*)*${name}(?![\\w$]|\\s*\\??\\.)`, "g"))) {
          for (const property of destructuredNames(match[1])) onUse(target, property, file);
        }
      }
    }
    return forwards;
  }

  const uses = new Map();
  const add = (map, target, name) => {
    if (!map.has(target)) map.set(target, new Set());
    const names = map.get(target);
    if (names.has(name)) return false;
    names.add(name);
    return true;
  };
  const forwards = collect(callers, (target, name) => add(uses, target, name));
  // Re-exports pass their uses on to the module they forward to, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const { from, name, target, imported } of forwards) {
      const used = uses.get(from);
      if (!used) continue;
      if (name === ALL) for (const each of [...used]) changed = add(uses, target, each) || changed;
      else if (used.has(name) || used.has(ALL)) changed = add(uses, target, imported) || changed;
    }
  }
  const testUses = new Map();
  collect(tests, (target, name, file) => {
    const key = `${target}#${name}`;
    if (!testUses.has(key)) testUses.set(key, new Set());
    testUses.get(key).add(rel(file));
  });

  const uncalled = new Map();
  for (const file of sources) {
    const { code, strings } = lexed.get(file);
    const used = uses.get(file) ?? new Set();
    for (const { name, local, declared, reexport, isFunction } of exportsOf(rel(file), code, strings, specifier => resolve(file, specifier))) {
      if (used.has(name) || used.has(ALL)) continue;
      if (!reexport && identifierUses(code, local, isFunction) > declared) continue;
      uncalled.set(`${rel(file)}#${name}`, { file: rel(file), name, tests: [...(testUses.get(`${file}#${name}`) ?? [])].sort() });
    }
  }
  return {
    unused: [...uncalled].filter(([key]) => !Object.hasOwn(kept, key)).map(([, item]) => item),
    stale: Object.keys(kept).filter(key => !uncalled.has(key)),
  };
}

function main() {
  const arg = process.argv.find(value => value.startsWith("--root="));
  const root = path.resolve(arg ? arg.slice("--root=".length) : path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const { unused, stale } = findUnusedExports({ root });
  for (const item of unused) {
    console.error(`${item.file}: export ${item.name} has no caller in src/ or scripts/${item.tests.length ? ` (only tests: ${item.tests.join(", ")})` : ""}`);
  }
  for (const key of stale) console.error(`${SELF}: KEPT entry ${key} no longer applies (the export is gone or now has a caller); remove it`);
  if (unused.length || stale.length) {
    console.error(`Unused exports: ${unused.length} without a caller, ${stale.length} stale KEPT entr${stale.length === 1 ? "y" : "ies"}. Delete the dead code and the tests that only exercise it, or add a reasoned KEPT entry.`);
    process.exit(1);
  }
  console.log("Unused exports: none.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
