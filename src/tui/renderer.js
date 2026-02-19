/**
 * Pure ANSI terminal renderer.
 * Zero dependencies — uses only process.stdout.
 *
 * Provides low-level primitives for cursor movement, colors,
 * and screen buffer management.
 */

// ANSI escape sequences
const ESC = "\x1b[";
const RESET = `${ESC}0m`;

// Colors (foreground)
export const FG = {
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  brightRed: `${ESC}91m`,
  brightGreen: `${ESC}92m`,
  brightYellow: `${ESC}93m`,
  brightBlue: `${ESC}94m`,
  brightMagenta: `${ESC}95m`,
  brightCyan: `${ESC}96m`,
  brightWhite: `${ESC}97m`
};

// Colors (background)
export const BG = {
  black: `${ESC}40m`,
  red: `${ESC}41m`,
  green: `${ESC}42m`,
  yellow: `${ESC}43m`,
  blue: `${ESC}44m`,
  magenta: `${ESC}45m`,
  cyan: `${ESC}46m`,
  white: `${ESC}47m`,
  gray: `${ESC}100m`
};

// Text styles
export const STYLE = {
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  strikethrough: `${ESC}9m`,
  reset: RESET
};

/**
 * Screen buffer for double-buffered rendering.
 * Prevents flicker by computing diffs and only writing changes.
 */
export class ScreenBuffer {
  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.buffer = [];
    this.previousBuffer = [];
    this.cursorVisible = true;
    this._clear();
  }

  _clear() {
    this.buffer = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ char: " ", style: "" }))
    );
  }

  /**
   * Resize the buffer to match terminal dimensions.
   */
  resize() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this._clear();
    this.previousBuffer = [];
  }

  /**
   * Write a styled string at a position.
   */
  write(x, y, text, style = "") {
    if (y < 0 || y >= this.height) return;
    const stripped = stripAnsi(text);
    for (let i = 0; i < stripped.length; i++) {
      const col = x + i;
      if (col < 0 || col >= this.width) continue;
      this.buffer[y][col] = { char: stripped[i], style };
    }
  }

  /**
   * Write a styled string with inline ANSI codes preserved.
   */
  writeStyled(x, y, segments) {
    if (y < 0 || y >= this.height) return;
    let col = x;
    for (const seg of segments) {
      const text = seg.text ?? "";
      const style = seg.style ?? "";
      for (let i = 0; i < text.length; i++) {
        if (col >= this.width) break;
        if (col >= 0) {
          this.buffer[y][col] = { char: text[i], style };
        }
        col++;
      }
    }
  }

  /**
   * Fill a rectangular region.
   */
  fill(x, y, w, h, char = " ", style = "") {
    for (let row = y; row < y + h && row < this.height; row++) {
      for (let col = x; col < x + w && col < this.width; col++) {
        if (row >= 0 && col >= 0) {
          this.buffer[row][col] = { char, style };
        }
      }
    }
  }

  /**
   * Draw a box border.
   */
  box(x, y, w, h, style = "", chars = null) {
    const c = chars ?? { tl: "\u250c", tr: "\u2510", bl: "\u2514", br: "\u2518", h: "\u2500", v: "\u2502" };

    // Top border
    this.write(x, y, c.tl, style);
    for (let i = 1; i < w - 1; i++) this.write(x + i, y, c.h, style);
    this.write(x + w - 1, y, c.tr, style);

    // Side borders
    for (let row = 1; row < h - 1; row++) {
      this.write(x, y + row, c.v, style);
      this.write(x + w - 1, y + row, c.v, style);
    }

    // Bottom border
    if (h > 1) {
      this.write(x, y + h - 1, c.bl, style);
      for (let i = 1; i < w - 1; i++) this.write(x + i, y + h - 1, c.h, style);
      this.write(x + w - 1, y + h - 1, c.br, style);
    }
  }

  /**
   * Draw a horizontal line.
   */
  hline(x, y, length, style = "", char = "\u2500") {
    for (let i = 0; i < length; i++) {
      this.write(x + i, y, char, style);
    }
  }

  /**
   * Render the buffer to stdout with diff optimization.
   */
  flush() {
    const out = [];

    if (this.previousBuffer.length === 0) {
      // First render: write everything
      out.push(`${ESC}?25l`); // hide cursor
      out.push(`${ESC}H`); // move to home
      for (let y = 0; y < this.height; y++) {
        out.push(`${ESC}${y + 1};1H`); // move to row
        let lastStyle = "";
        for (let x = 0; x < this.width; x++) {
          const cell = this.buffer[y][x];
          if (cell.style !== lastStyle) {
            out.push(RESET);
            if (cell.style) out.push(cell.style);
            lastStyle = cell.style;
          }
          out.push(cell.char);
        }
      }
      out.push(RESET);
    } else {
      // Diff render: only write changed cells
      out.push(`${ESC}?25l`);
      let lastStyle = "";
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const cell = this.buffer[y][x];
          const prev = this.previousBuffer[y]?.[x];
          if (prev && prev.char === cell.char && prev.style === cell.style) continue;

          out.push(`${ESC}${y + 1};${x + 1}H`);
          if (cell.style !== lastStyle) {
            out.push(RESET);
            if (cell.style) out.push(cell.style);
            lastStyle = cell.style;
          }
          out.push(cell.char);
        }
      }
      out.push(RESET);
    }

    process.stdout.write(out.join(""));

    // Save current buffer as previous
    this.previousBuffer = this.buffer.map(row =>
      row.map(cell => ({ ...cell }))
    );
    this._clear();
  }

  /**
   * Show/hide the cursor.
   */
  showCursor(visible = true) {
    process.stdout.write(visible ? `${ESC}?25h` : `${ESC}?25l`);
    this.cursorVisible = visible;
  }

  /**
   * Clear the entire screen.
   */
  clearScreen() {
    process.stdout.write(`${ESC}2J${ESC}H`);
    this.previousBuffer = [];
  }

  /**
   * Restore terminal state.
   */
  cleanup() {
    this.showCursor(true);
    process.stdout.write(RESET);
    this.clearScreen();
  }
}

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Truncate a string to fit within a width, adding ellipsis.
 */
export function truncate(str, maxWidth) {
  if (str.length <= maxWidth) return str;
  if (maxWidth <= 3) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 1) + "\u2026";
}

/**
 * Pad a string to a fixed width.
 */
export function pad(str, width, align = "left") {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  const gap = width - s.length;
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

/**
 * Format bytes as human-readable.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format milliseconds as human-readable duration.
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}
