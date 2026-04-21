/**
 * Vajra Input Sanitization
 * XSS, SQL injection, path traversal, NoSQL injection detection.
 * Both middleware and standalone utility functions.
 */

import type { Context } from '../context';
import type { Middleware } from '../middleware';

export interface SanitizeViolation {
  type: 'xss' | 'sql-injection' | 'path-traversal' | 'nosql-injection';
  field: string;
  value: string;
  input: 'body' | 'query' | 'params';
}

interface SanitizeOptions {
  xss?: boolean;
  sqlInjection?: boolean | 'warn' | 'block';
  pathTraversal?: boolean;
  noSqlInjection?: boolean;
  targets?: ('body' | 'query' | 'params')[];
  onViolation?: (c: Context, violation: SanitizeViolation) => Response | void;
}

// XSS patterns
const XSS_PATTERNS = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  /<object\b[^>]*>[\s\S]*?<\/object>/gi,
  /<embed\b[^>]*\/?>/gi,
  /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
  /\bon\w+\s*=\s*["'][^"']*["']/gi,
  /\bon\w+\s*=\s*[^\s>]+/gi,
  /javascript\s*:/gi,
  /data\s*:\s*text\/html/gi,
  /vbscript\s*:/gi,
  /expression\s*\(/gi,
];

// SQL injection patterns (structural, not just quotes)
const SQL_PATTERNS = [
  /'\s*(OR|AND)\s+['"\d]/i,
  /'\s*;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|EXEC)\s/i,
  /UNION\s+(ALL\s+)?SELECT/i,
  /;\s*(DROP|DELETE|TRUNCATE)\s+TABLE/i,
  /EXEC\s*\(/i,
  /xp_cmdshell/i,
  /--\s*$/m,
  /\/\*[\s\S]*?\*\//,
  /'\s*(=|<|>|!=)\s*'/,
  /\bSLEEP\s*\(/i,
  /\bBENCHMARK\s*\(/i,
  /\bWAITFOR\s+DELAY/i,
];

// Path traversal patterns
const PATH_PATTERNS = [
  /\.\.\//,
  /\.\.\\/,
  /%2e%2e/i,
  /%2e%2e%2f/i,
  /%2e%2e%5c/i,
  /%00/,
  /\0/,
];

/** Strip XSS patterns from a string */
export function sanitizeXss(input: string): string {
  let result = input;
  for (const pattern of XSS_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

/** Detect SQL injection patterns */
export function detectSqlInjection(input: string): boolean {
  for (const pattern of SQL_PATTERNS) {
    if (pattern.test(input)) return true;
  }
  return false;
}

/** Detect path traversal patterns */
export function detectPathTraversal(input: string): boolean {
  for (const pattern of PATH_PATTERNS) {
    if (pattern.test(input)) return true;
  }
  return false;
}

/** Detect NoSQL injection (MongoDB operators) */
export function detectNoSqlInjection(input: unknown): boolean {
  if (typeof input === 'string') {
    return /^\$/.test(input.trim());
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(input as Record<string, unknown>)) {
      if (key.startsWith('$')) return true;
      if (detectNoSqlInjection((input as Record<string, unknown>)[key])) return true;
    }
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (detectNoSqlInjection(item)) return true;
    }
  }
  return false;
}

function scanValue(
  value: unknown,
  field: string,
  inputSource: 'body' | 'query' | 'params',
  options: SanitizeOptions
): SanitizeViolation | null {
  if (typeof value === 'string') {
    if (options.xss !== false) {
      const sanitized = sanitizeXss(value);
      if (sanitized !== value) {
        return { type: 'xss', field, value, input: inputSource };
      }
    }

    const sqlMode = options.sqlInjection ?? 'block';
    if (sqlMode !== false && detectSqlInjection(value)) {
      return { type: 'sql-injection', field, value, input: inputSource };
    }

    if (options.pathTraversal !== false && detectPathTraversal(value)) {
      return { type: 'path-traversal', field, value, input: inputSource };
    }
  }

  if (options.noSqlInjection !== false && typeof value === 'object' && value !== null) {
    if (detectNoSqlInjection(value)) {
      return { type: 'nosql-injection', field, value: JSON.stringify(value), input: inputSource };
    }
  }

  return null;
}

function scanObject(
  obj: Record<string, unknown>,
  inputSource: 'body' | 'query' | 'params',
  options: SanitizeOptions,
  prefix = ''
): SanitizeViolation | null {
  for (const [key, value] of Object.entries(obj)) {
    const field = prefix ? `${prefix}.${key}` : key;

    const violation = scanValue(value, field, inputSource, options);
    if (violation) return violation;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = scanObject(value as Record<string, unknown>, inputSource, options, field);
      if (nested) return nested;
    }
  }
  return null;
}

export function sanitize(options: SanitizeOptions = {}): Middleware {
  const targets = new Set(options.targets ?? ['body', 'query', 'params']);
  const sqlMode = options.sqlInjection ?? 'block';

  return async (c, next) => {
    // Scan params
    if (targets.has('params')) {
      const violation = scanObject(c.params, 'params', options);
      if (violation) {
        if (options.onViolation) {
          const res = options.onViolation(c, violation);
          if (res) return res;
        }
        if (sqlMode === 'warn' && violation.type === 'sql-injection') {
          console.warn(`[Vajra Sanitize] ${violation.type} in ${violation.input}.${violation.field}`);
        } else {
          return c.json({ error: 'Bad Request', violation: { type: violation.type, field: violation.field } }, 400);
        }
      }
    }

    // Scan query
    if (targets.has('query')) {
      const violation = scanObject(c.queries as Record<string, unknown>, 'query', options);
      if (violation) {
        if (options.onViolation) {
          const res = options.onViolation(c, violation);
          if (res) return res;
        }
        if (sqlMode === 'warn' && violation.type === 'sql-injection') {
          console.warn(`[Vajra Sanitize] ${violation.type} in ${violation.input}.${violation.field}`);
        } else {
          return c.json({ error: 'Bad Request', violation: { type: violation.type, field: violation.field } }, 400);
        }
      }
    }

    // Scan body
    if (targets.has('body') && ['POST', 'PUT', 'PATCH'].includes(c.method)) {
      try {
        const body = await c.body();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const violation = scanObject(body as Record<string, unknown>, 'body', options);
          if (violation) {
            if (options.onViolation) {
              const res = options.onViolation(c, violation);
              if (res) return res;
            }
            if (sqlMode === 'warn' && violation.type === 'sql-injection') {
              console.warn(`[Vajra Sanitize] ${violation.type} in ${violation.input}.${violation.field}`);
            } else {
              return c.json({ error: 'Bad Request', violation: { type: violation.type, field: violation.field } }, 400);
            }
          }
        }
      } catch {
        // Body parsing failed, let the handler deal with it
      }
    }

    return next();
  };
}
