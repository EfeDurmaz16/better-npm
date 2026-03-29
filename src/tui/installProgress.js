/**
 * Install progress TUI.
 *
 * Lightweight animated spinner + phase progress bar written to stderr.
 * Falls back to plain line logging when stderr is not a TTY or when
 * the --json flag is active.
 *
 * Usage:
 *   const bar = createInstallProgress({ json: false });
 *   bar.phase("resolve");
 *   bar.tick("resolving lodash@4.17.21");
 *   bar.phase("fetch", { total: 120 });
 *   bar.advance(1);          // call after each package fetched
 *   bar.done({ totalMs: 1234 });
 */

// ANSI helpers — no external deps
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const CLEAR_LINE = `${ESC}2K`;
const CURSOR_UP = (n = 1) => `${ESC}${n}A`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CR = "\r";

const FG = {
  gray: `${ESC}90m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  white: `${ESC}37m`,
  brightGreen: `${ESC}92m`,
  brightCyan: `${ESC}96m`,
  dim: `${ESC}2m`
};
const BOLD = `${ESC}1m`;

// Install phases in order
const PHASES = ["resolve", "fetch", "extract", "link", "bins", "done"];

const PHASE_LABELS = {
  resolve: "Resolving  ",
  fetch: "Fetching   ",
  extract: "Extracting ",
  link: "Linking    ",
  bins: "Bins       ",
  done: "Done       "
};

const PHASE_COLORS = {
  resolve: FG.cyan,
  fetch: FG.yellow,
  extract: FG.yellow,
  link: FG.brightCyan,
  bins: FG.gray,
  done: FG.brightGreen
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function isTTY() {
  return process.stderr.isTTY === true;
}

function cols() {
  return process.stderr.columns || 80;
}

function write(str) {
  process.stderr.write(str);
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderBar(done, total, width) {
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const barW = Math.max(4, width);
  const filled = Math.round(frac * barW);
  const empty = barW - filled;
  const pct = `${Math.round(frac * 100)}%`.padStart(4);
  return (
    FG.gray + "[" +
    FG.brightGreen + "█".repeat(filled) +
    FG.gray + "░".repeat(empty) +
    FG.gray + "]" +
    FG.white + pct + RESET
  );
}

/**
 * Create a progress tracker. Returns a controller object.
 *
 * @param {Object} opts
 * @param {boolean} [opts.json=false]  - suppress all output if true
 * @param {boolean} [opts.silent=false] - suppress all output if true
 * @returns {ProgressController}
 */
export function createInstallProgress(opts = {}) {
  const { json = false, silent = false } = opts;
  const tty = !json && !silent && isTTY();

  let currentPhase = null;
  let phaseTotal = 0;
  let phaseDone = 0;
  let phaseStartMs = Date.now();
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let lastLineCount = 0;
  let sessionStartMs = Date.now();
  let phaseDurations = {};

  function clearLines(n) {
    for (let i = 0; i < n; i++) {
      write(CURSOR_UP(1) + CLEAR_LINE + CR);
    }
    lastLineCount = 0;
  }

  function renderNow() {
    if (!tty || !currentPhase) return;

    const now = Date.now();
    const phaseMs = now - phaseStartMs;
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const phaseColor = PHASE_COLORS[currentPhase] ?? FG.white;
    const phaseLabel = PHASE_LABELS[currentPhase] ?? currentPhase.padEnd(11);
    const termCols = cols();

    // Clear previous render
    clearLines(lastLineCount);

    // Line 1: spinner + phase label + elapsed
    const elapsed = formatMs(phaseMs);
    const line1 =
      phaseColor + BOLD + frame + RESET + " " +
      phaseColor + phaseLabel + RESET +
      FG.gray + " " + elapsed + RESET;

    write(line1 + "\n");
    let lines = 1;

    // Line 2 (optional): progress bar when total is known
    if (phaseTotal > 0) {
      const barWidth = Math.max(10, termCols - 30);
      const bar = renderBar(phaseDone, phaseTotal, barWidth);
      const counter = FG.gray + ` ${phaseDone}/${phaseTotal}` + RESET;
      write("  " + bar + counter + "\n");
      lines++;
    }

    lastLineCount = lines;
    spinnerFrame++;
  }

  function startSpinner() {
    if (!tty) return;
    write(CURSOR_HIDE);
    spinnerTimer = setInterval(renderNow, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (tty) {
      clearLines(lastLineCount);
      write(CURSOR_SHOW);
    }
  }

  // Plain-text fallback (no TTY / JSON mode)
  function plainLog(msg) {
    if (!json && !silent) {
      process.stderr.write(`  ${msg}\n`);
    }
  }

  return {
    /**
     * Advance to a new install phase.
     * @param {string} name - one of PHASES
     * @param {Object} [phaseOpts]
     * @param {number} [phaseOpts.total] - total items (enables progress bar)
     */
    phase(name, phaseOpts = {}) {
      // Record previous phase duration
      if (currentPhase) {
        phaseDurations[currentPhase] = Date.now() - phaseStartMs;
      }

      currentPhase = name;
      phaseTotal = phaseOpts.total ?? 0;
      phaseDone = 0;
      phaseStartMs = Date.now();

      if (!tty) {
        plainLog(`${PHASE_LABELS[name] ?? name}…`);
      } else {
        // Trigger immediate render
        renderNow();
      }
    },

    /**
     * Show a sub-message within the current phase (TTY: updates spinner line,
     * non-TTY: prints a dim line).
     */
    tick(msg) {
      if (!tty) {
        // Only show in debug / verbose environments — suppress by default
        return;
      }
      // On TTY the spinner refresh handles display; nothing extra needed.
      void msg;
    },

    /**
     * Increment the done counter for the current phase (for progress bar).
     * @param {number} [n=1]
     */
    advance(n = 1) {
      phaseDone += n;
    },

    /**
     * Finish all phases and print a summary line.
     * @param {Object} [summary]
     * @param {number} [summary.totalMs]
     * @param {number} [summary.packages]
     * @param {boolean} [summary.cacheHit]
     */
    done(summary = {}) {
      if (currentPhase) {
        phaseDurations[currentPhase] = Date.now() - phaseStartMs;
      }

      stopSpinner();

      const totalMs = summary.totalMs ?? (Date.now() - sessionStartMs);
      const pkgs = summary.packages;
      const cacheHit = summary.cacheHit === true;

      if (!json && !silent) {
        const parts = [];
        if (cacheHit) {
          parts.push(FG.brightGreen + BOLD + "✔ cache hit" + RESET);
        } else {
          parts.push(FG.brightGreen + BOLD + "✔ done" + RESET);
        }
        if (pkgs != null) {
          parts.push(FG.gray + `${pkgs} packages` + RESET);
        }
        parts.push(FG.gray + formatMs(totalMs) + RESET);

        // Phase breakdown (compact)
        const phaseList = PHASES.filter(p => p !== "done" && phaseDurations[p] != null);
        if (phaseList.length > 1) {
          const breakdown = phaseList
            .map(p => FG.dim + (PHASE_LABELS[p] ?? p).trim() + " " + formatMs(phaseDurations[p]) + RESET)
            .join(FG.gray + " · " + RESET);
          process.stderr.write("  " + breakdown + "\n");
        }

        process.stderr.write("  " + parts.join(FG.gray + " · " + RESET) + "\n");
      }
    },

    /**
     * Signal an error. Stops spinner and optionally prints a message.
     */
    error(msg) {
      stopSpinner();
      if (!json && !silent && msg) {
        process.stderr.write(`  \x1b[31m✖ ${msg}\x1b[0m\n`);
      }
    },

    /** Stop spinner without printing summary (e.g. JSON mode handoff). */
    stop() {
      stopSpinner();
    }
  };
}
