export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  ts: string; // ISO timestamp
  level: LogLevel;
  msg: string;
  [key: string]: unknown; // Additional context
}

export interface LoggerOptions {
  level: LogLevel;
  json: boolean; // If false, use human-readable format
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export class Logger {
  private level: LogLevel;
  private json: boolean;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.json = options.json;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  private formatMessage(level: LogLevel, msg: string, context?: Record<string, unknown>): string {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...context,
    };

    if (this.json) {
      return JSON.stringify(entry);
    }

    // Human-readable format
    const levelStr = level.toUpperCase().padEnd(5);
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${entry.ts}] ${levelStr} ${msg}${contextStr}`;
  }

  private write(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const formatted = this.formatMessage(level, msg, context);
    process.stderr.write(formatted + '\n');
  }

  debug(msg: string, context?: Record<string, unknown>): void {
    this.write('debug', msg, context);
  }

  info(msg: string, context?: Record<string, unknown>): void {
    this.write('info', msg, context);
  }

  warn(msg: string, context?: Record<string, unknown>): void {
    this.write('warn', msg, context);
  }

  error(msg: string, context?: Record<string, unknown>): void {
    this.write('error', msg, context);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setJson(json: boolean): void {
    this.json = json;
  }

  // Create a child logger with additional context
  child(context: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, context);
  }

  // Time an operation
  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      this.debug(`${label} completed`, { durationMs: Math.round(duration) });
    };
  }
}

class ChildLogger {
  constructor(
    private parent: Logger,
    private context: Record<string, unknown>
  ) {}

  debug(msg: string, context?: Record<string, unknown>): void {
    this.parent.debug(msg, { ...this.context, ...context });
  }

  info(msg: string, context?: Record<string, unknown>): void {
    this.parent.info(msg, { ...this.context, ...context });
  }

  warn(msg: string, context?: Record<string, unknown>): void {
    this.parent.warn(msg, { ...this.context, ...context });
  }

  error(msg: string, context?: Record<string, unknown>): void {
    this.parent.error(msg, { ...this.context, ...context });
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

export function createLogger(options: LoggerOptions): Logger {
  globalLogger = new Logger(options);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    // Default logger for early use
    globalLogger = new Logger({ level: 'info', json: false });
  }
  return globalLogger;
}

// Convenience exports
export const logger = {
  debug: (msg: string, context?: Record<string, unknown>) => getLogger().debug(msg, context),
  info: (msg: string, context?: Record<string, unknown>) => getLogger().info(msg, context),
  warn: (msg: string, context?: Record<string, unknown>) => getLogger().warn(msg, context),
  error: (msg: string, context?: Record<string, unknown>) => getLogger().error(msg, context),
};
