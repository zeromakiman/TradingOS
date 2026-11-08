// Deterministic SYNTHETIC V2 dataset for scripts/local-stack/seed-v2.mjs. Pure: no I/O, no clock reads.
//
// buildDataset({variant, userId, nowMs}) returns
//   accounts  three trading accounts with deterministic ids, instruments and risk-plan history;
//   history   chronological calls of the pg_temp helpers in fixtures/seed-v2-history.sql: every record whose time is
//             in the past, including the earlier part of today;
//   evidence  every screenshot to render (chart parameters, label, timeframe, caption, time; via SQL or RPC);
//   plan      what the seed performs NOW through the RPCs (as the user, or the service-only evidence/AI RPCs);
//   marks     trades and evidence that later steps (reviews, relabel/remove, AI) refer to.
// The same (variant, user id, strategy day, time of day) always yields the same dataset. Prices are integer tick
// counts and money is integer cents, formatted as exact decimal strings; nothing goes through floating point.

import { createHash } from "node:crypto";
import {
  CANCEL_REASONS, CAPTIONS, DAILY_CONTEXTS, DISCARD_REASONS, LESSONS, LIVE_NOTES, PRE_ENTRY_NOTES, SKIP_REASONS, liquidityStory, thesis,
} from "./v2-copy.mjs";

export const DATASET_VERSION = "TRADING_OS_V2_SEED_1";
const MIN = 60_000;
const DAY = 86_400_000;
const OFFSET = 5 * 3_600_000; // fixed UTC−5 strategy clock

// ---------------------------------------------------------------------------------------------------------------
// Strategy clock, randomness, identifiers, exact decimals
// ---------------------------------------------------------------------------------------------------------------
export const strategyDay = ms => new Date(ms - OFFSET).toISOString().slice(0, 10);
export const dayStart = day => Date.parse(`${day}T00:00:00.000Z`) + OFFSET;
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
export const weekdayOf = day => new Date(`${day}T00:00:00.000Z`).getUTCDay();
export const iso = ms => new Date(ms).toISOString();
export function session(ms) {
  const minute = Math.floor(((((ms - OFFSET) % DAY) + DAY) % DAY) / MIN);
  return minute >= 1080 || minute < 60 ? "ASIA" : minute < 120 ? "JUDAS" : minute < 720 ? "ACTIVE_KILL_ZONE" : "DEAD_POOL";
}
const at = (day, minute) => dayStart(day) + minute * MIN;
const isWeekday = day => weekdayOf(day) >= 1 && weekdayOf(day) <= 5;
/** Monday (YYYY-MM-DD) of the strategy-day week containing `day`. */
export const mondayOf = day => addDays(day, -((weekdayOf(day) + 6) % 7));

/** sfc32 seeded from SHA-256: identical sequences on every platform. */
export function createRandom(seedText) {
  const h = createHash("sha256").update(seedText).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0;
    t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };
  for (let i = 0; i < 16; i++) next();
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    shuffle: list => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
      return copy;
    },
    fork: label => createRandom(`${seedText}/${label}`),
  };
}

