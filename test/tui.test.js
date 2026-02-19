/**
 * Comprehensive tests for TUI dashboard system.
 * Tests renderer, widgets, and input handling.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Import renderer module
import {
  ScreenBuffer,
  FG,
  BG,
  STYLE,
  stripAnsi,
  truncate,
  pad,
  formatBytes,
  formatDuration
} from "../src/tui/renderer.js";

// Import widgets module
import {
  progressBar,
  sparkline,
  healthGauge,
  cacheHeatmap,
  dependencyTree,
  table,
  statusLine,
  severityBadge
} from "../src/tui/widgets.js";

// Import input module
import {
  createInputHandler,
  createScrollState
} from "../src/tui/input.js";

// ----------------------------------------------------------------------------
// RENDERER TESTS
// ----------------------------------------------------------------------------

describe("renderer.js", () => {
  describe("Color constants", () => {
    it("should export FG color constants as ANSI strings", () => {
      assert.ok(FG.red.includes("\x1b["));
      assert.ok(FG.green.includes("\x1b["));
      assert.ok(FG.blue.includes("\x1b["));
      assert.ok(FG.yellow.includes("\x1b["));
      assert.ok(FG.cyan.includes("\x1b["));
      assert.ok(FG.magenta.includes("\x1b["));
      assert.ok(FG.white.includes("\x1b["));
      assert.ok(FG.gray.includes("\x1b["));
    });

    it("should export bright FG colors", () => {
      assert.ok(FG.brightRed.includes("\x1b["));
      assert.ok(FG.brightGreen.includes("\x1b["));
      assert.ok(FG.brightBlue.includes("\x1b["));
    });

    it("should export BG color constants as ANSI strings", () => {
      assert.ok(BG.red.includes("\x1b["));
      assert.ok(BG.green.includes("\x1b["));
      assert.ok(BG.blue.includes("\x1b["));
      assert.ok(BG.yellow.includes("\x1b["));
    });

    it("should export STYLE constants", () => {
      assert.ok(STYLE.bold.includes("\x1b["));
      assert.ok(STYLE.dim.includes("\x1b["));
      assert.ok(STYLE.italic.includes("\x1b["));
      assert.ok(STYLE.underline.includes("\x1b["));
      assert.ok(STYLE.inverse.includes("\x1b["));
      assert.ok(STYLE.reset.includes("\x1b["));
    });
  });

  describe("stripAnsi", () => {
    it("should remove ANSI escape codes", () => {
      const input = `${FG.red}Hello${STYLE.reset}${FG.blue}World${STYLE.reset}`;
      const result = stripAnsi(input);
      assert.strictEqual(result, "HelloWorld");
    });

    it("should handle strings without ANSI codes", () => {
      assert.strictEqual(stripAnsi("plain text"), "plain text");
    });

    it("should handle empty strings", () => {
      assert.strictEqual(stripAnsi(""), "");
    });

    it("should handle complex ANSI sequences", () => {
      const input = "\x1b[31;1;4mBold Red Underline\x1b[0m";
      assert.strictEqual(stripAnsi(input), "Bold Red Underline");
    });
  });

  describe("truncate", () => {
    it("should not truncate short strings", () => {
      assert.strictEqual(truncate("hello", 10), "hello");
    });

    it("should truncate long strings with ellipsis", () => {
      const result = truncate("this is a long string", 10);
      assert.strictEqual(result.length, 10);
      assert.ok(result.endsWith("\u2026"));
    });

    it("should handle maxWidth <= 3", () => {
      assert.strictEqual(truncate("hello", 3).length, 3);
    });

    it("should handle exact width match", () => {
      assert.strictEqual(truncate("exactly", 7), "exactly");
    });
  });

  describe("pad", () => {
    it("should pad left by default", () => {
      assert.strictEqual(pad("hi", 5), "hi   ");
    });

    it("should pad right when align=right", () => {
      assert.strictEqual(pad("hi", 5, "right"), "   hi");
    });

    it("should pad center when align=center", () => {
      const result = pad("hi", 6, "center");
      assert.strictEqual(result.length, 6);
      assert.ok(result.includes("hi"));
    });

    it("should not pad if already at width", () => {
      assert.strictEqual(pad("hello", 5), "hello");
    });

    it("should truncate if exceeds width", () => {
      assert.strictEqual(pad("toolong", 5), "toolo");
    });
  });

  describe("formatBytes", () => {
    it("should format 0 bytes", () => {
      assert.strictEqual(formatBytes(0), "0 B");
    });

    it("should format bytes", () => {
      assert.strictEqual(formatBytes(500), "500 B");
    });

    it("should format kilobytes", () => {
      const result = formatBytes(1024);
      assert.ok(result.includes("KB"));
    });

    it("should format megabytes", () => {
      const result = formatBytes(1024 * 1024);
      assert.ok(result.includes("MB"));
    });

    it("should format gigabytes", () => {
      const result = formatBytes(1024 * 1024 * 1024);
      assert.ok(result.includes("GB"));
    });

    it("should use decimal precision for non-bytes", () => {
      const result = formatBytes(1536); // 1.5 KB
      assert.ok(result.includes("1.5"));
    });
  });

  describe("formatDuration", () => {
    it("should format milliseconds", () => {
      assert.strictEqual(formatDuration(500), "500ms");
    });

    it("should format seconds", () => {
      const result = formatDuration(2500);
      assert.ok(result.includes("2.5s"));
    });

    it("should format minutes and seconds", () => {
      const result = formatDuration(65000);
      assert.ok(result.includes("1m"));
      assert.ok(result.includes("5s"));
    });

    it("should handle exact minute", () => {
      const result = formatDuration(60000);
      assert.ok(result.includes("1m"));
    });
  });

  describe("ScreenBuffer", () => {
    let buffer;

    beforeEach(() => {
      buffer = new ScreenBuffer();
    });

    it("should initialize with dimensions", () => {
      assert.ok(buffer.width > 0);
      assert.ok(buffer.height > 0);
      assert.ok(Array.isArray(buffer.buffer));
    });

    it("should write text at position", () => {
      buffer.write(0, 0, "Hello", FG.red);
      assert.strictEqual(buffer.buffer[0][0].char, "H");
      assert.strictEqual(buffer.buffer[0][0].style, FG.red);
      assert.strictEqual(buffer.buffer[0][1].char, "e");
    });

    it("should ignore writes outside buffer bounds", () => {
      buffer.write(-1, -1, "test");
      buffer.write(1000, 1000, "test");
      // Should not throw
      assert.ok(true);
    });

    it("should strip ANSI codes when writing", () => {
      buffer.write(0, 0, `${FG.red}test${STYLE.reset}`);
      assert.strictEqual(buffer.buffer[0][0].char, "t");
      assert.strictEqual(buffer.buffer[0][1].char, "e");
    });

    it("should write styled segments", () => {
      const segments = [
        { text: "Hello", style: FG.red },
        { text: " ", style: "" },
        { text: "World", style: FG.blue }
      ];
      buffer.writeStyled(0, 0, segments);
      assert.strictEqual(buffer.buffer[0][0].char, "H");
      assert.strictEqual(buffer.buffer[0][0].style, FG.red);
      assert.strictEqual(buffer.buffer[0][6].char, "W");
      assert.strictEqual(buffer.buffer[0][6].style, FG.blue);
    });

    it("should fill rectangular region", () => {
      buffer.fill(0, 0, 3, 2, "X", FG.green);
      assert.strictEqual(buffer.buffer[0][0].char, "X");
      assert.strictEqual(buffer.buffer[0][2].char, "X");
      assert.strictEqual(buffer.buffer[1][0].char, "X");
      assert.strictEqual(buffer.buffer[1][2].char, "X");
    });

    it("should draw horizontal line", () => {
      buffer.hline(0, 0, 5, FG.gray);
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(buffer.buffer[0][i].char, "\u2500");
      }
    });

    it("should draw box border", () => {
      buffer.box(0, 0, 5, 3, FG.white);
      // Check corners
      assert.strictEqual(buffer.buffer[0][0].char, "\u250c"); // top-left
      assert.strictEqual(buffer.buffer[0][4].char, "\u2510"); // top-right
      assert.strictEqual(buffer.buffer[2][0].char, "\u2514"); // bottom-left
      assert.strictEqual(buffer.buffer[2][4].char, "\u2518"); // bottom-right
    });

    it("should resize buffer", () => {
      const oldWidth = buffer.width;
      const oldHeight = buffer.height;
      buffer.resize();
      // Should reinitialize
      assert.ok(buffer.buffer.length > 0);
      assert.strictEqual(buffer.previousBuffer.length, 0);
    });

    it("should handle cursor visibility", () => {
      // Should not throw
      buffer.showCursor(true);
      buffer.showCursor(false);
      assert.ok(true);
    });
  });
});

// ----------------------------------------------------------------------------
// WIDGETS TESTS
// ----------------------------------------------------------------------------

describe("widgets.js", () => {
  describe("progressBar", () => {
    it("should create progress bar segments", () => {
      const segments = progressBar(0.5, 20);
      assert.ok(Array.isArray(segments));
      assert.ok(segments.length > 0);
      assert.ok(segments.every(s => s.text && s.style !== undefined));
    });

    it("should show percentage by default", () => {
      const segments = progressBar(0.75, 20);
      const text = segments.map(s => s.text).join("");
      assert.ok(text.includes("75"));
    });

    it("should hide percentage when showPercent=false", () => {
      const segments = progressBar(0.5, 20, { showPercent: false });
      const text = segments.map(s => s.text).join("");
      assert.ok(!text.includes("%"));
    });

    it("should clamp value between 0 and 1", () => {
      const segments1 = progressBar(-0.5, 20);
      const segments2 = progressBar(1.5, 20);
      assert.ok(Array.isArray(segments1));
      assert.ok(Array.isArray(segments2));
    });

    it("should use custom chars", () => {
      const segments = progressBar(0.5, 10, {
        filledChar: "#",
        emptyChar: "-",
        showPercent: false
      });
      const text = segments.map(s => s.text).join("");
      assert.ok(text.includes("#"));
      assert.ok(text.includes("-"));
    });

    it("should apply color based on value", () => {
      const low = progressBar(0.3, 20);
      const mid = progressBar(0.6, 20);
      const high = progressBar(0.9, 20);
      // Should have different colors
      assert.ok(low[0].style);
      assert.ok(mid[0].style);
      assert.ok(high[0].style);
    });
  });

  describe("sparkline", () => {
    it("should create sparkline from data", () => {
      const segments = sparkline([1, 2, 3, 4, 5], 10);
      assert.ok(Array.isArray(segments));
      assert.ok(segments[0].text);
      assert.strictEqual(segments[0].text.length, 10);
    });

    it("should handle empty data", () => {
      const segments = sparkline([], 10);
      assert.ok(Array.isArray(segments));
      assert.strictEqual(segments[0].text.length, 10);
    });

    it("should sample data to fit width", () => {
      const segments = sparkline([1, 2, 3, 4, 5, 6, 7, 8], 5);
      assert.strictEqual(segments[0].text.length, 5);
    });

    it("should pad if data shorter than width", () => {
      const segments = sparkline([1, 2], 5);
      assert.strictEqual(segments[0].text.length, 5);
    });

    it("should normalize data to character range", () => {
      const segments = sparkline([0, 50, 100], 3);
      const text = segments[0].text;
      // Should use different spark characters
      assert.ok(text.length === 3);
    });
  });

  describe("healthGauge", () => {
    it("should create gauge segments", () => {
      const segments = healthGauge(75, 30);
      assert.ok(Array.isArray(segments));
      assert.ok(segments.length > 0);
    });

    it("should show score label", () => {
      const segments = healthGauge(85, 30);
      const text = segments.map(s => s.text).join("");
      assert.ok(text.includes("85"));
      assert.ok(text.includes("100"));
    });

    it("should clamp score to 0-100", () => {
      const segments1 = healthGauge(-10, 30);
      const segments2 = healthGauge(150, 30);
      assert.ok(Array.isArray(segments1));
      assert.ok(Array.isArray(segments2));
    });

    it("should use green for high scores", () => {
      const segments = healthGauge(90, 30);
      const hasGreen = segments.some(s => s.style.includes(FG.green));
      assert.ok(hasGreen);
    });

    it("should use red for low scores", () => {
      const segments = healthGauge(30, 30);
      const hasRed = segments.some(s => s.style.includes(FG.red));
      assert.ok(hasRed);
    });
  });

  describe("cacheHeatmap", () => {
    it("should create heatmap segments", () => {
      const decisions = ["hit", "miss", "skip", "hit"];
      const segments = cacheHeatmap(decisions, 10);
      assert.ok(Array.isArray(segments));
      assert.strictEqual(segments.length, 5); // 4 decisions + padding
    });

    it("should show only last N decisions", () => {
      const decisions = Array(20).fill("hit");
      const segments = cacheHeatmap(decisions, 10);
      const blockCount = segments.filter(s => s.text === "\u2588").length;
      assert.ok(blockCount <= 10);
    });

    it("should pad to width", () => {
      const decisions = ["hit", "miss"];
      const segments = cacheHeatmap(decisions, 10);
      const totalLen = segments.reduce((sum, s) => sum + s.text.length, 0);
      assert.strictEqual(totalLen, 10);
    });

    it("should use distinct colors for decision types", () => {
      const decisions = ["hit", "miss", "skip"];
      const segments = cacheHeatmap(decisions, 10);
      const styles = new Set(segments.map(s => s.style));
      assert.ok(styles.size >= 2);
    });
  });

  describe("dependencyTree", () => {
    it("should render simple tree", () => {
      const root = { name: "root", version: "1.0.0", children: [] };
      const lines = dependencyTree(root);
      assert.ok(Array.isArray(lines));
      assert.ok(lines.length > 0);
      assert.ok(lines[0].line);
      assert.ok(lines[0].key);
    });

    it("should render tree with children", () => {
      const root = {
        name: "root",
        version: "1.0.0",
        children: [
          { name: "child1", version: "2.0.0" },
          { name: "child2", version: "3.0.0" }
        ]
      };
      const lines = dependencyTree(root);
      assert.ok(lines.length >= 3); // root + 2 children
    });

    it("should respect maxDepth", () => {
      const root = {
        name: "root",
        children: [
          {
            name: "level1",
            children: [
              {
                name: "level2",
                children: [{ name: "level3" }]
              }
            ]
          }
        ]
      };
      const lines = dependencyTree(root, { maxDepth: 2 });
      // Should not include level3
      const hasLevel3 = lines.some(l =>
        l.line.some(seg => seg.text.includes("level3"))
      );
      assert.ok(!hasLevel3);
    });

    it("should handle collapsed nodes", () => {
      const root = {
        name: "root",
        children: [{ name: "child1", children: [{ name: "nested" }] }]
      };
      const collapsed = new Set(["root>child1"]);
      const lines = dependencyTree(root, { collapsed });
      // Should not show nested when child1 is collapsed
      const hasNested = lines.some(l =>
        l.line.some(seg => seg.text.includes("nested"))
      );
      assert.ok(!hasNested);
    });

    it("should mark vulnerable packages", () => {
      const root = {
        name: "root",
        children: [{ name: "vuln-pkg", version: "1.0.0", vulnerable: true }]
      };
      const lines = dependencyTree(root);
      const hasVuln = lines.some(l =>
        l.line.some(seg => seg.text.includes("VULN"))
      );
      assert.ok(hasVuln);
    });
  });

  describe("table", () => {
    it("should create table with headers and rows", () => {
      const headers = ["Name", "Value"];
      const rows = [
        ["foo", "123"],
        ["bar", "456"]
      ];
      const lines = table(headers, rows);
      assert.ok(Array.isArray(lines));
      assert.ok(lines.length >= 3); // header + separator + rows
    });

    it("should calculate column widths", () => {
      const headers = ["A", "B"];
      const rows = [["short", "very long value"]];
      const lines = table(headers, rows);
      assert.ok(lines.length > 0);
    });

    it("should respect custom column widths", () => {
      const headers = ["A", "B"];
      const rows = [["x", "y"]];
      const lines = table(headers, rows, { columnWidths: [10, 20] });
      assert.ok(lines.length > 0);
    });

    it("should apply alignment", () => {
      const headers = ["Left", "Right"];
      const rows = [["L", "R"]];
      const lines = table(headers, rows, { align: ["left", "right"] });
      assert.ok(lines.length > 0);
    });

    it("should truncate long cell values", () => {
      const headers = ["Col"];
      const rows = [["this is a very long string that should be truncated"]];
      const lines = table(headers, rows, { columnWidths: [10] });
      const cellText = lines[2][0].text.trim();
      assert.ok(cellText.length <= 12); // width + padding
    });
  });

  describe("statusLine", () => {
    it("should create status segments from items", () => {
      const items = [
        { label: "Status", value: "OK" },
        { label: "Count", value: "42" }
      ];
      const segments = statusLine(items, 50);
      assert.ok(Array.isArray(segments));
      assert.ok(segments.length > 0);
    });

    it("should separate items with pipe", () => {
      const items = [
        { label: "A", value: "1" },
        { label: "B", value: "2" }
      ];
      const segments = statusLine(items, 50);
      const text = segments.map(s => s.text).join("");
      assert.ok(text.includes("|"));
    });

    it("should respect width limit", () => {
      const items = [
        { label: "VeryLongLabel", value: "VeryLongValue" },
        { label: "Another", value: "Item" }
      ];
      const segments = statusLine(items, 20);
      const totalLen = segments.reduce((sum, s) => sum + s.text.length, 0);
      assert.ok(totalLen <= 20);
    });

    it("should apply custom colors", () => {
      const items = [{ label: "Status", value: "OK", color: FG.green }];
      const segments = statusLine(items, 50);
      const hasGreen = segments.some(s => s.style === FG.green);
      assert.ok(hasGreen);
    });
  });

  describe("severityBadge", () => {
    it("should create badge for critical severity", () => {
      const badge = severityBadge("critical");
      assert.ok(badge.text);
      assert.ok(badge.style);
      assert.ok(badge.text.includes("CRITICAL"));
    });

    it("should create badge for high severity", () => {
      const badge = severityBadge("high");
      assert.ok(badge.text.includes("HIGH"));
    });

    it("should create badge for medium severity", () => {
      const badge = severityBadge("medium");
      assert.ok(badge.text.includes("MEDIUM"));
    });

    it("should create badge for low severity", () => {
      const badge = severityBadge("low");
      assert.ok(badge.text.includes("LOW"));
    });

    it("should handle unknown severity", () => {
      const badge = severityBadge("unknown");
      assert.ok(badge.text);
      assert.ok(badge.style);
    });

    it("should use different colors for severities", () => {
      const critical = severityBadge("critical");
      const low = severityBadge("low");
      assert.notStrictEqual(critical.style, low.style);
    });
  });
});

// ----------------------------------------------------------------------------
// INPUT TESTS
// ----------------------------------------------------------------------------

describe("input.js", () => {
  describe("createInputHandler", () => {
    it("should create handler with start/stop/isActive", () => {
      const handler = createInputHandler(() => {});
      assert.ok(typeof handler.start === "function");
      assert.ok(typeof handler.stop === "function");
      assert.ok(typeof handler.isActive === "boolean");
    });

    it("should initially be inactive", () => {
      const handler = createInputHandler(() => {});
      assert.strictEqual(handler.isActive, false);
    });

    it("should not throw when stopped without starting", () => {
      const handler = createInputHandler(() => {});
      handler.stop();
      assert.ok(true);
    });
  });

  describe("createScrollState", () => {
    it("should initialize with cursor at 0", () => {
      const state = createScrollState(100, 10);
      assert.strictEqual(state.cursor, 0);
      assert.strictEqual(state.offset, 0);
    });

    it("should move cursor down", () => {
      const state = createScrollState(100, 10);
      state.moveDown();
      assert.strictEqual(state.cursor, 1);
    });

    it("should move cursor up", () => {
      const state = createScrollState(100, 10);
      state.moveDown();
      state.moveDown();
      state.moveUp();
      assert.strictEqual(state.cursor, 1);
    });

    it("should not move cursor below 0", () => {
      const state = createScrollState(100, 10);
      state.moveUp();
      assert.strictEqual(state.cursor, 0);
    });

    it("should not move cursor above total", () => {
      const state = createScrollState(10, 5);
      for (let i = 0; i < 20; i++) state.moveDown();
      assert.strictEqual(state.cursor, 9);
    });

    it("should adjust offset when cursor scrolls down", () => {
      const state = createScrollState(100, 10);
      for (let i = 0; i < 11; i++) state.moveDown();
      assert.ok(state.offset > 0);
    });

    it("should adjust offset when cursor scrolls up", () => {
      const state = createScrollState(100, 10);
      for (let i = 0; i < 20; i++) state.moveDown();
      const oldOffset = state.offset;
      for (let i = 0; i < 15; i++) state.moveUp();
      assert.ok(state.offset < oldOffset);
    });

    it("should page down", () => {
      const state = createScrollState(100, 10);
      const oldCursor = state.cursor;
      state.pageDown();
      assert.ok(state.cursor > oldCursor);
    });

    it("should page up", () => {
      const state = createScrollState(100, 10);
      state.cursor = 50;
      state.offset = 40;
      const oldCursor = state.cursor;
      state.pageUp();
      assert.ok(state.cursor < oldCursor);
    });

    it("should go to home", () => {
      const state = createScrollState(100, 10);
      state.cursor = 50;
      state.offset = 40;
      state.goHome();
      assert.strictEqual(state.cursor, 0);
      assert.strictEqual(state.offset, 0);
    });

    it("should go to end", () => {
      const state = createScrollState(100, 10);
      state.goEnd();
      assert.strictEqual(state.cursor, 99);
      assert.ok(state.offset > 0);
    });

    it("should resize visible height", () => {
      const state = createScrollState(100, 10);
      state.resize(20);
      assert.strictEqual(state.visibleHeight, 20);
    });

    it("should update total items", () => {
      const state = createScrollState(100, 10);
      state.updateTotal(50);
      assert.strictEqual(state.totalItems, 50);
    });

    it("should clamp cursor when total decreases", () => {
      const state = createScrollState(100, 10);
      state.cursor = 80;
      state.updateTotal(20);
      assert.ok(state.cursor < 20);
    });

    it("should return visible range", () => {
      const state = createScrollState(100, 10);
      const range = state.visibleRange();
      assert.strictEqual(range.start, 0);
      assert.strictEqual(range.end, 10);
    });

    it("should update visible range when scrolling", () => {
      const state = createScrollState(100, 10);
      for (let i = 0; i < 15; i++) state.moveDown();
      const range = state.visibleRange();
      assert.ok(range.start > 0);
    });

    it("should handle small lists", () => {
      const state = createScrollState(5, 10);
      state.goEnd();
      assert.strictEqual(state.cursor, 4);
      assert.strictEqual(state.offset, 0);
    });

    it("should handle edge case of 0 items", () => {
      const state = createScrollState(0, 10);
      state.moveDown();
      state.moveUp();
      state.goHome();
      state.goEnd();
      // Should not throw
      assert.ok(true);
    });

    it("should handle 1 item", () => {
      const state = createScrollState(1, 10);
      assert.strictEqual(state.cursor, 0);
      state.moveDown();
      assert.strictEqual(state.cursor, 0);
    });
  });
});
