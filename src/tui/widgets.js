/**
 * TUI widgets: progress bars, sparklines, gauges, trees, tables.
 * Pure data -> render instructions. No side effects.
 */

import { FG, BG, STYLE, truncate, pad, formatBytes, formatDuration } from "./renderer.js";

/**
 * Horizontal progress bar.
 *
 * @param {number} value - Current value (0-1)
 * @param {number} width - Total width in characters
 * @param {Object} opts
 * @returns {Array<{text: string, style: string}>} - Styled segments
 */
export function progressBar(value, width, opts = {}) {
  const {
    filledChar = "\u2588",
    emptyChar = "\u2591",
    showPercent = true,
    colorFn = defaultProgressColor
  } = opts;

  const clamped = Math.max(0, Math.min(1, value));
  const barWidth = showPercent ? width - 5 : width;
  const filled = Math.round(clamped * barWidth);
  const empty = barWidth - filled;
  const color = colorFn(clamped);

  const segments = [
    { text: filledChar.repeat(filled), style: color },
    { text: emptyChar.repeat(empty), style: FG.gray }
  ];

  if (showPercent) {
    segments.push({ text: ` ${Math.round(clamped * 100).toString().padStart(3)}%`, style: FG.white });
  }

  return segments;
}

function defaultProgressColor(value) {
  if (value >= 0.8) return FG.green;
  if (value >= 0.5) return FG.yellow;
  return FG.red;
}

/**
 * Sparkline chart from an array of values.
 *
 * @param {number[]} data - Data points
 * @param {number} width - Chart width (data will be sampled/truncated)
 * @param {Object} opts
 * @returns {Array<{text: string, style: string}>}
 */
export function sparkline(data, width, opts = {}) {
  const { style = FG.cyan } = opts;
  const chars = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

  if (data.length === 0) return [{ text: " ".repeat(width), style: FG.gray }];

  // Sample data to fit width
  const sampled = sampleData(data, width);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  const text = sampled
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.min(Math.floor(normalized * chars.length), chars.length - 1);
      return chars[index];
    })
    .join("");

  return [{ text: pad(text, width), style }];
}

function sampleData(data, targetLen) {
  if (data.length <= targetLen) {
    return [...data, ...Array(targetLen - data.length).fill(data[data.length - 1] ?? 0)];
  }
  const step = data.length / targetLen;
  const result = [];
  for (let i = 0; i < targetLen; i++) {
    result.push(data[Math.floor(i * step)]);
  }
  return result;
}

/**
 * Health gauge (circular-style in terminal).
 *
 * @param {number} score - 0-100
 * @param {number} width
 * @returns {Array<{text: string, style: string}>}
 */
export function healthGauge(score, width) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const color = clamped >= 80 ? FG.green : clamped >= 50 ? FG.yellow : FG.red;
  const label = `${clamped}/100`;
  const barWidth = width - label.length - 3;

  const filled = Math.round((clamped / 100) * barWidth);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

  return [
    { text: "[", style: FG.gray },
    { text: bar.slice(0, filled), style: color },
    { text: bar.slice(filled), style: FG.gray },
    { text: "]", style: FG.gray },
    { text: ` ${label}`, style: `${STYLE.bold}${color}` }
  ];
}

/**
 * Cache hit/miss heatmap.
 * Shows recent cache decisions as colored blocks.
 *
 * @param {Array<"hit"|"miss"|"skip">} decisions - Recent decisions
 * @param {number} width
 * @returns {Array<{text: string, style: string}>}
 */
export function cacheHeatmap(decisions, width) {
  const segments = [];
  const chars = { hit: "\u2588", miss: "\u2591", skip: "\u2592" };
  const colors = { hit: FG.green, miss: FG.red, skip: FG.yellow };

  const visible = decisions.slice(-width);
  for (const d of visible) {
    segments.push({ text: chars[d] ?? "\u2592", style: colors[d] ?? FG.gray });
  }

  // Pad remaining width
  const remaining = width - visible.length;
  if (remaining > 0) {
    segments.push({ text: " ".repeat(remaining), style: "" });
  }

  return segments;
}

