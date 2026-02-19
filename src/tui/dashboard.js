/**
 * Main TUI Dashboard composition.
 * Combines renderer, widgets, and input into an interactive dashboard.
 */

import { ScreenBuffer, FG, BG, STYLE, truncate, pad, formatBytes, formatDuration } from "./renderer.js";
import {
  progressBar,
  sparkline,
  healthGauge,
  cacheHeatmap,
  dependencyTree,
  table,
  statusLine,
  severityBadge
} from "./widgets.js";
import { createInputHandler, createScrollState } from "./input.js";

/**
 * Panel definitions for the dashboard.
 */
const PANELS = {
  overview: { label: "Overview", key: "1" },
  deps: { label: "Dependencies", key: "2" },
  cache: { label: "Cache", key: "3" },
  health: { label: "Health", key: "4" },
  benchmark: { label: "Benchmark", key: "5" }
};

/**
 * Create and run the interactive dashboard.
 *
 * @param {Object} data - Dashboard data
 * @param {Object} data.projectInfo - {name, version, root, pm}
 * @param {Object} data.installReport - Latest install report
 * @param {Object} data.healthReport - Doctor health report
 * @param {Object} data.cacheStats - Cache statistics
 * @param {Object} data.benchmarkData - Benchmark results
 * @param {Object} data.depTree - Dependency tree
 * @param {Object} data.vulnData - Vulnerability data
 * @returns {Promise<void>}
 */
export async function runDashboard(data) {
  const screen = new ScreenBuffer();
  let activePanel = "overview";
  let running = true;
  let treeScroll = null;
  let depsCollapsed = new Set();
  let showHelp = false;
  let lastRenderTime = 0;

  // Initialize dependency tree scroll state
  if (data.depTree) {
    const treeLines = dependencyTree(data.depTree, { collapsed: depsCollapsed });
    treeScroll = createScrollState(treeLines.length, screen.height - 8);
  }

  const input = createInputHandler((key) => {
    switch (key) {
      case "quit":
      case "ctrl-c":
      case "ctrl-d":
        running = false;
        break;

      case "panel-1": activePanel = "overview"; break;
      case "panel-2": activePanel = "deps"; break;
      case "panel-3": activePanel = "cache"; break;
      case "panel-4": activePanel = "health"; break;
      case "panel-5": activePanel = "benchmark"; break;

      case "tab":
        activePanel = nextPanel(activePanel);
        break;

      case "up":
        if (activePanel === "deps" && treeScroll) treeScroll.moveUp();
        break;
      case "down":
        if (activePanel === "deps" && treeScroll) treeScroll.moveDown();
        break;
      case "pageup":
        if (treeScroll) treeScroll.pageUp();
        break;
      case "pagedown":
        if (treeScroll) treeScroll.pageDown();
        break;
      case "home":
        if (treeScroll) treeScroll.goHome();
        break;
      case "end":
        if (treeScroll) treeScroll.goEnd();
        break;

      case "enter":
      case "space":
        if (activePanel === "deps" && treeScroll) {
          toggleCollapse(treeScroll.cursor);
        }
        break;

      case "expand":
        depsCollapsed.clear();
        break;
      case "collapse":
        collapseAll();
        break;

      case "help":
        showHelp = !showHelp;
        break;

      case "refresh":
        screen.previousBuffer = [];
        break;
    }

    render();
  });

  function nextPanel(current) {
    const keys = Object.keys(PANELS);
    const idx = keys.indexOf(current);
    return keys[(idx + 1) % keys.length];
  }

  function toggleCollapse(cursorIdx) {
    if (!data.depTree) return;
    const treeLines = dependencyTree(data.depTree, { collapsed: depsCollapsed });
    const line = treeLines[cursorIdx];
    if (!line || !line.hasChildren) return;
    if (depsCollapsed.has(line.key)) {
      depsCollapsed.delete(line.key);
    } else {
      depsCollapsed.add(line.key);
    }
    const newLines = dependencyTree(data.depTree, { collapsed: depsCollapsed });
    treeScroll.updateTotal(newLines.length);
  }

  function collapseAll() {
    if (!data.depTree) return;
    const treeLines = dependencyTree(data.depTree, { collapsed: new Set() });
    for (const line of treeLines) {
      if (line.hasChildren && line.depth > 0) {
        depsCollapsed.add(line.key);
      }
    }
    const newLines = dependencyTree(data.depTree, { collapsed: depsCollapsed });
    treeScroll.updateTotal(newLines.length);
  }

  function render() {
    const start = Date.now();
    screen.resize();
    const w = screen.width;
    const h = screen.height;

    // Header bar
    renderHeader(screen, w, data.projectInfo);

    // Panel tabs
    renderTabs(screen, w, activePanel);

    // Main content area (y=3 to h-2)
    const contentY = 3;
    const contentH = h - 4;

    switch (activePanel) {
      case "overview":
        renderOverview(screen, 0, contentY, w, contentH, data);
        break;
      case "deps":
        renderDeps(screen, 0, contentY, w, contentH, data, treeScroll, depsCollapsed);
        break;
      case "cache":
        renderCache(screen, 0, contentY, w, contentH, data);
        break;
      case "health":
        renderHealth(screen, 0, contentY, w, contentH, data);
        break;
      case "benchmark":
        renderBenchmark(screen, 0, contentY, w, contentH, data);
        break;
    }

    // Help overlay
    if (showHelp) {
      renderHelpOverlay(screen, w, h);
    }

    // Footer status line
    renderFooter(screen, w, h);

    screen.flush();
    lastRenderTime = Date.now() - start;
  }

  // Start
  screen.clearScreen();
  screen.showCursor(false);
  input.start();
  render();

  // Handle terminal resize
  const onResize = () => {
    screen.resize();
    if (treeScroll) treeScroll.resize(screen.height - 8);
    render();
  };
  process.stdout.on("resize", onResize);

  // Wait for quit
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  // Cleanup
  process.stdout.removeListener("resize", onResize);
  input.stop();
  screen.cleanup();
}

