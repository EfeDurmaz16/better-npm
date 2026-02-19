/**
 * Keyboard input handler for the TUI.
 * Reads raw stdin and emits named key events.
 * Supports vim-style navigation.
 */

/**
 * Key mapping from raw escape sequences to named keys.
 */
const KEY_MAP = new Map([
  // Arrow keys
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],

  // vim keys
  ["k", "up"],
  ["j", "down"],
  ["h", "left"],
  ["l", "right"],

  // Navigation
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["g", "home"],
  ["G", "end"],

  // Actions
  ["\r", "enter"],
  ["\n", "enter"],
  [" ", "space"],
  ["\t", "tab"],
  ["\x1b", "escape"],
  ["\x7f", "backspace"],
  ["\x1b[3~", "delete"],

  // Ctrl keys
  ["\x03", "ctrl-c"],
  ["\x04", "ctrl-d"],
  ["\x12", "ctrl-r"],
  ["\x06", "ctrl-f"],
  ["\x02", "ctrl-b"],

  // Panel switching (number keys)
  ["1", "panel-1"],
  ["2", "panel-2"],
  ["3", "panel-3"],
  ["4", "panel-4"],
  ["5", "panel-5"],

  // Other
  ["q", "quit"],
  ["?", "help"],
  ["/", "search"],
  ["e", "expand"],
  ["c", "collapse"],
  ["r", "refresh"]
]);

/**
 * Create an input handler that reads from stdin.
 *
 * @param {function(string): void} onKey - Callback for named key events
 * @returns {{start: function, stop: function}}
 */
export function createInputHandler(onKey) {
  let active = false;
  let buffer = "";
  let bufferTimeout = null;

  function handleData(data) {
    const str = data.toString();

    // Check for multi-byte escape sequences
    buffer += str;

    // Clear any pending timeout
    if (bufferTimeout) {
      clearTimeout(bufferTimeout);
      bufferTimeout = null;
    }

    // Try to match escape sequences immediately
    const matched = tryMatch(buffer);
    if (matched) {
      buffer = "";
      onKey(matched);
      return;
    }

    // If buffer starts with ESC, wait briefly for more bytes
    if (buffer.startsWith("\x1b") && buffer.length < 6) {
      bufferTimeout = setTimeout(() => {
        // Timed out waiting for more bytes — treat as plain escape
        if (buffer === "\x1b") {
          onKey("escape");
        } else {
          const key = tryMatch(buffer);
          if (key) onKey(key);
        }
        buffer = "";
      }, 50);
      return;
    }

    // Single character — match or pass through
    buffer = "";
    for (const char of str) {
      const key = KEY_MAP.get(char);
      if (key) {
        onKey(key);
      }
    }
  }

  function tryMatch(buf) {
    // Direct match
    const direct = KEY_MAP.get(buf);
    if (direct) return direct;

    // Check for escape sequences
    if (buf.length >= 3 && buf.startsWith("\x1b[")) {
      const seq = KEY_MAP.get(buf);
      if (seq) return seq;
    }

    return null;
  }

  return {
    start() {
      if (active) return;
      active = true;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", handleData);
    },

    stop() {
      if (!active) return;
      active = false;
      process.stdin.removeListener("data", handleData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      if (bufferTimeout) {
        clearTimeout(bufferTimeout);
        bufferTimeout = null;
      }
    },

    get isActive() {
      return active;
    }
  };
}

/**
 * Create a scrollable list state manager.
 *
 * @param {number} totalItems
 * @param {number} visibleHeight
 * @returns {ScrollState}
 */
export function createScrollState(totalItems, visibleHeight) {
  return {
    cursor: 0,
    offset: 0,
    totalItems,
    visibleHeight,

    moveUp() {
      if (this.cursor > 0) {
        this.cursor--;
        if (this.cursor < this.offset) {
          this.offset = this.cursor;
        }
      }
    },

    moveDown() {
      if (this.cursor < this.totalItems - 1) {
        this.cursor++;
        if (this.cursor >= this.offset + this.visibleHeight) {
          this.offset = this.cursor - this.visibleHeight + 1;
        }
      }
    },

    pageUp() {
      this.cursor = Math.max(0, this.cursor - this.visibleHeight);
      this.offset = Math.max(0, this.offset - this.visibleHeight);
    },

    pageDown() {
      this.cursor = Math.min(this.totalItems - 1, this.cursor + this.visibleHeight);
      this.offset = Math.min(
        Math.max(0, this.totalItems - this.visibleHeight),
        this.offset + this.visibleHeight
      );
    },

    goHome() {
      this.cursor = 0;
      this.offset = 0;
    },

    goEnd() {
      this.cursor = this.totalItems - 1;
      this.offset = Math.max(0, this.totalItems - this.visibleHeight);
    },

    resize(newHeight) {
      this.visibleHeight = newHeight;
      this.offset = Math.min(this.offset, Math.max(0, this.totalItems - this.visibleHeight));
    },

    updateTotal(newTotal) {
      this.totalItems = newTotal;
      if (this.cursor >= newTotal) this.cursor = Math.max(0, newTotal - 1);
      this.offset = Math.min(this.offset, Math.max(0, newTotal - this.visibleHeight));
    },

    visibleRange() {
      return {
        start: this.offset,
        end: Math.min(this.offset + this.visibleHeight, this.totalItems)
      };
    }
  };
}