/**
 * Dependency tree renderer.
 * Renders a tree structure with indentation and box-drawing chars.
 *
 * @param {Object} root - {name, version, children: [...]}
 * @param {Object} opts - {maxDepth, maxWidth, collapsed: Set}
 * @returns {Array<{line: Array<{text: string, style: string}>, key: string, depth: number}>}
 */
export function dependencyTree(root, opts = {}) {
  const { maxDepth = 10, collapsed = new Set() } = opts;
  const lines = [];

  function render(node, prefix, isLast, depth, parentKey) {
    if (depth > maxDepth) return;

    const key = parentKey ? `${parentKey}>${node.name}` : node.name;
    const connector = depth === 0 ? "" : isLast ? "\u2514\u2500 " : "\u251c\u2500 ";
    const versionStr = node.version ? `@${node.version}` : "";
    const nameColor = depth === 0 ? `${STYLE.bold}${FG.white}` : node.vulnerable ? FG.red : FG.cyan;
    const isCollapsed = collapsed.has(key) && (node.children?.length ?? 0) > 0;
    const expandIcon = isCollapsed ? " [+]" : "";

    lines.push({
      line: [
        { text: prefix + connector, style: FG.gray },
        { text: node.name, style: nameColor },
        { text: versionStr, style: FG.gray },
        ...(node.vulnerable ? [{ text: " VULN", style: `${STYLE.bold}${FG.red}` }] : []),
        ...(isCollapsed ? [{ text: expandIcon, style: FG.yellow }] : [])
      ],
      key,
      depth,
      hasChildren: (node.children?.length ?? 0) > 0
    });

    if (isCollapsed) return;

    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const childPrefix = depth === 0 ? "" : prefix + (isLast ? "   " : "\u2502  ");
      render(children[i], childPrefix, i === children.length - 1, depth + 1, key);
    }
  }

  render(root, "", true, 0, "");
  return lines;
}

/**
 * Simple table renderer.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {Object} opts - {columnWidths, align}
 * @returns {Array<Array<{text: string, style: string}>>} - Array of line segments
 */
export function table(headers, rows, opts = {}) {
  const { align = [] } = opts;
  const lines = [];

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] ?? "").length), 0);
    return opts.columnWidths?.[i] ?? Math.max(h.length, maxData);
  });

  // Header
  const headerLine = headers.map((h, i) => ({
    text: pad(h, widths[i] + 2, align[i]),
    style: `${STYLE.bold}${FG.white}`
  }));
  lines.push(headerLine);

  // Separator
  const sepLine = [{ text: widths.map(w => "\u2500".repeat(w + 2)).join("\u253c"), style: FG.gray }];
  lines.push(sepLine);

  // Data rows
  for (const row of rows) {
    const rowLine = row.map((cell, i) => ({
      text: pad(truncate(String(cell ?? ""), widths[i]), widths[i] + 2, align[i]),
      style: FG.white
    }));
    lines.push(rowLine);
  }

  return lines;
}

/**
 * Status line with key-value pairs.
 *
 * @param {Array<{label: string, value: string, color?: string}>} items
 * @param {number} width
 * @returns {Array<{text: string, style: string}>}
 */
export function statusLine(items, width) {
  const segments = [];
  let used = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = `${item.label}: `;
    const value = String(item.value);
    const separator = i < items.length - 1 ? " | " : "";

    if (used + label.length + value.length + separator.length > width) break;

    segments.push({ text: label, style: FG.gray });
    segments.push({ text: value, style: item.color ?? FG.white });
    if (separator) segments.push({ text: separator, style: FG.gray });
    used += label.length + value.length + separator.length;
  }

  return segments;
}

/**
 * Severity badge.
 */
export function severityBadge(severity) {
  const colors = {
    critical: `${STYLE.bold}${FG.brightWhite}${BG.red}`,
    high: `${STYLE.bold}${FG.red}`,
    medium: `${STYLE.bold}${FG.yellow}`,
    low: FG.cyan,
    unknown: FG.gray
  };

  return {
    text: ` ${severity.toUpperCase()} `,
    style: colors[severity] ?? FG.gray
  };
}