// ──────────────────────────────────────────
// Section renderers
// ──────────────────────────────────────────

function renderHeader(screen, w, info) {
  screen.fill(0, 0, w, 1, " ", `${BG.blue}${FG.brightWhite}`);
  const title = ` better dashboard`;
  const project = info ? ` ${info.name ?? "unknown"}@${info.version ?? "0.0.0"} (${info.pm ?? "npm"})` : "";
  screen.write(0, 0, title, `${STYLE.bold}${BG.blue}${FG.brightWhite}`);
  screen.write(w - project.length - 1, 0, project, `${BG.blue}${FG.white}`);
}

function renderTabs(screen, w, activePanel) {
  let x = 0;
  for (const [key, panel] of Object.entries(PANELS)) {
    const label = ` ${panel.key}:${panel.label} `;
    const style = key === activePanel
      ? `${STYLE.bold}${BG.white}${FG.black}`
      : `${BG.gray}${FG.white}`;
    screen.write(x, 1, label, style);
    x += label.length + 1;
  }
  // Fill rest of line
  screen.fill(x, 1, w - x, 1, " ", BG.black);
  // Separator
  screen.hline(0, 2, w, FG.gray);
}

function renderOverview(screen, x, y, w, h, data) {
  const report = data.installReport;
  let row = y;

  // Section: Install Summary
  screen.write(x + 1, row, "Install Summary", `${STYLE.bold}${FG.white}`);
  row += 1;

  if (report) {
    const items = [
      { label: "Duration", value: formatDuration(report.install?.wallTimeMs ?? 0) },
      { label: "Packages", value: String(report.install?.metrics?.packagesAfter ?? "?") },
      { label: "Engine", value: report.engine ?? "pm" },
      { label: "Cache", value: report.cacheDecision?.hit ? "HIT" : "MISS", color: report.cacheDecision?.hit ? FG.green : FG.yellow }
    ];
    screen.writeStyled(x + 1, row, statusLine(items, w - 2));
    row += 2;

    // node_modules size bar
    if (report.nodeModules?.logicalBytes) {
      screen.write(x + 1, row, "node_modules:", FG.gray);
      screen.write(x + 15, row, formatBytes(report.nodeModules.logicalBytes), FG.white);
      row++;
      screen.writeStyled(x + 1, row, progressBar(
        Math.min(1, report.nodeModules.logicalBytes / (500 * 1024 * 1024)),
        w - 2,
        { colorFn: (v) => v > 0.7 ? FG.red : v > 0.4 ? FG.yellow : FG.green }
      ));
      row += 2;
    }
  } else {
    screen.write(x + 1, row, "No install report available. Run `better install` first.", FG.gray);
    row += 2;
  }

  // Section: Health Score
  screen.write(x + 1, row, "Health Score", `${STYLE.bold}${FG.white}`);
  row++;
  if (data.healthReport?.score != null) {
    screen.writeStyled(x + 1, row, healthGauge(data.healthReport.score, w - 2));
    row += 2;

    const findings = data.healthReport.findings ?? [];
    const errors = findings.filter(f => f.severity === "error").length;
    const warnings = findings.filter(f => f.severity === "warning").length;
    screen.writeStyled(x + 1, row, [
      { text: `${errors} errors`, style: errors > 0 ? FG.red : FG.green },
      { text: "  ", style: "" },
      { text: `${warnings} warnings`, style: warnings > 0 ? FG.yellow : FG.green }
    ]);
    row += 2;
  } else {
    screen.write(x + 1, row, "Run `better doctor` to get health data.", FG.gray);
    row += 2;
  }

  // Section: Vulnerability Summary
  if (data.vulnData?.summary) {
    screen.write(x + 1, row, "Security", `${STYLE.bold}${FG.white}`);
    row++;
    const vs = data.vulnData.summary;
    const vulnItems = [
      { label: "Total", value: String(vs.totalVulnerabilities ?? 0) },
      { label: "Critical", value: String(vs.severityCounts?.critical ?? 0), color: FG.red },
      { label: "High", value: String(vs.severityCounts?.high ?? 0), color: FG.brightRed },
      { label: "Medium", value: String(vs.severityCounts?.medium ?? 0), color: FG.yellow },
      { label: "Low", value: String(vs.severityCounts?.low ?? 0), color: FG.cyan }
    ];
    screen.writeStyled(x + 1, row, statusLine(vulnItems, w - 2));
    row += 2;
  }
}