/** Deterministic RFC 4122 v4-shaped UUID derived from the parts (lowercase, so every app regex accepts it). */
export function uuidFor(...parts) {
  const h = createHash("sha256").update(parts.join("\u001f")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Positive integer count of 10^-scale units as an exact decimal string (115823, 5 -> "1.15823"). */
export function unitsText(units, scale) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error(`Invalid decimal units ${units}`);
  if (scale === 0) return String(units);
  const digits = String(units).padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
/** Signed integer cents as money text ("-85.00", "0.00"). */
export function moneyText(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid cents ${cents}`);
  return cents === 0 ? "0.00" : `${cents < 0 ? "-" : ""}${unitsText(Math.abs(cents), 2)}`;
}
/** Scale (decimal places) of a decimal string such as "0.01". */
export const scaleOf = text => (text.split(".")[1] ?? "").length;

// ---------------------------------------------------------------------------------------------------------------
// Contracts and price paths
// ---------------------------------------------------------------------------------------------------------------
/**
 * Contract specs (create_instrument_version input) and synthetic market parameters: base price, daily volatility and
 * stop distances in ticks, tick value and commission per lot in account cents.
 */
export const CONTRACTS = Object.freeze({
  EURUSD: { quantityUnit: "lots (100,000 EUR)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", scale: 5, base: 115_800, vol: 420, stop: [110, 230], tickCents: 100, feeCents: 600 },
  GBPUSD: { quantityUnit: "lots (100,000 GBP)", tickSize: "0.00001", pipSize: "0.0001", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", scale: 5, base: 133_500, vol: 520, stop: [130, 280], tickCents: 100, feeCents: 600 },
  XAUUSD: { quantityUnit: "lots (100 oz)", tickSize: "0.01", pipSize: "0.1", tickValue: "1", quantityStep: "0.01", minimumQuantity: "0.01", scale: 2, base: 335_000, vol: 3_000, stop: [420, 880], tickCents: 100, feeCents: 700 },
  US100: { quantityUnit: "lots ($1 per point)", tickSize: "0.1", pipSize: "1", tickValue: "0.1", quantityStep: "0.1", minimumQuantity: "0.1", scale: 1, base: 215_000, vol: 2_100, stop: [260, 580], tickCents: 10, feeCents: 0 },
  DE40: { quantityUnit: "lots (€1 per point)", tickSize: "0.1", pipSize: "1", tickValue: "0.1", quantityStep: "0.1", minimumQuantity: "0.1", scale: 1, base: 234_000, vol: 1_800, stop: [200, 420], tickCents: 10, feeCents: 50 },
  FRA40: { quantityUnit: "lots (€1 per point)", tickSize: "0.1", pipSize: "1", tickValue: "0.1", quantityStep: "0.1", minimumQuantity: "0.1", scale: 1, base: 79_500, vol: 700, stop: [120, 290], tickCents: 10, feeCents: 50 },
  EU50: { quantityUnit: "lots (€1 per point)", tickSize: "0.1", pipSize: "1", tickValue: "0.1", quantityStep: "0.01", minimumQuantity: "0.01", scale: 1, base: 53_500, vol: 520, stop: [90, 200], tickCents: 10, feeCents: 50 },
});
export function contractInput(symbol, overrides = {}) {
  const c = { ...CONTRACTS[symbol], ...overrides };
  return { symbol, quantityUnit: c.quantityUnit, tickSize: c.tickSize, pipSize: c.pipSize, tickValue: c.tickValue, quantityStep: c.quantityStep, minimumQuantity: c.minimumQuantity };
}
/** Commission per lot as a decimal string for the SQL close helper (cents -> "6", "0.5"). */
const feeRate = cents => (cents === 0 ? "0" : moneyText(cents).replace(/\.?0+$/, ""));

/** Daily reference prices (ticks) per symbol across the dataset window: a mean-reverting random walk. */
function pricePaths(random, firstDay, days) {
  const paths = {};
  for (const [symbol, c] of Object.entries(CONTRACTS)) {
    const r = random.fork(`price/${symbol}`);
    let price = c.base;
    const path = new Map();
    for (let i = 0; i <= days; i++) {
      path.set(addDays(firstDay, i), price);
      price = Math.max(Math.round(c.base * 0.8), Math.round(price + (c.base - price) * 0.03 + (r.next() - 0.5) * 2 * c.vol));
    }
    paths[symbol] = path;
  }
  return paths;
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts and risk-plan history (mirrors what the SQL helpers insert)
// ---------------------------------------------------------------------------------------------------------------
const ACCOUNT_DEFS = [
  { key: "ftmo", name: "FTMO 100K", currency: "USD", accountType: "EVALUATION", platform: "MT5", broker: "FTMO", startingCents: 10_000_000, symbols: ["EURUSD", "GBPUSD", "XAUUSD", "US100"], created: 1145 },
  { key: "personal", name: "Personal 12K", currency: "EUR", accountType: "PERSONAL", platform: "CTRADER", broker: null, startingCents: 1_200_000, symbols: ["DE40", "FRA40"], created: 1152 },
  { key: "demo", name: "Demo 100K", currency: "USD", accountType: "DEMO", platform: "MANUAL", broker: null, startingCents: 10_000_000, symbols: ["EURUSD", "GBPUSD"], created: 1160 },
];
const V1_0 = Object.freeze({ maxRiskPercent: "0.5", defaultRiskPercent: "0.5", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN" });
/** Historical risk-plan versions after V1.0: [days before today, minute, config, immediate, reason]. */
const RISK_HISTORY = {
  ftmo: [[-47, 1180, { maxRiskPercent: "1", defaultRiskPercent: "0.5", maxDailyTrades: 3, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "BLOCK", dailyRiskCap: "2500.00", dailyLossCap: "5000.00" }, false, null]],
  personal: [[-21, 565, { maxRiskPercent: "0.5", defaultRiskPercent: "0.25", maxDailyTrades: 2, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "WARN", dailyLossCap: "150.00" }, true,
    "Three losses in a row on DE40 — cutting risk to 0.25% until the end of the month."]],
  demo: [[-61, 1110, { maxRiskPercent: "1", defaultRiskPercent: "1", maxDailyTrades: 2, minRR: "2.5", rrPolicy: "WARN", newsPolicy: "WARN" }, false, null]],
};

/** Risk plan in force at `ms` (created by then and effective on its strategy day; newest created wins). */
function riskAt(account, ms) {
  const day = strategyDay(ms);
  const eligible = account.riskVersions.filter(v => v.createdAt <= ms && v.effectiveDay <= day);
  return eligible.reduce((best, v) => (v.createdAt >= best.createdAt ? v : best), eligible[0]).config;
}

// SQL argument builders (rendered by seed-v2.mjs; helpers in fixtures/seed-v2-history.sql).
const U = v => ({ t: "uuid", v });
const T = v => ({ t: "text", v });
const J = v => ({ t: "jsonb", v });
const TS = v => ({ t: "ts", v });
const N = v => ({ t: "numeric", v });
const B = v => ({ t: "bool", v });
const A = v => ({ t: "textarray", v });
const EV = v => ({ t: "evidence", v });

// ---------------------------------------------------------------------------------------------------------------
// History chronology: the per-trade preconditions of the pg_temp helpers, checked before anything is written
// ---------------------------------------------------------------------------------------------------------------
/** Position of the trade id among each helper's arguments (seed_evidence names its trade in the evidence spec). */
const TRADE_ARGUMENT = Object.freeze({
  seed_draft: 1, seed_check: 0, seed_lock: 0, seed_entry: 0, seed_close: 0, seed_disposition: 0, seed_lifecycle: 0,
  seed_live: 1, seed_complete_entry: 0, seed_close_live: 0, seed_journal: 0, seed_tags: 0,
});
/** The lifecycle each seed_lifecycle event requires (discard_trade_draft, complete_trade_review, reopen_trade_review). */
const LIFECYCLE_REQUIRES = Object.freeze({ DRAFT_DISCARDED: "DRAFT", REVIEW_COMPLETED: "CLOSED", REVIEW_REOPENED: "REVIEWED" });

/** Lifecycle of a trade as private.trade_lifecycle derives it from the records written so far. */
function lifecycleOf(trade) {
  if (trade.origin === "LIVE_FIRST") return trade.closed ? (trade.reviewed ? "REVIEWED" : "CLOSED") : "LIVE";
  if (trade.discarded) return "DISCARDED";
  if (trade.lockedAt === null) return "DRAFT";
  if (trade.closed) return trade.reviewed ? "REVIEWED" : "CLOSED";
  if (trade.entryLogged) return "LIVE";
  return trade.disposed ? "DISPOSED" : "LOCKED";
}

/**
 * Problems of a history in execution order, one sentence each (empty when valid): every step on a trade must find
 * the trade in the state its helper requires (a draft before its checks and lock, the entry logged after the lock and
 * before the close, a disposition only before the entry, a review only after the close, …), and every reported entry
 * or exit time must lie between the records that bound it. The helpers raise on any of these, and their single
 * transaction then rolls back the user's whole history.
 */
export function chronologyIssues(history, evidence) {
  const tradeOfEvidence = new Map(evidence.map(spec => [spec.id, spec.tradeId]));
  const trades = new Map();
  const issues = [];
  for (const step of history) {
    const position = TRADE_ARGUMENT[step.fn];
    const tradeId = step.fn === "seed_evidence" ? tradeOfEvidence.get(step.args[1].v) : position === undefined ? undefined : step.args[position].v;
    if (tradeId === undefined) continue; // account-level step
    const problem = message => issues.push(`${step.fn} of trade ${tradeId} at ${iso(step.at)}: ${message}`);
    const trade = trades.get(tradeId);
    if (!trade) {
      if (step.fn === "seed_draft") {
        trades.set(tradeId, { origin: "PLANNED", lockedAt: null, enteredAt: null, entryLogged: false, closed: false, disposed: false, discarded: false, reviewed: false });
      } else if (step.fn === "seed_live") {
        const reported = step.args[4].v.enteredAt;
        const enteredAt = reported ? Date.parse(reported) : null;
        if (enteredAt !== null && enteredAt > step.at) problem("the reported entry time is after its recording");
        trades.set(tradeId, { origin: "LIVE_FIRST", enteredAt, entryLogged: true, closed: false, reviewed: false });
      } else {
        problem("the trade does not exist yet");
      }
      continue;
    }
    const state = lifecycleOf(trade);
    const [first, second] = step.args.filter(arg => arg.t === "ts").map(arg => arg.v);
    switch (step.fn) {
      case "seed_draft":
      case "seed_check":
        if (state !== "DRAFT") problem(`the trade is ${state}, not an editable draft`);
        break;
      case "seed_lock":
        if (state !== "DRAFT") problem(`the trade is ${state}, not an editable draft`);
        trade.lockedAt = step.at;
        break;
      case "seed_entry": // (…, entered_at, recorded_at)
        if (state !== "LOCKED") problem(`the entry is logged while the trade is ${state}`);
        else if (first < trade.lockedAt || first > second) problem("the reported entry time must lie between the lock and its recording");
        trade.enteredAt = first;
        trade.entryLogged = true;
        break;
      case "seed_close": // (…, exited_at, …, recorded_at)
        if (state !== "LIVE") problem(`the close is logged while the trade is ${state}`);
        else if (first < trade.enteredAt || first > second) problem("the reported exit time must lie between the entry and its recording");
        trade.closed = true;
        break;
      case "seed_disposition":
        if (state !== "LOCKED") problem(`a skip or cancel needs a locked plan without an entry; the trade is ${state}`);
        trade.disposed = true;
        break;
      case "seed_lifecycle": {
        const event = step.args[1].v;
        if (state !== LIFECYCLE_REQUIRES[event]) problem(`${event} needs a ${LIFECYCLE_REQUIRES[event]} trade; the trade is ${state}`);
        if (event === "DRAFT_DISCARDED") trade.discarded = true;
        else trade.reviewed = event === "REVIEW_COMPLETED";
        break;
      }
      case "seed_complete_entry": {
        if (state !== "LIVE" || trade.origin !== "LIVE_FIRST") problem(`entry details need an open live-first trade; the trade is ${state}`);
        const reported = step.args[3].v.enteredAt;
        if (reported && trade.enteredAt === null) trade.enteredAt = Date.parse(reported);
        break;
      }
      case "seed_close_live": {
        const exitedAt = Date.parse(step.args[1].v.exitedAt);
        if (state !== "LIVE" || trade.origin !== "LIVE_FIRST") problem(`the close is logged while the trade is ${state}`);
        else if ((trade.enteredAt !== null && exitedAt < trade.enteredAt) || exitedAt > step.at) problem("the reported exit time must lie between the entry and its recording");
        trade.closed = true;
        break;
      }
      default: // journal entries, screenshots and tags only need the trade to exist
        break;
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------------------------------------------
export function buildDataset({ variant, userId, nowMs }) {
  const random = createRandom(`${DATASET_VERSION}/${variant}`);
  const id = (...parts) => uuidFor(DATASET_VERSION, userId, ...parts);
  const today = strategyDay(nowMs);
  const todayStart = dayStart(today);
  const prices = pricePaths(random, addDays(today, -92), 93);
  const calls = [];
  const evidence = [];
  const marks = { closedPlanned: [], closedLive: [], reviewed: [], closedUnreviewed: [], dispositions: [], discarded: [] };
  let seq = 0;
  const call = (atMs, fn, ...args) => {
    if (!(atMs < nowMs)) throw new Error(`History step ${fn} at ${iso(atMs)} is not in the past`);
    calls.push({ at: atMs, seq: seq++, fn, args });
  };

  // ---- accounts --------------------------------------------------------------------------------------------
  const accounts = {};
  for (const def of ACCOUNT_DEFS) {
    const createdAt = at(addDays(today, -92), def.created);
    const startingText = moneyText(def.startingCents);
    const account = {
      ...def, id: id("account", def.key), requestKey: id("account-request", def.key), createdAt, startingText, instruments: {},
      riskVersions: [{ config: V1_0, createdAt, effectiveDay: strategyDay(createdAt) }], observedDays: new Set(),
    };
    const defaults = def.currency === "USD" ? { EURUSD: id("instrument", def.key, "EURUSD"), GBPUSD: id("instrument", def.key, "GBPUSD") } : {};
    for (const [symbol, instrumentId] of Object.entries(defaults)) account.instruments[symbol] = { id: instrumentId, symbol };
    call(createdAt, "seed_account", U(userId), U(account.id), U(account.requestKey), J({
      name: def.name, currency: def.currency, accountType: def.accountType, platform: def.platform, broker: def.broker,
      startingBalance: startingText, balance: startingText, equity: startingText,
    }), J(defaults), TS(createdAt));
    for (const [n, symbol] of def.symbols.filter(s => !defaults[s]).entries()) {
      const instrumentId = id("instrument", def.key, symbol);
      const addedAt = createdAt + (n + 1) * 2 * MIN;
      account.instruments[symbol] = { id: instrumentId, symbol };
      call(addedAt, "seed_instrument", U(account.id), U(instrumentId), J(contractInput(symbol)), TS(addedAt));
    }
    for (const [offset, minute, config, immediate, reason] of RISK_HISTORY[def.key]) {
      const changedAt = at(addDays(today, offset), minute);
      account.riskVersions.push({ config: { ...V1_0, ...config }, createdAt: changedAt, effectiveDay: addDays(strategyDay(changedAt), immediate ? 0 : 1) });
      call(changedAt, "seed_risk_version", U(account.id), J(config), B(immediate), T(reason), TS(changedAt));
    }
    accounts[def.key] = account;
  }

  // ---- shared step builders ----------------------------------------------------------------------------------
  const observe = (account, atMs) => {
    call(atMs, "seed_observation", U(account.id), N("0"), TS(atMs));
    account.observedDays.add(strategyDay(atMs));
  };
  const addEvidence = spec => {
    evidence.push(spec);
    if (spec.via === "SQL") call(spec.at, "seed_evidence", U(userId), EV(spec.id), TS(spec.at));
    return spec;
  };
  const evidenceSpec = (trade, account, key, { label, timeframe, atMs, via = "SQL", chartKind, exitTicks = null }) => {
    const r = random.fork(`evidence/${trade.id}/${key}`);
    const format = r.chance(0.12) ? "webp" : r.chance(0.08) ? "jpeg" : "png";
    const ext = format === "jpeg" ? "jpg" : format;
    const stamp = iso(atMs).slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    return {
      id: id("evidence", trade.id, key), tradeId: trade.id, accountKey: account.key, label, timeframe,
      caption: r.chance(0.8) ? r.pick(CAPTIONS[label] ?? CAPTIONS.PRE_ENTRY) : null,
      filename: r.pick([`${trade.symbol}_${timeframe}_${stamp}.${ext}`, `Screenshot ${stamp.replace("_", " ")}.${ext}`, `${trade.symbol.toLowerCase()}-${timeframe.toLowerCase()}-${key}.${ext}`]),
      format, at: atMs, via, captureMethod: r.pick(["PASTE", "PASTE", "DROP", "FILE"]),
      chart: {
        seed: `${trade.id}/${key}`, symbol: trade.symbol, timeframe, account: account.name, direction: trade.direction, kind: chartKind,
        scale: CONTRACTS[trade.contract ?? trade.symbol]?.scale ?? 2, entry: trade.entryTicks ?? null, stop: trade.stopTicks ?? null,
        target: trade.targetTicks ?? null, exit: exitTicks,
      },
    };
  };
  const journal = (trade, atMs, kind, body, details = {}) => {
    const entryId = id("journal", trade.id, atMs, kind);
    call(atMs, "seed_journal", U(trade.id), U(entryId), U(id("journal-request", entryId)), T(kind), T(body), J(details), TS(atMs));
    return entryId;
  };
  /** The 11-key proposal of a trade spec; prices are exact decimal strings at the contract's tick scale. */
  const proposalOf = (account, trade, overrides = {}) => ({
    instrumentId: account.instruments[trade.symbol].id, direction: trade.direction, model: trade.model,
    entry: unitsText(trade.entryTicks, trade.scale), stop: unitsText(trade.stopTicks, trade.scale), target: unitsText(trade.targetTicks, trade.scale),
    riskPercent: trade.riskPercent, narrative: trade.thesis, contractConfirmed: true, news: trade.news, contradiction: false, ...overrides,
  });
  /** Entry, stop and target (ticks) around the day's reference price, and the thesis that explains them. */
  const shapeTrade = (r, trade, day, rrHundredths = r.int(300, 420)) => {
    const c = CONTRACTS[trade.symbol];
    const dir = trade.direction === "LONG" ? 1 : -1;
    const distance = r.int(c.stop[0], c.stop[1]);
    trade.scale = c.scale;
    trade.entryTicks = (prices[trade.symbol].get(day) ?? c.base) + r.int(-Math.round(c.vol * 0.6), Math.round(c.vol * 0.6));
    trade.stopTicks = trade.entryTicks - dir * distance;
    trade.targetTicks = trade.entryTicks + dir * Math.ceil((distance * rrHundredths) / 100);
    trade.stopDistance = distance;
    const story = liquidityStory(trade.direction, r);
    trade.liquidity = story.sweep;
    trade.thesis = thesis({
      symbol: trade.symbol, direction: trade.direction, model: trade.model, entry: unitsText(trade.entryTicks, c.scale),
      stop: unitsText(trade.stopTicks, c.scale), target: unitsText(trade.targetTicks, c.scale), story, kz: trade.window === "LONDON" ? "LONDON" : "NY",
    });
    return trade;
  };
  /** Exit price (ticks) for an outcome card, relative to the actual entry. */
  const exitTicksFor = (r, trade, entryTicks) => {
    const dir = trade.direction === "LONG" ? 1 : -1;
    switch (trade.outcome) {
      case "WIN_TARGET": return trade.targetTicks;
      case "WIN_PARTIAL": return entryTicks + dir * Math.round((trade.targetTicks - entryTicks) * dir * (r.int(35, 80) / 100));
      case "LOSS": return trade.stopTicks;
      case "LOSS_SLIP": return trade.stopTicks - dir * r.int(2, 9);
      case "BREAKEVEN": return entryTicks;
      default: return entryTicks - dir * Math.max(1, Math.round(trade.stopDistance * (r.int(25, 60) / 100)));
    }
  };

  // ---- trade cards per account -------------------------------------------------------------------------------
  // A realistic retail profile: roughly 40% winners, about +0.3R to +0.4R per planned trade.
  const OUTCOMES = {
    ftmo: { WIN_TARGET: 6, WIN_PARTIAL: 4, LOSS: 14, LOSS_SLIP: 2, BREAKEVEN: 3, SCRATCH: 1 },
    personal: { WIN_TARGET: 3, WIN_PARTIAL: 2, LOSS: 7, LOSS_SLIP: 1, BREAKEVEN: 2 },
    demo: { WIN_TARGET: 3, WIN_PARTIAL: 2, LOSS: 8, BREAKEVEN: 1, SCRATCH: 1 },
  };
  const LIVE_FIRST = {
    ftmo: [["DERIVED", "EURUSD", "WIN"], ["RISK", "XAUUSD", "LOSS"], ["NOBASIS", "GBPUSD", "WIN"], ["UNKNOWN_TIME", "EURUSD", "LOSS"]],
    personal: [["DERIVED", "DE40", "WIN"], ["RISK", "FRA40", "LOSS"], ["SYMBOL_ONLY", "EURUSD", "LOSS"], ["SYMBOL_RISK", "US30", "WIN"], ["LATE_DETAILS", "DE40", "WIN"], ["NOBASIS", "DE40", "LOSS"]],
    demo: [["DERIVED", "GBPUSD", "LOSS"], ["NOBASIS", "EURUSD", "WIN"], ["SYMBOL_ONLY", "XAUUSD", "WIN"], ["RISK", "EURUSD", "LOSS"]],
  };
  const EXTRA = { ftmo: ["SKIPPED", "SKIPPED", "CANCELLED", "DISCARD", "DISCARD"], personal: ["SKIPPED", "DISCARD"], demo: ["CANCELLED", "DISCARD"] };
  const REVISE = { ftmo: ["MIN_RR", "RISK"], personal: ["CONTRACT"], demo: ["RISK"] };
  const OVERSIZE = { ftmo: ["1.5", "2"], personal: ["1.4"], demo: ["1.5"] };

  const weekdays = [];
  for (let i = 90; i >= 1; i--) { const day = addDays(today, -i); if (isWeekday(day)) weekdays.push(day); }
  const thisMonday = mondayOf(today);
  const lastWeek = weekdays.filter(day => day >= addDays(thisMonday, -7) && day < thisMonday);
  const weekBefore = weekdays.filter(day => day >= addDays(thisMonday, -14) && day < addDays(thisMonday, -7));

  for (const account of Object.values(accounts)) {
    const r = random.fork(`account/${account.key}`);
    const cards = [];
    for (const [outcome, count] of Object.entries(OUTCOMES[account.key])) for (let i = 0; i < count; i++) cards.push({ kind: "PLANNED", outcome });
    for (const [liveVariant, symbol, result] of LIVE_FIRST[account.key]) cards.push({ kind: "LIVE_FIRST", liveVariant, symbol, result });
    for (const kind of EXTRA[account.key]) cards.push({ kind });
    const shuffled = r.shuffle(cards);
    const planned = shuffled.filter(card => card.kind === "PLANNED");
    REVISE[account.key].forEach((kind, i) => { planned[(i * 5 + 2) % planned.length].revise = kind; });
    OVERSIZE[account.key].forEach((factor, i) => { planned[(i * 7 + 4) % planned.length].oversize = factor; });
    if (account.key === "ftmo") planned[1].backdated = true;

    // Days: FTMO gets trades in the last two completed weeks (weekly AI reviews); the rest spread at most two per day.
    const load = new Map();
    const assign = (card, day) => { card.day = day; if (card.kind !== "DISCARD") load.set(day, (load.get(day) ?? 0) + 1); };
    const queue = [...shuffled];
    if (account.key === "ftmo") {
      for (const [days, n] of [[lastWeek, 3], [weekBefore, 2]]) {
        for (const day of r.shuffle(days).slice(0, n)) assign(queue.splice(queue.findIndex(c => c.kind === "PLANNED" && !c.backdated), 1)[0], day);
      }
      assign(queue.splice(queue.findIndex(c => c.backdated), 1)[0], weekdays.at(-r.int(16, 20)));
    }
    for (const card of queue) {
      let chosen = null;
      for (let attempt = 0; attempt < 400 && chosen === null; attempt++) {
        const day = r.pick(weekdays);
        if (card.kind === "DISCARD" || (load.get(day) ?? 0) < (attempt < 200 ? 1 : 2)) chosen = day;
      }
      assign(card, chosen ?? weekdays[0]);
    }
    // The risk-plan story: the losses that triggered a change come right before it (outcomes are swapped, so the
    // totals above stay exact). Personal cut risk after three DE40 losses in a row; FTMO tightens today after two.
    const byDayDesc = (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0);
    const makeLoss = target => {
      if (!target.outcome.startsWith("LOSS")) {
        const donor = planned.find(c => c !== target && c.outcome === "LOSS" && !c.story);
        if (donor) { donor.outcome = target.outcome; target.outcome = "LOSS"; }
      }
      target.story = true;
    };
    if (account.key === "personal") {
      const changeDay = addDays(today, RISK_HISTORY.personal[0][0]);
      for (const card of planned.filter(c => c.day < changeDay && !c.revise && !c.oversize).sort(byDayDesc).slice(0, 3)) { makeLoss(card); card.symbol = "DE40"; }
    }
    if (account.key === "ftmo") for (const card of planned.filter(c => !c.backdated).sort(byDayDesc).slice(0, 2)) makeLoss(card);

    const byDay = new Map();
    for (const card of shuffled) byDay.set(card.day, [...(byDay.get(card.day) ?? []), card]);
    for (const day of [...byDay.keys()].sort()) {
      const dayCards = byDay.get(day);
      const ordered = [
        ...dayCards.filter(c => c.kind !== "LIVE_FIRST" && c.kind !== "DISCARD"),
        ...dayCards.filter(c => c.kind === "LIVE_FIRST"),
        ...dayCards.filter(c => c.kind === "DISCARD"),
      ];
      const windows = ["LONDON", "NY", "LATE", "LATE2", "LATE3"];
      const startMinute = { LONDON: r.int(128, 165), NY: r.int(440, 545), LATE: r.int(585, 610), LATE2: r.int(625, 640), LATE3: r.int(650, 665) };
      observe(account, at(day, startMinute.LONDON - r.int(18, 40)));
      if (account.key === "ftmo" && r.chance(0.3)) {
        const contextAt = at(day, startMinute.LONDON - 50);
        call(contextAt, "seed_daily_context", U(account.id), T(r.pick(DAILY_CONTEXTS)), TS(contextAt));
      }
      ordered.forEach((card, i) => {
        card.window = windows[i];
        card.start = at(day, startMinute[windows[i]]);
        if (card.kind === "LIVE_FIRST") buildLiveFirst(r.fork(`live/${day}/${i}`), account, card, day);
        else buildPlanned(r.fork(`planned/${day}/${i}`), account, card, day);
      });
    }
  }

  // ---- planned trade ----------------------------------------------------------------------------------------
  function buildPlanned(r, account, card, day) {
    const trade = {
      id: id("trade", account.key, day, card.window), account: account.key, outcome: card.outcome, symbol: card.symbol ?? r.pick(account.symbols),
      direction: r.chance(0.5) ? "LONG" : "SHORT", model: r.chance(0.62) ? "OB_FIRST_TOUCH" : "OTE", news: r.chance(0.85) ? "CLEAR" : "UNKNOWN",
      window: card.window,
    };
    const risk = riskAt(account, card.start);
    trade.riskPercent = account.key === "ftmo" && risk.maxRiskPercent === "1" && card.window === "LONDON" && r.chance(0.2) ? "0.75" : risk.defaultRiskPercent;
    const warnRR = account.key === "demo" && risk.rrPolicy === "WARN" && r.chance(0.25);
    shapeTrade(r, trade, day, warnRR ? r.int(215, 245) : undefined);
    const dir = trade.direction === "LONG" ? 1 : -1;
    let t = card.start;
    if (card.revise) {
      // Revision 1 carries a deliberate mistake the engine blocks; revision 2 corrects it.
      const mistake = card.revise === "MIN_RR" ? { target: unitsText(trade.entryTicks + dir * Math.round(trade.stopDistance * 2.2), trade.scale) }
        : card.revise === "RISK" ? { riskPercent: "1.5" } : { contractConfirmed: false };
      call(t, "seed_draft", U(account.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(account, trade, mistake)), TS(t), T("BLOCKED"));
      t += r.int(5, 12) * MIN;
      call(t, "seed_draft", U(account.id), U(trade.id), U(id("proposal", trade.id, 2)), U(id("revision-request", trade.id, 2)), J(proposalOf(account, trade)), TS(t), T("APPROVED"));
    } else {
      call(t, "seed_draft", U(account.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(account, trade)), TS(t),
        T(card.kind === "DISCARD" ? null : "APPROVED"));
    }
    if (r.chance(0.7)) addEvidence(evidenceSpec(trade, account, "htf", { label: "HTF", timeframe: r.pick(["H4", "DAILY", "H1"]), atMs: t + r.int(1, 3) * MIN, chartKind: "HTF" }));
    if (card.kind === "DISCARD") {
      const discardAt = t + r.int(12, 55) * MIN;
      call(discardAt, "seed_lifecycle", U(trade.id), T("DRAFT_DISCARDED"), T(r.pick(DISCARD_REASONS)), TS(discardAt));
      marks.discarded.push(trade.id);
      return;
    }
    if (r.chance(0.25)) { t += r.int(2, 6) * MIN; call(t, "seed_check", U(trade.id), TS(t), T("APPROVED")); }
    const lockAt = t + r.int(6, 22) * MIN;
    if (r.chance(0.6)) addEvidence(evidenceSpec(trade, account, "setup", { label: "PRE_ENTRY", timeframe: r.pick(["M5", "M15", "M5"]), atMs: lockAt - r.int(1, 3) * MIN, chartKind: "SETUP" }));
    call(lockAt, "seed_lock", U(trade.id), U(id("plan", trade.id)), TS(lockAt));
    if (card.kind === "SKIPPED" || card.kind === "CANCELLED") {
      if (r.chance(0.5)) journal(trade, lockAt + r.int(5, 30) * MIN, "DECISION", r.pick(PRE_ENTRY_NOTES));
      const disposeAt = lockAt + r.int(45, 170) * MIN;
      call(disposeAt, "seed_disposition", U(trade.id), T(card.kind), T(card.kind === "SKIPPED" ? r.pick(SKIP_REASONS) : r.pick(CANCEL_REASONS)), TS(disposeAt));
      marks.dispositions.push({ id: trade.id, status: card.kind });
      return;
    }
    // Entry. Back-dated case: a note is written after the real entry time but before the entry is logged, so it is
    // stored as PRE_ENTRY and later classified "While live · Recorded after execution began".
    const entryAt = lockAt + r.int(5, 40) * MIN;
    const entryRecordedAt = card.backdated ? entryAt + r.int(34, 42) * MIN : entryAt + r.int(40, 170) * 1000;
    if (entryAt - lockAt > 8 * MIN && r.chance(0.55)) journal(trade, lockAt + r.int(1, 4) * MIN, "DECISION", r.pick(PRE_ENTRY_NOTES));
    if (card.backdated) {
      journal(trade, entryAt + r.int(6, 12) * MIN, "DECISION", "Price is tapping the OB right now — waiting for the M3 close before deciding.");
      addEvidence(evidenceSpec(trade, account, "entry", { label: "ENTRY", timeframe: "M3", atMs: entryAt + r.int(13, 16) * MIN, chartKind: "ENTRY" }));
    }
    trade.actualEntryTicks = trade.entryTicks + (card.backdated ? 0 : r.int(-2, 2));
    call(entryRecordedAt, "seed_entry", U(trade.id), U(id("execution", trade.id)), T(unitsText(trade.actualEntryTicks, trade.scale)), T(null),
      N(card.oversize ?? "1"), TS(entryAt), TS(entryRecordedAt));
    if (!card.backdated && r.chance(0.2)) addEvidence(evidenceSpec(trade, account, "entry", { label: "ENTRY", timeframe: r.pick(["M3", "M5"]), atMs: entryRecordedAt + r.int(1, 3) * MIN, chartKind: "ENTRY" }));
    // The exit follows the logged entry: a back-dated entry is logged up to 42 minutes after its reported time, and
    // measuring from the reported time could put the close (and its logging) before the entry is logged.
    const exitAt = (card.backdated ? entryRecordedAt : entryAt) + r.int(28, 260) * MIN;
    const exitTicks = exitTicksFor(r, trade, trade.actualEntryTicks);
    const liveFrom = entryRecordedAt + 4 * MIN;
    const liveTo = exitAt - 3 * MIN;
    if (liveTo > liveFrom) {
      const notes = r.int(card.backdated ? 2 : 0, 3);
      for (let i = 0; i < notes; i++) {
        const noteAt = liveFrom + Math.round(((i + 1) / (notes + 1)) * (liveTo - liveFrom));
        const roll = r.next();
        if (roll < 0.18 && !trade.outcome.startsWith("LOSS")) {
          journal(trade, noteAt, "STOP_CHANGE", "Stop to break-even after the M5 break of structure.", { price: unitsText(trade.actualEntryTicks, trade.scale) });
        } else if (roll < 0.28 && trade.outcome === "WIN_TARGET") {
          journal(trade, noteAt, "PARTIAL_CLOSE", "Took half at 2R; the rest runs to the draw.", { percent: "50", price: unitsText(trade.actualEntryTicks + dir * trade.stopDistance * 2, trade.scale) });
        } else if (roll < 0.34) {
          journal(trade, noteAt, "TARGET_CHANGE", "Keeping the original target — no new information, just noting the urge to extend.", { price: unitsText(trade.targetTicks, trade.scale) });
        } else {
          journal(trade, noteAt, "NOTE", r.pick(LIVE_NOTES));
        }
      }
      if (r.chance(0.15)) addEvidence(evidenceSpec(trade, account, "manage", { label: "MANAGEMENT", timeframe: "M5", atMs: liveFrom + Math.round((liveTo - liveFrom) / 2), chartKind: "MANAGE" }));
    }
    const closeRecordedAt = exitAt + (r.chance(0.15) ? r.int(120, 300) : r.int(1, 9)) * MIN;
    const fee = trade.outcome === "BREAKEVEN" ? "0" : feeRate(CONTRACTS[trade.symbol].feeCents);
    call(closeRecordedAt, "seed_close", U(trade.id), U(id("outcome", trade.id)), T(unitsText(exitTicks, trade.scale)), TS(exitAt), T(null), N(fee), TS(closeRecordedAt));
    if (r.chance(0.45)) addEvidence(evidenceSpec(trade, account, "exit", { label: "EXIT", timeframe: r.pick(["M5", "M15"]), atMs: closeRecordedAt + r.int(2, 18) * MIN, chartKind: "EXIT", exitTicks }));
    finishClosed(r, trade, closeRecordedAt, LESSONS[trade.outcome] ?? LESSONS.SCRATCH);
    marks.closedPlanned.push({ id: trade.id, account: account.key, day, exitAt, oversize: Boolean(card.oversize), backdated: Boolean(card.backdated) });
  }

  // ---- live-first trade -------------------------------------------------------------------------------------
  function buildLiveFirst(r, account, card, day) {
    const symbolOnly = card.liveVariant === "SYMBOL_ONLY" || card.liveVariant === "SYMBOL_RISK";
    const instrument = symbolOnly ? null : account.instruments[card.symbol];
    const c = CONTRACTS[card.symbol] ?? null;
    const trade = {
      id: id("trade", account.key, day, card.window), account: account.key, symbol: card.symbol, contract: c ? card.symbol : null,
      direction: r.chance(0.5) ? "LONG" : "SHORT", model: r.pick(["OB_FIRST_TOUCH", "OTE", "OTHER"]), window: card.window,
    };
    const dir = trade.direction === "LONG" ? 1 : -1;
    const createdAt = card.start + r.int(5, 25) * MIN;
    const input = { direction: trade.direction, entryModel: trade.model, ...(instrument ? { instrumentId: instrument.id } : { symbol: card.symbol }) };
    if (c) {
      trade.scale = c.scale;
      trade.entryTicks = (prices[card.symbol].get(day) ?? c.base) + r.int(-Math.round(c.vol * 0.5), Math.round(c.vol * 0.5));
      input.entryPrice = unitsText(trade.entryTicks, c.scale);
      trade.stopDistance = r.int(c.stop[0], c.stop[1]);
    }
    if (card.liveVariant !== "UNKNOWN_TIME") input.enteredAt = iso(createdAt - r.int(2, 22) * MIN);
    let quantityUnits = null;
    const quantityScale = c ? scaleOf(c.quantityStep) : 2;
    if (instrument) {
      // About 0.4% of the starting balance at the stop, rounded to the contract step.
      const riskCents = Math.round((account.startingCents * 4) / 1000);
      quantityUnits = Math.max(1, Math.round((riskCents * 10 ** quantityScale) / (trade.stopDistance * c.tickCents)));
      trade.stopTicks = trade.entryTicks - dir * trade.stopDistance;
      if (card.liveVariant !== "LATE_DETAILS") input.quantity = unitsText(quantityUnits, quantityScale);
      if (card.liveVariant === "DERIVED" || card.liveVariant === "UNKNOWN_TIME") input.initialStop = unitsText(trade.stopTicks, c.scale);
      if (card.liveVariant === "RISK") input.riskAmount = moneyText(riskCents);
    }
    if (card.liveVariant === "SYMBOL_RISK") input.riskAmount = moneyText(r.int(40, 70) * 100);
    call(createdAt, "seed_live", U(account.id), U(trade.id), U(id("facts", trade.id, 1)), U(id("live-request", trade.id)), J(input), TS(createdAt));
    if (c && r.chance(0.6)) addEvidence(evidenceSpec(trade, account, "manage", { label: "MANAGEMENT", timeframe: "M5", atMs: createdAt + r.int(1, 3) * MIN, chartKind: "MANAGE" }));
    if (card.liveVariant === "LATE_DETAILS") {
      const detailsAt = createdAt + r.int(4, 15) * MIN;
      call(detailsAt, "seed_complete_entry", U(trade.id), U(id("facts", trade.id, 2)), U(id("facts-request", trade.id, 2)),
        J({ quantity: unitsText(quantityUnits, quantityScale), initialStop: unitsText(trade.stopTicks, c.scale) }), TS(detailsAt));
    }
    const exitAt = createdAt + r.int(18, 200) * MIN;
    const notes = r.int(1, 2);
    for (let i = 0; i < notes; i++) journal(trade, createdAt + Math.round(((i + 1) / (notes + 1)) * (exitAt - createdAt)), "NOTE", r.pick(LIVE_NOTES));
    const closeAt = exitAt + r.int(1, 25) * MIN;
    const close = { exitedAt: iso(exitAt) };
    let exitTicks = null;
    if (c) {
      exitTicks = card.result === "WIN"
        ? trade.entryTicks + dir * Math.round(trade.stopDistance * (r.int(120, 320) / 100))
        : trade.entryTicks - dir * Math.round(trade.stopDistance * (r.int(60, 105) / 100));
      close.exitPrice = unitsText(exitTicks, c.scale);
    }
    if (instrument) {
      close.fees = moneyText(Math.round((quantityUnits * c.feeCents) / 10 ** quantityScale));
    } else {
      close.netPnl = card.result === "WIN" ? moneyText(r.int(5_000, 21_000)) : moneyText(-r.int(2_500, 9_000));
    }
    call(closeAt, "seed_close_live", U(trade.id), J(close), TS(closeAt));
    if (c && r.chance(0.35)) addEvidence(evidenceSpec(trade, account, "exit", { label: "EXIT", timeframe: "M5", atMs: closeAt + r.int(2, 15) * MIN, chartKind: "EXIT", exitTicks }));
    finishClosed(r, trade, closeAt, LESSONS.LIVE_FIRST);
    marks.closedLive.push({ id: trade.id, account: account.key, day, exitAt, variant: card.liveVariant });
  }

  /** Lesson, tags and (for trades closed before today) the trader's review completion. */
  function finishClosed(r, trade, closedAt, lessons) {
    const reviewAt = closedAt + r.int(5, 28) * 60 * MIN;
    const reviewable = reviewAt < todayStart - 30 * MIN;
    const lessonAt = reviewable && r.chance(0.6) ? reviewAt - r.int(2, 6) * MIN : closedAt + r.int(10, 80) * MIN;
    if (r.chance(0.7) && lessonAt < nowMs - 10 * MIN) journal(trade, lessonAt, "LESSON", r.pick(lessons));
    const tagsAt = reviewable ? reviewAt - MIN : closedAt + r.int(15, 90) * MIN;
    if (r.chance(0.8) && tagsAt < nowMs - 10 * MIN) {
      const tags = r.shuffle(["london", "new-york", "sweep", "fvg", "patience", "a-setup", "late-entry", "news-week", "htf-aligned", "moved-stop"]).slice(0, r.int(1, 3));
      call(tagsAt, "seed_tags", U(trade.id), T(r.pick(["A+", "A", "B", "B", "C"])), T(trade.liquidity ?? r.pick(["ARL_LOW", "ARL_HIGH", "PDH", "PDL", "OTHER"])),
        T(r.pick(["M5", "M5", "M3", "M15"])), A(tags), TS(tagsAt));
    }
    if (reviewable && r.chance(0.72)) {
      call(reviewAt, "seed_lifecycle", U(trade.id), T("REVIEW_COMPLETED"), T(null), TS(reviewAt));
      marks.reviewed.push(trade.id);
    } else {
      marks.closedUnreviewed.push(trade.id);
    }
  }

  // ---- drafts that age into today: an approval that is stale today (Personal), an old draft discarded now (Demo) --
  {
    // Saved at 01:20 UTC−5 before any lock of that day (so no slot or loss limit is in use), approved then; stale today.
    const account = accounts.personal;
    const day = weekdays.at(-1);
    const start = at(day, 80);
    observe(account, start - 8 * MIN);
    const trade = { id: id("trade", "personal", "stale-draft"), symbol: "DE40", direction: "SHORT", model: "OB_FIRST_TOUCH", news: "CLEAR", window: "LATE" };
    trade.riskPercent = riskAt(account, start).defaultRiskPercent;
    shapeTrade(random.fork("stale-draft"), trade, day);
    call(start, "seed_draft", U(account.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(account, trade)), TS(start), T("APPROVED"));
    addEvidence(evidenceSpec(trade, account, "setup", { label: "PRE_ENTRY", timeframe: "M15", atMs: start + 3 * MIN, chartKind: "SETUP" }));
    marks.staleDraft = trade.id;
  }
  {
    const account = accounts.demo;
    const start = at(weekdays.at(-3), 1_000); // 16:40 UTC−5: saved during Dead Pool, so its free check is blocked
    const trade = { id: id("trade", "demo", "old-draft"), symbol: "GBPUSD", direction: "LONG", model: "OTE", news: "UNKNOWN", window: "NY" };
    trade.riskPercent = riskAt(account, start).defaultRiskPercent;
    shapeTrade(random.fork("old-draft"), trade, weekdays.at(-3));
    call(start, "seed_draft", U(account.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(account, trade)), TS(start), T("BLOCKED"));
    marks.oldDraft = trade.id;
  }

  // ---- external losses (one removed as a typo) ----------------------------------------------------------------
  {
    const day = weekdays.at(-15);
    call(at(day, 700), "seed_external_loss", U(accounts.demo.id), U(id("external-loss", "demo", day)), T("120.00"), T("Manual scalp on another platform, not recorded in Trading OS."), TS(at(day, 700)));
    const typo = id("external-loss", "demo", day, "typo");
    call(at(day, 705), "seed_external_loss", U(accounts.demo.id), U(typo), T("1200.00"), T("Manual scalp on another platform."), TS(at(day, 705)));
    call(at(day, 708), "seed_external_loss_removal", U(typo), T("Entered 1200.00 instead of 120.00."), TS(at(day, 708)));
    const personalDay = weekdays.at(-9);
    call(at(personalDay, 720), "seed_external_loss", U(accounts.personal.id), U(id("external-loss", "personal", personalDay)), T("35.50"),
      T("Spread bet on another broker."), TS(at(personalDay, 720)));
  }

  const plan = planToday({ random: random.fork("today"), id, accounts, today, todayStart, nowMs, call, observe, addEvidence, evidenceSpec, journal, proposalOf, shapeTrade });

  calls.sort((a, b) => a.at - b.at || a.seq - b.seq);
  // The history runs in one transaction per user: one out-of-order step would roll back all of it, after the login
  // was created and the screenshots uploaded. Refuse such a dataset before anything is written.
  const problems = chronologyIssues(calls, evidence);
  if (problems.length) {
    throw new Error(`Dataset ${variant} for ${today} is not chronological (${problems.length} problem(s)): ${problems.slice(0, 3).join("; ")}`);
  }
  const latest = (list, predicate) => [...list].reverse().find(predicate) ?? null;
  marks.timelineReviewPlanned = latest(marks.closedPlanned, row => row.backdated)?.id ?? null;
  marks.timelineReviewLive = latest(marks.closedLive, row => row.account === "personal" && (row.variant === "DERIVED" || row.variant === "LATE_DETAILS"))?.id ?? null;
  marks.hindsightTrade = latest(marks.closedPlanned, row => row.account === "ftmo" && !row.backdated)?.id ?? null;
  marks.duplicateSource = latest(marks.closedPlanned, row => row.account === "demo")?.id ?? null;
  marks.weeks = { lastWeek: addDays(thisMonday, -7), weekBefore: addDays(thisMonday, -14) };
  return { version: DATASET_VERSION, variant, nowMs, day: today, todayStart, accounts, history: calls, evidence, plan, marks };
}

/**
 * What each showcase trade shows, by name, in showcase order, for a dataset whose plan was built with `deadPool`.
 * During Dead Pool (12:00–18:00 UTC−5) locks are refused, so today's waiting plan is locked this morning (history,
 * before any analysis could run on it) and the completed Analyze Setup belongs to the ready draft, which then needs a
 * recheck. seed-v2.mjs prints these and saves them with each user's showcase ids.
 */
export function showcaseDescriptions({ deadPool }) {
  return Object.freeze({
    todayClosed: "planned trade closed today (FTMO EURUSD, exit logged now, tags, lesson)",
    todayWaiting: deadPool
      ? "locked plan waiting for entry (FTMO XAUUSD, locked this morning, no AI analysis)"
      : "locked plan waiting for entry (FTMO XAUUSD, Analyze Setup completed)",
    todayReady: deadPool
      ? "draft with two screenshots, Analyze Setup and Challenge My Bias; Recheck needed (drafted this morning)"
      : "draft with two screenshots and Challenge My Bias; Ready to lock",
    todayBlocked: "blocked draft, revision 2 (risk above the new maximum), stale analysis of revision 1, failed analysis of revision 2",
    todayPlannedLive: "live planned trade (Demo GBPUSD; partial close, stop change now)",
    todayLiveFirst: "live-first trade recorded now (Personal DE40, new contract version)",
    todayLiveFirstClosed: "live-first trade entered and closed earlier today, logged now (Demo EURUSD)",
    todayDuplicate: "draft duplicated from a closed trade, blocked by the daily trade limit, copied pre-entry screenshots",
    staleDraft: "draft approved on the previous weekday (Recheck needed)",
    discardedDraft: "draft discarded now (its free check was blocked by Dead Pool)",
    backdatedEntry: "closed planned trade with a note recorded after a later-reported earlier entry time; timeline AI review",
    liveFirstReviewed: "closed live-first trade with a completed timeline AI review",
    hindsightRejected: "closed planned trade whose timeline AI review was rejected by the hindsight guard",
    skippedPlan: "locked plan skipped before entry",
    cancelledPlan: "locked plan cancelled before entry",
    oversizedFill: "closed planned trade filled above the planned size",
    liveFirstWithoutRisk: "closed live-first trade without a risk basis (R not available)",
    reopenedReview: "review completed earlier and reopened now",
    evidenceRelabelled: "trade with a relabelled screenshot",
    evidenceRemoved: "trade with a removed screenshot (timeline shows the removal)",
  });
}

/**
 * History trades that show one state or feature each, by showcase name; null when a dataset has none. seed-v2.mjs adds
 * the trades it creates now (showcaseDescriptions names them all) and saves the whole set with the user, so
 * screenshot.mjs can resolve `@name` paths (e.g. `@backdatedEntry` -> /trades/<id>).
 */
export function historyShowcase(marks) {
  const latest = (list, predicate) => [...list].reverse().find(predicate) ?? null;
  return {
    staleDraft: marks.staleDraft ?? null,
    discardedDraft: marks.oldDraft ?? null,
    backdatedEntry: marks.timelineReviewPlanned,
    liveFirstReviewed: marks.timelineReviewLive,
    hindsightRejected: marks.hindsightTrade,
    skippedPlan: latest(marks.dispositions, row => row.status === "SKIPPED")?.id ?? null,
    cancelledPlan: latest(marks.dispositions, row => row.status === "CANCELLED")?.id ?? null,
    oversizedFill: latest(marks.closedPlanned, row => row.oversize)?.id ?? null,
    liveFirstWithoutRisk: latest(marks.closedLive, row => row.variant === "NOBASIS" || row.variant === "SYMBOL_ONLY")?.id ?? null,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Today. Past events of the strategy day go to SQL (history); everything "now" is an RPC step. Natural times are
// minutes after 00:00 UTC−5, compressed into the elapsed part of the day when the seed runs early in the morning.
// -----------------------------------------------------------------------------------------------------------------
function planToday({ random: r, id, accounts, today, todayStart, nowMs, call, observe, addEvidence, evidenceSpec, journal, proposalOf, shapeTrade }) {
  const elapsed = nowMs - todayStart;
  if (elapsed < 3 * MIN) throw new Error("The strategy day (UTC−5) started less than three minutes ago. Retry in a few minutes.");
  const deadPool = session(nowMs) === "DEAD_POOL";
  const latestNatural = deadPool ? 700 : 470;
  const available = (elapsed - 2 * MIN) / MIN;
  const factor = latestNatural <= available ? 1 : available / latestNatural;
  const t = minute => todayStart + Math.round(Math.max(0.25, minute * factor) * MIN);
  const { ftmo, demo, personal } = accounts;
  const plan = { deadPool, compressed: factor < 1 };

  // Morning account values ("Balance confirmed today").
  observe(ftmo, t(95));
  observe(demo, t(100));
  observe(personal, t(105));

  // FTMO: planned trade closed today. Draft, lock and fill are past (SQL); the close is logged now (RPC).
  {
    const trade = { id: id("trade", "ftmo", today, "closed"), symbol: "EURUSD", direction: "LONG", model: "OB_FIRST_TOUCH", news: "CLEAR", window: "LONDON", riskPercent: "0.5" };
    shapeTrade(r, trade, today, 310);
    call(t(140), "seed_draft", U(ftmo.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(ftmo, trade)), TS(t(140)), T("APPROVED"));
    addEvidence(evidenceSpec(trade, ftmo, "htf", { label: "HTF", timeframe: "H4", atMs: t(142), chartKind: "HTF" }));
    addEvidence(evidenceSpec(trade, ftmo, "setup", { label: "PRE_ENTRY", timeframe: "M5", atMs: t(158), chartKind: "SETUP" }));
    call(t(161), "seed_lock", U(trade.id), U(id("plan", trade.id)), TS(t(161)));
    call(t(187), "seed_entry", U(trade.id), U(id("execution", trade.id)), T(unitsText(trade.entryTicks, trade.scale)), T(null), N("1"), TS(t(185)), TS(t(187)));
    journal(trade, t(212), "NOTE", "Clean displacement away from the OB. Holding to the PDH.");
    journal(trade, t(250), "STOP_CHANGE", "Stop to break-even after the M5 break of structure.", { price: unitsText(trade.entryTicks, trade.scale) });
    plan.ftmoClosed = {
      tradeId: trade.id, exit: unitsText(trade.targetTicks, trade.scale), exitedAt: iso(t(350)), feeCentsPerLot: CONTRACTS.EURUSD.feeCents,
      lesson: "Textbook London session: sweep of the Asian low, MSS, first touch, target at the PDH. No interference.",
      tags: { grade: "A+", liquidity: "ARL_LOW", mss: "M5", tags: ["london", "sweep", "a-setup"] },
      evidence: addEvidence(evidenceSpec(trade, ftmo, "exit-today", { label: "EXIT", timeframe: "M5", atMs: nowMs, via: "RPC", chartKind: "EXIT", exitTicks: trade.targetTicks })),
    };
  }

  // Demo: planned trade locked and filled this morning, still live.
  {
    const trade = { id: id("trade", "demo", today, "live"), symbol: "GBPUSD", direction: "SHORT", model: "OTE", news: "CLEAR", window: "LONDON", riskPercent: "1" };
    shapeTrade(r, trade, today, 340);
    call(t(125), "seed_draft", U(demo.id), U(trade.id), U(id("proposal", trade.id, 1)), U(id("trade-request", trade.id)), J(proposalOf(demo, trade)), TS(t(125)), T("APPROVED"));
    addEvidence(evidenceSpec(trade, demo, "setup", { label: "PRE_ENTRY", timeframe: "M15", atMs: t(131), chartKind: "SETUP" }));
    call(t(148), "seed_lock", U(trade.id), U(id("plan", trade.id)), TS(t(148)));
    call(t(177), "seed_entry", U(trade.id), U(id("execution", trade.id)), T(unitsText(trade.entryTicks, trade.scale)), T(null), N("1"), TS(t(175)), TS(t(177)));
    journal(trade, t(200), "NOTE", "Filled in the OTE. The H1 FVG overhead is the main risk.");
    journal(trade, t(245), "PARTIAL_CLOSE", "Took 30% off into the first imbalance.", { percent: "30", price: unitsText(trade.entryTicks - trade.stopDistance, trade.scale) });
    plan.demoLive = {
      tradeId: trade.id, note: "Stop to break-even — the London low is holding.", stop: unitsText(trade.entryTicks, trade.scale),
      evidence: addEvidence(evidenceSpec(trade, demo, "manage-today", { label: "MANAGEMENT", timeframe: "M5", atMs: nowMs, via: "RPC", chartKind: "MANAGE" })),
    };
  }

  // FTMO waiting plan and ready-to-lock draft. Locks are refused during Dead Pool (12:00–18:00 UTC−5), so then both come
  // from this morning (SQL) and the draft shows as "Recheck needed"; otherwise both are created now through the RPCs.
  const waiting = { id: id("trade", "ftmo", today, "waiting"), symbol: "XAUUSD", direction: "SHORT", model: "OB_FIRST_TOUCH", news: "CLEAR", window: "NY", riskPercent: "0.5" };
  shapeTrade(r, waiting, today, 330);
  const ready = { id: id("trade", "ftmo", today, "ready"), symbol: "EURUSD", direction: "SHORT", model: "OTE", news: "CLEAR", window: "NY", riskPercent: "0.5" };
  shapeTrade(r, ready, today, 360);
  const via = deadPool ? "SQL" : "RPC";
  plan.waiting = {
    tradeId: waiting.id, planId: id("plan", waiting.id), proposalId: id("proposal", waiting.id, 1), requestKey: id("trade-request", waiting.id),
    proposal: proposalOf(ftmo, waiting), viaSql: deadPool,
    evidence: [evidenceSpec(waiting, ftmo, "setup", { label: "PRE_ENTRY", timeframe: "M15", atMs: deadPool ? t(632) : nowMs, via, chartKind: "SETUP" })],
  };
  plan.ready = {
    tradeId: ready.id, proposalId: id("proposal", ready.id, 1), requestKey: id("trade-request", ready.id), proposal: proposalOf(ftmo, ready), viaSql: deadPool,
    evidence: [
      evidenceSpec(ready, ftmo, "htf", { label: "HTF", timeframe: "H1", atMs: deadPool ? t(682) : nowMs, via, chartKind: "HTF" }),
      evidenceSpec(ready, ftmo, "setup", { label: "PRE_ENTRY", timeframe: "M5", atMs: deadPool ? t(684) : nowMs, via, chartKind: "SETUP" }),
    ],
  };
  if (deadPool) {
    call(t(630), "seed_draft", U(ftmo.id), U(waiting.id), U(plan.waiting.proposalId), U(plan.waiting.requestKey), J(plan.waiting.proposal), TS(t(630)), T("APPROVED"));
    call(t(652), "seed_lock", U(waiting.id), U(plan.waiting.planId), TS(t(652)));
    call(t(680), "seed_draft", U(ftmo.id), U(ready.id), U(plan.ready.proposalId), U(plan.ready.requestKey), J(plan.ready.proposal), TS(t(680)), T("APPROVED"));
  }
  for (const spec of [...plan.waiting.evidence, ...plan.ready.evidence]) addEvidence(spec);

  // FTMO: a draft blocked by the immediate risk change (requested risk above the new maximum), revised once.
  const blocked = { id: id("trade", "ftmo", today, "blocked"), symbol: "GBPUSD", direction: "LONG", model: "OB_FIRST_TOUCH", news: "UNKNOWN", window: "NY", riskPercent: "1.5" };
  shapeTrade(r, blocked, today, 310);
  plan.blocked = {
    tradeId: blocked.id, requestKey: id("trade-request", blocked.id), proposal: proposalOf(ftmo, blocked),
    revision: { requestKey: id("revision-request", blocked.id, 2), proposal: proposalOf(ftmo, blocked, { riskPercent: "1.25", narrative: `${blocked.thesis} Revised: smaller size.` }) },
  };

  // FTMO risk policy: an immediate tightening now (Risk Plan V1.2), then a loosening scheduled for tomorrow (V1.3).
  plan.riskChanges = [
    { config: { maxRiskPercent: "0.75", defaultRiskPercent: "0.5", maxDailyTrades: 3, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "BLOCK", dailyRiskCap: "2000.00", dailyLossCap: "4000.00" },
      immediate: true, reason: "Two full losses in a row — tighten the maximum risk until the weekly review." },
    { config: { maxRiskPercent: "1", defaultRiskPercent: "0.75", maxDailyTrades: 3, minRR: "3", rrPolicy: "BLOCK", newsPolicy: "BLOCK", dailyRiskCap: "2500.00", dailyLossCap: "5000.00" },
      immediate: false, reason: null },
  ];
  plan.dailyContext = "London swept the Asian low; bias long into NY. High-impact USD data at 08:30 — no new orders 08:15–08:45.";

  // Personal: new contract versions now (DE40 with 0.01-lot steps, EU50); a live-first DE40 trade on the new version.
  plan.instruments = [
    { account: "personal", input: contractInput("DE40", { quantityStep: "0.01", minimumQuantity: "0.01" }) },
    { account: "personal", input: contractInput("EU50") },
  ];
  plan.profileUpdate = { account: "personal", input: { broker: "IC Markets" } };
  const de40Entry = 234_000 + r.int(-900, 900);
  const personalTrade = { id: null, symbol: "DE40", direction: "LONG", entryTicks: de40Entry, stopTicks: de40Entry - 280, targetTicks: null, contract: "DE40" };
  plan.personalLive = {
    requestKey: id("live-request", "personal", today),
    input: { direction: "LONG", entryModel: "OB_FIRST_TOUCH", entryPrice: unitsText(de40Entry, 1), enteredAt: iso(Math.max(todayStart + MIN, nowMs - 38 * MIN)),
      quantity: "1.85", initialStop: unitsText(de40Entry - 280, 1) },
    notes: [
      ["NOTE", "Entered from the chart before planning — London reclaimed the Asian range. Recording it now.", {}],
      ["STOP_CHANGE", "Stop tucked under the M5 swing low.", { price: unitsText(de40Entry - 220, 1) }],
    ],
    evidence: addEvidence(evidenceSpec({ ...personalTrade, id: id("trade-key", "personal", today, "live") }, personal, "manage-today", { label: "MANAGEMENT", timeframe: "M5", atMs: nowMs, via: "RPC", chartKind: "MANAGE" })),
  };

  // Demo: a live-first EURUSD trade entered and exited earlier today and logged now; an external loss.
  const eurEntry = 115_800 + r.int(-300, 300);
  plan.demoClosed = {
    requestKey: id("live-request", "demo", today),
    input: { instrumentId: demo.instruments.EURUSD.id, direction: "SHORT", entryModel: "OTHER", entryPrice: unitsText(eurEntry, 5), enteredAt: iso(t(430)),
      quantity: "2.50", initialStop: unitsText(eurEntry + 150, 5) },
    close: { exitPrice: unitsText(eurEntry + 112, 5), exitedAt: iso(t(468)), fees: "15.00" },
    lesson: "Chased the NY open without a plan. The loss is small, but it used a trade slot I had not planned for.",
  };
  plan.externalLoss = { account: "demo", amount: "85.00", note: "Manual MT4 scalp from this morning, not recorded in Trading OS." };
  return plan;
}
