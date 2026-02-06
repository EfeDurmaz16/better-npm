const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const REDACT_KEYS = ["token", "secret", "password", "auth", "apikey", "api_key", "credential"];

let globalLevel = "info";
let globalContext = {};

function normalizeLevel(value) {
  if (typeof value !== "string") return "info";
  const lowered = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, lowered) ? lowered : "info";
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[globalLevel];
}

function isSensitiveKey(key) {
  const lowered = String(key).toLowerCase();
  return REDACT_KEYS.some((needle) => lowered.includes(needle));
}

function sanitize(value, depth = 0) {
  if (depth > 4) return "[Truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value
      .replace(/([?&](?:token|auth|password|apikey|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/(\/\/[^/\s:@]+:)([^@\s/]+)@/g, "$1[REDACTED]@");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? "[REDACTED]" : sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function write(level, msg, fields = {}) {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...globalContext,
    ...sanitize(fields)
  };
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // ignore logging errors
  }
}

export function configureLogger(opts = {}) {
  globalLevel = normalizeLevel(opts.level ?? process.env.BETTER_LOG_LEVEL ?? "info");
  globalContext = sanitize(opts.context ?? {});
}

export function getLogLevel() {
  return globalLevel;
}

export function childLogger(context = {}) {
  const childContext = sanitize(context);
  return {
    debug(msg, fields) {
      write("debug", msg, { ...childContext, ...(fields ?? {}) });
    },
    info(msg, fields) {
      write("info", msg, { ...childContext, ...(fields ?? {}) });
    },
    warn(msg, fields) {
      write("warn", msg, { ...childContext, ...(fields ?? {}) });
    },
    error(msg, fields) {
      write("error", msg, { ...childContext, ...(fields ?? {}) });
    }
  };
}

export const logger = {
  debug(msg, fields) {
    write("debug", msg, fields);
  },
  info(msg, fields) {
    write("info", msg, fields);
  },
  warn(msg, fields) {
    write("warn", msg, fields);
  },
  error(msg, fields) {
    write("error", msg, fields);
  }
};
