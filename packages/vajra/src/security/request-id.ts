/**
 * Vajra Request ID
 * Adds X-Request-ID header to every response.
 * Essential for tracing, debugging, and security incident investigation.
 */

import type { Middleware } from '../middleware';

interface RequestIdOptions {
  /** Header name. Default: x-request-id */
  header?: string;
  /** Use incoming header if present. Default: true */
  trustProxy?: boolean;
  /** Custom ID generator. Default: crypto.randomUUID() */
  generator?: () => string;
}

export function requestId(options: RequestIdOptions = {}): Middleware {
  const headerName = options.header ?? 'x-request-id';
  const trustProxy = options.trustProxy ?? true;
  const generator = options.generator ?? (() => crypto.randomUUID());

  return async (c, next) => {
    // Use incoming ID if trusted, otherwise generate new
    let id: string;
    if (trustProxy) {
      id = c.req.headers.get(headerName) || generator();
    } else {
      id = generator();
    }

    // Store in context for logging/tracing
    c.set('requestId', id);

    const res = await next();
    res.headers.set(headerName, id);
    return res;
  };
}