function renderDeps(screen, x, y, w, h, data, scroll, collapsed) {
  screen.write(x + 1, y, "Dependency Tree", `${STYLE.bold}${FG.white}`);
  screen.write(x + 20, y, " (j/k: navigate, enter: expand/collapse, e: expand all, c: collapse all)", FG.gray);

  if (!data.depTree) {
    screen.write(x + 1, y + 2, "No dependency data available.", FG.gray);
    return;
  }

  const treeLines = dependencyTree(data.depTree, { collapsed, maxDepth: 8 });
  if (scroll) scroll.updateTotal(treeLines.length);

  const startRow = y + 2;
  const visibleH = h - 3;
  const range = scroll ? scroll.visibleRange() : { start: 0, end: Math.min(treeLines.length, visibleH) };

  for (let i = range.start; i < range.end && (i - range.start) < visibleH; i++) {
    const line = treeLines[i];
    const rowY = startRow + (i - range.start);
    const isSelected = scroll && i === scroll.cursor;

    if (isSelected) {
      screen.fill(x, rowY, w, 1, " ", BG.gray);
    }

    screen.writeStyled(x + 1, rowY, line.line);
  }

  // Scrollbar
  if (scroll && treeLines.length > visibleH) {
    const scrollbarH = Math.max(1, Math.floor(visibleH * visibleH / treeLines.length));
    const scrollbarPos = Math.floor(scroll.offset * visibleH / treeLines.length);
    for (let i = 0; i < visibleH; i++) {
      const char = (i >= scrollbarPos && i < scrollbarPos + scrollbarH) ? "\u2588" : "\u2502";
      screen.write(w - 1, startRow + i, char, FG.gray);
    }
  }
}

function renderCache(screen, x, y, w, h, data) {
  screen.write(x + 1, y, "Cache Statistics", `${STYLE.bold}${FG.white}`);
  let row = y + 2;

  if (data.cacheStats) {
    const stats = data.cacheStats;

    // Cache overview
    const items = [
      { label: "Entries", value: String(stats.entries ?? 0) },
      { label: "Size", value: formatBytes(stats.totalSizeBytes ?? 0) },
      { label: "Hit Rate", value: `${stats.hitRate ?? 0}%`, color: (stats.hitRate ?? 0) > 70 ? FG.green : FG.yellow }
    ];
    screen.writeStyled(x + 1, row, statusLine(items, w - 2));
    row += 2;

    // Hit/miss heatmap
    screen.write(x + 1, row, "Recent Decisions:", FG.gray);
    row++;
    const decisions = stats.recentDecisions ?? [];
    screen.writeStyled(x + 1, row, cacheHeatmap(decisions, w - 4));
    row++;
    screen.writeStyled(x + 1, row, [
      { text: "\u2588 hit", style: FG.green },
      { text: "  ", style: "" },
      { text: "\u2591 miss", style: FG.red },
      { text: "  ", style: "" },
      { text: "\u2592 skip", style: FG.yellow }
    ]);
    row += 2;

    // Install time history
    if (stats.installTimes?.length > 0) {
      screen.write(x + 1, row, "Install Time Trend:", FG.gray);
      row++;
      screen.writeStyled(x + 1, row, sparkline(stats.installTimes, w - 4));
      row++;
      const min = Math.min(...stats.installTimes);
      const max = Math.max(...stats.installTimes);
      screen.writeStyled(x + 1, row, [
        { text: `min: ${formatDuration(min)}`, style: FG.green },
        { text: "  ", style: "" },
        { text: `max: ${formatDuration(max)}`, style: FG.red }
      ]);
    }
  } else {
    screen.write(x + 1, row, "No cache data available. Run `better cache stats` first.", FG.gray);
  }
}

