/**
 * Vajra Structured Logger
 * JSON output, levels, request context (traceId), sampling.
 *
 * @example
 *   const log = createLogger({ level: 'info' });
 *   log.info('User created', { userId: '123' });
 *   // {"level":"info","msg":"User created","userId":"123","traceId":"abc","ts":"2026-04-14T..."}
 *
 *   app.use(requestLogger(log));
 */

import type { Middleware } from './middleware';
import { getRequestContext, hasRequestContext } from './context-storage';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface LoggerOptions {
  /** Minimum log level. Default: 'info' */
  level?: LogLevel;
  /** Sample rate for info/debug logs (0-1). Default: 1 (log everything) */
  sampleRate?: number;
  /** Custom output function. Default: console.log */
  output?: (line: string) => void;
  /** Include timestamp. Default: true */
  timestamp?: boolean;
  /** Service name for identification */
  service?: string;
}

interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(meta: Record<string, unknown>): Logger;
}

/**
 * Create a structured JSON logger.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_VALUES[options.level || 'info'];
  const sampleRate = options.sampleRate ?? 1;
  const output = options.output ?? ((line: string) => console.log(line));
  const includeTimestamp = options.timestamp !== false;
  const service = options.service;

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>, childMeta?: Record<string, unknown>): void {
    if (LEVEL_VALUES[level] < minLevel) return;

    // Sampling for info/debug
    if ((level === 'info' || level === 'debug') && sampleRate < 1) {
      if (Math.random() > sampleRate) return;
    }

    const entry: Record<string, unknown> = { level, msg };

    if (includeTimestamp) entry.ts = new Date().toISOString();
    if (service) entry.service = service;

    // Include request context (traceId, userId) if available
    if (hasRequestContext()) {
      const traceId = getRequestContext<string>('traceId');
      const userId = getRequestContext<string>('userId');
      if (traceId) entry.traceId = traceId;
      if (userId) entry.userId = userId;
    }

    // Merge child meta
    if (childMeta) Object.assign(entry, childMeta);

    // Merge call-site meta
    if (meta) Object.assign(entry, meta);

    output(JSON.stringify(entry));
  }

  function createLoggerInstance(childMeta?: Record<string, unknown>): Logger {
    return {
      debug: (msg, meta) => log('debug', msg, meta, childMeta),
      info: (msg, meta) => log('info', msg, meta, childMeta),
      warn: (msg, meta) => log('warn', msg, meta, childMeta),
      error: (msg, meta) => log('error', msg, meta, childMeta),
      child: (newMeta) => createLoggerInstance({ ...childMeta, ...newMeta }),
    };
  }

  return createLoggerInstance();
}

/**
 * Request logging middleware. Logs every request with duration and status.
 */
export function requestLogger(logger: Logger, options?: { sampleRate?: number }): Middleware {
  const rate = options?.sampleRate ?? 1;

  return async (c, next) => {
    const start = performance.now();
    const res = await next();
    const duration = performance.now() - start;

    // Sample non-error requests
    if (res.status < 400 && rate < 1 && Math.random() > rate) return res;

    const level: LogLevel = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info';

    logger[level](`${c.method} ${c.path}`, {
      status: res.status,
      duration: Math.round(duration * 100) / 100,
      ip: c.header('x-forwarded-for')?.split(',')[0]?.trim() || c.header('x-real-ip'),
    });

    return res;
  };
}

export type { Logger, LoggerOptions, LogLevel };
