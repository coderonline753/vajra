/**
 * Vajra Error Hierarchy — RSD-Aligned
 *
 * Every error has: code (machine), message (human), statusCode (HTTP), retryable (client hint)
 * Layers: Data → Service → Route, each with its own error types.
 * No framework in the world has architecture-aligned error classes. This is Vajra's.
 *
 * Inspired by: Stripe (code+message+param), Google Cloud (details[]), Go (sentinel errors)
 * What we do different: errors know which RSD layer they belong to.
 */

/* ═══════ BASE ═══════ */

export interface VajraErrorOptions {
  code: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
  details?: unknown;
  cause?: Error;
}

/**
 * Base error class. All Vajra errors extend this.
 * `toJSON()` produces Stripe-style error response — never leaks internals.
 */
export class VajraError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly layer: 'data' | 'service' | 'route' | 'system';

  constructor(opts: VajraErrorOptions, layer: 'data' | 'service' | 'route' | 'system' = 'system') {
    super(opts.message, { cause: opts.cause });
    this.name = 'VajraError';
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.layer = layer;
  }

  /**
   * Safe serialization for API responses.
   * NEVER includes stack trace, file paths, or internal details.
   */
  toJSON(): { success: false; error: Record<string, unknown> } {
    const error: Record<string, unknown> = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) error.details = this.details;
    if (this.retryable) error.retryable = true;
    return { success: false, error };
  }
}

/* ═══════ DATA LAYER ERRORS ═══════ */
/* These originate from database/storage operations. Zero HTTP awareness. */

/** Resource not found in database */
export class NotFoundError extends VajraError {
  constructor(resource: string, id?: string) {
    super({
      code: 'NOT_FOUND',
      message: id ? `${resource} '${id}' not found` : `${resource} not found`,
      statusCode: 404,
    }, 'data');
    this.name = 'NotFoundError';
  }
}

/** Unique constraint, foreign key, or check constraint violation */
export class ConstraintError extends VajraError {
  constructor(message: string, opts?: { cause?: Error }) {
    super({
      code: 'CONSTRAINT_VIOLATION',
      message,
      statusCode: 409,
      cause: opts?.cause,
    }, 'data');
    this.name = 'ConstraintError';
  }
}

/** Database connection lost or unreachable */
export class ConnectionError extends VajraError {
  constructor(message = 'Database connection failed', opts?: { cause?: Error }) {
    super({
      code: 'CONNECTION_ERROR',
      message,
      statusCode: 503,
      retryable: true,
      cause: opts?.cause,
    }, 'data');
    this.name = 'ConnectionError';
  }
}

/** Query took too long */
export class QueryTimeoutError extends VajraError {
  constructor(message = 'Query timed out', opts?: { cause?: Error }) {
    super({
      code: 'QUERY_TIMEOUT',
      message,
      statusCode: 504,
      retryable: true,
      cause: opts?.cause,
    }, 'data');
    this.name = 'QueryTimeoutError';
  }
}

/* ═══════ SERVICE LAYER ERRORS ═══════ */
/* These originate from business logic. Zero HTTP awareness. */

/** Business rule violated (e.g., "Cannot cancel shipped order") */
export class BusinessError extends VajraError {
  constructor(message: string, opts?: { code?: string; statusCode?: number; details?: unknown; cause?: Error }) {
    super({
      code: opts?.code ?? 'BUSINESS_RULE_VIOLATION',
      message,
      statusCode: opts?.statusCode ?? 422,
      details: opts?.details,
      cause: opts?.cause,
    }, 'service');
    this.name = 'BusinessError';
  }
}

/** User does not have permission for this action */
export class PermissionError extends VajraError {
  constructor(message = 'You do not have permission to perform this action') {
    super({
      code: 'PERMISSION_DENIED',
      message,
      statusCode: 403,
    }, 'service');
    this.name = 'PermissionError';
  }
}

/** Too many requests */
export class RateLimitError extends VajraError {
  readonly retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number) {
    super({
      code: 'RATE_LIMITED',
      message,
      statusCode: 429,
      retryable: true,
      details: retryAfter ? { retryAfter } : undefined,
    }, 'service');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** External API/service failed (e.g., payment provider, email service) */
export class ExternalServiceError extends VajraError {
  constructor(service: string, message?: string, opts?: { cause?: Error }) {
    super({
      code: 'EXTERNAL_SERVICE_ERROR',
      message: message ?? `${service} service unavailable`,
      statusCode: 502,
      retryable: true,
      cause: opts?.cause,
    }, 'service');
    this.name = 'ExternalServiceError';
  }
}

/** Resource already exists (e.g., duplicate email) */
export class ConflictError extends VajraError {
  constructor(message: string, opts?: { details?: unknown }) {
    super({
      code: 'CONFLICT',
      message,
      statusCode: 409,
      details: opts?.details,
    }, 'service');
    this.name = 'ConflictError';
  }
}

/* ═══════ ROUTE LAYER ERRORS ═══════ */
/* These originate from request handling. HTTP-aware. */

/** Request validation failed (Zod, field-level errors) */
export class ValidationError extends VajraError {
  constructor(fields: Record<string, string[]> | Array<{ field: string; message: string }>) {
    const details = Array.isArray(fields)
      ? { fields }
      : { fields: Object.entries(fields).map(([field, messages]) => ({ field, message: messages[0] })) };

    super({
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      statusCode: 400,
      details,
    }, 'route');
    this.name = 'ValidationError';
  }
}

/** Authentication required or session expired */
export class AuthError extends VajraError {
  constructor(message = 'Authentication required', code = 'AUTH_REQUIRED') {
    super({
      code,
      message,
      statusCode: 401,
    }, 'route');
    this.name = 'AuthError';
  }
}

/** Payload too large */
export class PayloadTooLargeError extends VajraError {
  constructor(maxSize?: number) {
    super({
      code: 'PAYLOAD_TOO_LARGE',
      message: maxSize ? `Payload exceeds ${maxSize} bytes` : 'Payload too large',
      statusCode: 413,
    }, 'route');
    this.name = 'PayloadTooLargeError';
  }
}

/* ═══════ BACKWARD COMPATIBILITY ═══════ */

/**
 * @deprecated Use VajraError or its subclasses instead.
 * Kept for backward compatibility with existing code.
 */
export class HttpError extends VajraError {
  constructor(statusCode: number, message: string) {
    super({ code: 'HTTP_ERROR', message, statusCode }, 'system');
    this.name = 'HttpError';
  }
}
