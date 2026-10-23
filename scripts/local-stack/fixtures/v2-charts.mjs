// Synthetic 1280×720 trading-chart screenshots for scripts/local-stack/seed-v2.mjs (SYNTHETIC data only).
// A dark candlestick chart drawn as SVG and rasterised with the repository's sharp: candles shaped by the setup kind
// (higher-timeframe context, sweep + market-structure shift, entry, management, exit), the plan's entry/stop/target
// lines, order block / FVG zones and labels. Each image is deterministic for its seed and is stamped
// "Synthetic chart" so it can never be mistaken for a real platform screenshot.

import { createRandom, unitsText } from "./v2-dataset.mjs";

export const CHART_WIDTH = 1280;
export const CHART_HEIGHT = 720;
const PLOT = { left: 24, right: 1176, top: 64, bottom: 652 };
const COLORS = {
  background: "#131722", grid: "#1f2433", text: "#d1d4dc", muted: "#787b86", up: "#26a69a", down: "#ef5350",
  entry: "#2962ff", stop: "#ef5350", target: "#26a69a", exit: "#ff9800", zone: "#2962ff", fvg: "#b2b5be",
};
const FONT = "Segoe UI, Arial, Helvetica, sans-serif";
const MINUTES = { DAILY: 1440, H4: 240, H1: 60, M30: 30, M15: 15, M5: 5, M3: 3, OTHER: 15 };

const escapeXml = text => String(text).replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]);

/** Key points (x fraction, price in stop distances from entry; positive = in the trade's favour) per chart kind. */
function skeleton(kind, hasTarget) {
  switch (kind) {
    case "HTF": return [[0, -1.8], [0.18, -0.6], [0.3, -1.1], [0.5, 0.4], [0.62, -0.2], [0.8, 1.6], [0.9, 0.9], [1, hasTarget ? 2.2 : 1.5]];
    case "SETUP": return [[0, 0.9], [0.12, 0.5], [0.22, 0.95], [0.34, 0.45], [0.44, -0.75], [0.52, 0.3], [0.62, 1.6], [0.74, 1.1], [0.88, 0.05], [1, 0.35]];
    case "ENTRY": return [[0, 1.4], [0.2, 0.9], [0.35, 1.2], [0.55, 0.45], [0.72, 0.02], [0.82, 0.55], [1, 0.9]];
    case "MANAGE": return [[0, 0.6], [0.25, 0.05], [0.35, 0.2], [0.55, 0.9], [0.68, 0.6], [0.86, 1.5], [1, 1.3]];
    default: return [[0, 0.7], [0.18, 0.15], [0.3, 0], [0.5, 0.8], [0.62, 0.45], [0.8, 1.4], [1, 1.4]];
  }
}

/** Candles (open, high, low, close in ticks) following the skeleton with deterministic noise. */
function candles(spec, count) {
  const r = createRandom(`chart/${spec.seed}`);
  const dir = spec.direction === "SHORT" ? -1 : 1;
  const unit = spec.stop !== null && spec.entry !== null ? Math.abs(spec.entry - spec.stop) : Math.max(50, Math.round(spec.entry * 0.0015));
  const points = skeleton(spec.kind, spec.target !== null);
  const exitPoint = spec.exit !== null && spec.entry !== null ? (spec.exit - spec.entry) * dir / unit : null;
  if (spec.kind === "EXIT" && exitPoint !== null) { points[points.length - 2][1] = exitPoint; points[points.length - 1][1] = exitPoint + (r.next() - 0.5) * 0.2; }
  const level = x => {
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        const k = (x - x0) / (x1 - x0);
        return y0 + (y1 - y0) * (k * k * (3 - 2 * k));
      }
    }
    return points.at(-1)[1];
  };
  const out = [];
  let close = spec.entry + dir * Math.round(level(0) * unit);
  for (let i = 0; i < count; i++) {
    const x = (i + 1) / count;
    const goal = spec.entry + dir * Math.round(level(x) * unit);
    const open = close;
    close = Math.round(goal + (r.next() - 0.5) * unit * 0.35);
    const body = Math.abs(close - open);
    const high = Math.max(open, close) + Math.round(r.next() * (unit * 0.18 + body * 0.3));
    const low = Math.min(open, close) - Math.round(r.next() * (unit * 0.18 + body * 0.3));
    out.push({ open, high, low, close });
  }
  return { list: out, unit, dir };
}