function renderHealth(screen, x, y, w, h, data) {
  screen.write(x + 1, y, "Health Report", `${STYLE.bold}${FG.white}`);
  let row = y + 2;

  if (data.healthReport) {
    const report = data.healthReport;

    // Score gauge
    screen.writeStyled(x + 1, row, healthGauge(report.score ?? 0, w - 2));
    row += 2;

    // Findings table
    const findings = report.findings ?? [];
    if (findings.length > 0) {
      screen.write(x + 1, row, `Findings (${findings.length}):`, FG.gray);
      row++;

      const maxRows = h - (row - y) - 1;
      for (let i = 0; i < Math.min(findings.length, maxRows); i++) {
        const f = findings[i];
        const badge = severityBadge(f.severity ?? "unknown");
        const desc = truncate(f.message ?? f.rule ?? "unknown", w - 20);
        screen.writeStyled(x + 1, row, [
          badge,
          { text: " " + desc, style: FG.white }
        ]);
        row++;
      }

      if (findings.length > maxRows) {
        screen.write(x + 1, row, `... and ${findings.length - maxRows} more`, FG.gray);
      }
    } else {
      screen.write(x + 1, row, "No findings! Your project is healthy.", FG.green);
    }
  } else {
    screen.write(x + 1, row, "No health data available. Run `better doctor` first.", FG.gray);
  }
}

function renderBenchmark(screen, x, y, w, h, data) {
  screen.write(x + 1, y, "Benchmark Results", `${STYLE.bold}${FG.white}`);
  let row = y + 2;

  if (data.benchmarkData?.results?.length > 0) {
    const results = data.benchmarkData.results;

    for (const result of results) {
      screen.write(x + 1, row, `${result.engine ?? result.name ?? "unknown"}`, `${STYLE.bold}${FG.cyan}`);
      row++;

      if (result.rounds?.length > 0) {
        const times = result.rounds.map(r => r.wallTimeMs ?? 0);
        screen.write(x + 3, row, "Times: ", FG.gray);
        screen.writeStyled(x + 10, row, sparkline(times, Math.min(w - 14, 40)));
        row++;

        const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
        screen.writeStyled(x + 3, row, [
          { text: `median: ${formatDuration(median)}`, style: FG.white },
          { text: `  min: ${formatDuration(Math.min(...times))}`, style: FG.green },
          { text: `  max: ${formatDuration(Math.max(...times))}`, style: FG.red }
        ]);
        row += 2;
      }
    }
  } else {
    screen.write(x + 1, row, "No benchmark data available. Run `better benchmark` first.", FG.gray);
  }
}

function renderHelpOverlay(screen, w, h) {
  const helpW = 50;
  const helpH = 16;
  const ox = Math.floor((w - helpW) / 2);
  const oy = Math.floor((h - helpH) / 2);

  screen.fill(ox, oy, helpW, helpH, " ", BG.black);
  screen.box(ox, oy, helpW, helpH, `${FG.cyan}${STYLE.bold}`);
  screen.write(ox + 2, oy, " Keyboard Shortcuts ", `${STYLE.bold}${FG.cyan}`);

  const shortcuts = [
    ["1-5", "Switch panels"],
    ["Tab", "Next panel"],
    ["j/k or Up/Down", "Navigate list"],
    ["Enter/Space", "Expand/collapse node"],
    ["e", "Expand all"],
    ["c", "Collapse all"],
    ["g/G", "Go to top/bottom"],
    ["PgUp/PgDn", "Page up/down"],
    ["r", "Refresh display"],
    ["?", "Toggle help"],
    ["q", "Quit"]
  ];

  for (let i = 0; i < shortcuts.length; i++) {
    screen.write(ox + 3, oy + 2 + i, pad(shortcuts[i][0], 18), `${STYLE.bold}${FG.yellow}`);
    screen.write(ox + 21, oy + 2 + i, shortcuts[i][1], FG.white);
  }
}

function renderFooter(screen, w, h) {
  screen.fill(0, h - 1, w, 1, " ", `${BG.blue}${FG.white}`);
  screen.write(1, h - 1, "q:quit  ?:help  Tab:next panel  1-5:panels", `${BG.blue}${FG.white}`);
  const time = new Date().toLocaleTimeString();
  screen.write(w - time.length - 1, h - 1, time, `${BG.blue}${FG.gray}`);
}