/** SVG markup of one chart. */
export function chartSvg(spec, { width = CHART_WIDTH, height = CHART_HEIGHT } = {}) {
  const count = 78;
  const { list, unit, dir } = candles(spec, count);
  const levels = [spec.entry, spec.stop, spec.target, spec.exit].filter(v => v !== null);
  let lo = Math.min(...list.map(c => c.low), ...levels), hi = Math.max(...list.map(c => c.high), ...levels);
  const pad = Math.max(1, Math.round((hi - lo) * 0.08));
  lo -= pad; hi += pad;
  const y = ticks => PLOT.top + ((hi - ticks) / (hi - lo)) * (PLOT.bottom - PLOT.top);
  const step = (PLOT.right - PLOT.left) / count;
  const bodyWidth = Math.max(3, step * 0.62);
  const price = ticks => unitsText(Math.max(1, Math.round(ticks)), spec.scale);
  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="${COLORS.background}"/>`);
  // Watermark, grid and price axis.
  parts.push(`<text x="${(PLOT.left + PLOT.right) / 2}" y="${(PLOT.top + PLOT.bottom) / 2 + 28}" font-family="${FONT}" font-size="96" font-weight="700" fill="#1c2130" text-anchor="middle">${escapeXml(spec.symbol)} ${escapeXml(spec.timeframe)}</text>`);
  for (let i = 0; i <= 8; i++) {
    const gy = PLOT.top + (i / 8) * (PLOT.bottom - PLOT.top);
    parts.push(`<line x1="${PLOT.left}" y1="${gy.toFixed(1)}" x2="${PLOT.right}" y2="${gy.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${PLOT.right + 10}" y="${(gy + 4).toFixed(1)}" font-family="${FONT}" font-size="12" fill="${COLORS.muted}">${price(hi - (i / 8) * (hi - lo))}</text>`);
  }
  const minutes = MINUTES[spec.timeframe] ?? 15;
  for (let i = 0; i <= count; i += 13) {
    const gx = PLOT.left + i * step;
    parts.push(`<line x1="${gx.toFixed(1)}" y1="${PLOT.top}" x2="${gx.toFixed(1)}" y2="${PLOT.bottom}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    const offset = (i - count) * minutes;
    const label = minutes >= 1440 ? `${Math.round(offset / 1440)}d` : minutes >= 60 ? `${Math.round(offset / 60)}h` : `${offset}m`;
    parts.push(`<text x="${gx.toFixed(1)}" y="${PLOT.bottom + 20}" font-family="${FONT}" font-size="12" fill="${COLORS.muted}" text-anchor="middle">${i === count ? "now" : label}</text>`);
  }
  // Zones: order block / FVG around the entry, sweep marker at the extreme against the trade.
  if (spec.entry !== null && (spec.kind === "SETUP" || spec.kind === "ENTRY" || spec.kind === "HTF")) {
    // The block's proximal edge is the entry; it extends toward the stop.
    const far = spec.entry - dir * Math.round(unit * 0.35);
    const zoneTop = y(Math.max(spec.entry, far)), zoneBottom = y(Math.min(spec.entry, far));
    const x0 = PLOT.left + count * (spec.kind === "SETUP" ? 0.5 : 0.25) * step;
    parts.push(`<rect x="${x0.toFixed(1)}" y="${zoneTop.toFixed(1)}" width="${(PLOT.right - x0).toFixed(1)}" height="${Math.max(6, zoneBottom - zoneTop).toFixed(1)}" fill="${COLORS.zone}" fill-opacity="0.14" stroke="${COLORS.zone}" stroke-opacity="0.5"/>`);
    parts.push(`<text x="${(x0 + 8).toFixed(1)}" y="${(dir === 1 ? zoneBottom + 16 : zoneTop - 6).toFixed(1)}" font-family="${FONT}" font-size="13" fill="${COLORS.entry}">${spec.kind === "HTF" ? "H4 FVG" : spec.direction === "SHORT" ? "Bearish OB" : "Bullish OB"}</text>`);
    const fvgMid = spec.entry + dir * Math.round(unit * 0.95);
    const fx = PLOT.left + count * 0.6 * step;
    parts.push(`<rect x="${fx.toFixed(1)}" y="${(y(fvgMid + Math.round(unit * 0.15)) ).toFixed(1)}" width="${(step * 9).toFixed(1)}" height="${Math.max(4, y(fvgMid - Math.round(unit * 0.15)) - y(fvgMid + Math.round(unit * 0.15))).toFixed(1)}" fill="${COLORS.fvg}" fill-opacity="0.12"/>`);
    parts.push(`<text x="${(fx + 4).toFixed(1)}" y="${(y(fvgMid + Math.round(unit * 0.15)) - 5).toFixed(1)}" font-family="${FONT}" font-size="12" fill="${COLORS.muted}">FVG</text>`);
  }
  if (spec.kind === "SETUP") {
    const sweepIndex = Math.round(count * 0.44) - 1;
    const c = list[Math.max(0, sweepIndex)];
    const sx = PLOT.left + (sweepIndex + 0.5) * step;
    const sy = dir === 1 ? y(c.low) + 18 : y(c.high) - 10;
    parts.push(`<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" font-family="${FONT}" font-size="13" fill="${COLORS.text}" text-anchor="middle">Sweep</text>`);
    const mssLevel = spec.entry + dir * Math.round(unit * 0.95);
    const mx = PLOT.left + count * 0.36 * step;
    parts.push(`<line x1="${mx.toFixed(1)}" y1="${y(mssLevel).toFixed(1)}" x2="${(PLOT.left + count * 0.66 * step).toFixed(1)}" y2="${y(mssLevel).toFixed(1)}" stroke="${COLORS.text}" stroke-dasharray="2 4" stroke-width="1"/>`);
    parts.push(`<text x="${(PLOT.left + count * 0.66 * step + 6).toFixed(1)}" y="${(y(mssLevel) + 4).toFixed(1)}" font-family="${FONT}" font-size="12" fill="${COLORS.text}">MSS</text>`);
  }
  // Candles.
  list.forEach((c, i) => {
    const cx = PLOT.left + (i + 0.5) * step;
    const color = c.close >= c.open ? COLORS.up : COLORS.down;
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${color}" stroke-width="1.2"/>`);
    const top = y(Math.max(c.open, c.close)), bottom = y(Math.min(c.open, c.close));
    parts.push(`<rect x="${(cx - bodyWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyWidth.toFixed(1)}" height="${Math.max(1.2, bottom - top).toFixed(1)}" fill="${color}"/>`);
  });
  // Plan lines with right-hand price tags.
  const line = (ticks, color, label, dashed) => {
    if (ticks === null) return;
    const ly = y(ticks).toFixed(1);
    parts.push(`<line x1="${PLOT.left}" y1="${ly}" x2="${PLOT.right}" y2="${ly}" stroke="${color}" stroke-width="1.4"${dashed ? ' stroke-dasharray="6 5"' : ""}/>`);
    parts.push(`<rect x="${PLOT.right + 2}" y="${(Number(ly) - 10).toFixed(1)}" width="100" height="20" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${PLOT.right + 8}" y="${(Number(ly) + 4.5).toFixed(1)}" font-family="${FONT}" font-size="12" font-weight="600" fill="#ffffff">${escapeXml(label)} ${price(ticks)}</text>`);
  };
  line(spec.target, COLORS.target, "TP", true);
  line(spec.stop, COLORS.stop, "SL", true);
  line(spec.entry, COLORS.entry, "Entry", false);
  if (spec.kind === "EXIT") line(spec.exit, COLORS.exit, "Exit", false);
  // Header and footer.
  parts.push(`<rect x="0" y="0" width="${width}" height="44" fill="#171b26"/>`);
  parts.push(`<text x="18" y="29" font-family="${FONT}" font-size="18" font-weight="600" fill="${COLORS.text}">${escapeXml(spec.symbol)} · ${escapeXml(spec.timeframe)} · ${escapeXml(spec.account)}</text>`);
  const last = list.at(-1);
  parts.push(`<text x="${width / 2 - 40}" y="29" font-family="${FONT}" font-size="14" fill="${COLORS.muted}">O ${price(last.open)}  H ${price(last.high)}  L ${price(last.low)}  C ${price(last.close)}</text>`);
  parts.push(`<text x="${width - 16}" y="29" font-family="${FONT}" font-size="13" fill="${COLORS.muted}" text-anchor="end">Synthetic chart · Trading OS local seed</text>`);
  parts.push(`<text x="18" y="${height - 14}" font-family="${FONT}" font-size="13" fill="${COLORS.muted}">${escapeXml(spec.direction === "SHORT" ? "Short" : "Long")} idea · ${escapeXml(spec.kind === "HTF" ? "Higher-timeframe context" : spec.kind === "SETUP" ? "Sweep and structure shift" : spec.kind === "ENTRY" ? "Entry" : spec.kind === "MANAGE" ? "Trade management" : "Exit")}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/** Renders one chart to image bytes with sharp (png, webp or jpeg). */
export async function renderChart(sharp, spec, format = "png") {
  const image = sharp(Buffer.from(chartSvg(spec)), { density: 72 });
  if (format === "webp") return image.webp({ quality: 82 }).toBuffer();
  if (format === "jpeg") return image.flatten({ background: COLORS.background }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return image.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
}
