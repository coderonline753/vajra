/**
 * Vajra Middleware Pipeline
 * Onion model: each middleware wraps the next.
 */

import type { Context } from './context';

export type Handler = (c: Context) => Response | Promise<Response>;
export type Next = () => Promise<Response>;
export type Middleware = (c: Context, next: Next) => Response | Promise<Response>;

/** Compose middleware stack into a single handler (safe default with double-next detection) */
export function compose(middlewares: Middleware[], finalHandler: Handler): Handler {
  return async (c: Context): Promise<Response> => {
    let index = -1;

    const dispatch = async (i: number): Promise<Response> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;

      if (i < middlewares.length) {
        const mw = middlewares[i];
        return mw(c, () => dispatch(i + 1));
      }

      return finalHandler(c);
    };

    return dispatch(0);
  };
}

/**
 * Compose middleware stack with a single shared `next` closure per request.
 *
 * Optimization notes:
 *   - One `next` closure allocated per request, shared across the chain,
 *     vs. N inline `() => dispatch(i+1)` closures in `compose()`. For a
 *     4-middleware stack this saves ~3 closure allocations per request.
 *   - No `index <= lastIndex` safety check. Assumes well-formed middleware
 *     (stability contract rule 4: no second next() call).
 *   - Fast-path when middlewares.length === 0 returns the handler directly.
 *
 * Measured effect in isolation (wrk, Bun 1.3.12, 4 middleware stack):
 *   compose()        ≈ 63-65K RPS
 *   composeOptimized ≈ 62-64K RPS
 *   Difference is within run-to-run noise. The real win of this flag shows
 *   up when combined with Request object pooling (v1.2 Task #14) and WASM
 *   fast paths (v1.2 Task #15-16), where per-request allocation reduction
 *   compounds across the whole pipeline. Shipped under the same
 *   `optimize: true` flag so all three optimizations turn on together.
 *
 * Behavior parity with `compose()`:
 *   - Same ordering (FIFO onion)
 *   - Same response shape, headers, and status
 *   - Difference: a second next() call silently re-enters the next layer
 *     instead of throwing "next() called multiple times"
 *
 * Opt-in via `new Vajra({ optimize: true })` in v1.2.0; becomes default in
 * v1.2.1 after field validation.
 */
export function composeOptimized(middlewares: Middleware[], finalHandler: Handler): Handler {
  if (middlewares.length === 0) return finalHandler;

  const n = middlewares.length;
  const mws = middlewares;
  const fh = finalHandler;

  return async (c: Context): Promise<Response> => {
    let i = 0;
    const next: Next = async () => {
      if (i >= n) return fh(c);
      const mw = mws[i++];
      return mw(c, next);
    };
    return next();
  };
}

/** Built-in CORS middleware */
export function cors(options: {
  origin?: string | string[];
  methods?: string[];
  headers?: string[];
  credentials?: boolean;
  maxAge?: number;
} = {}): Middleware {
  const origin = options.origin ?? '*';
  const methods = (options.methods ?? ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).join(', ');
  const headers = (options.headers ?? ['Content-Type', 'Authorization']).join(', ');
  const credentials = options.credentials ?? false;
  const maxAge = options.maxAge ?? 86400;

  return async (c, next) => {
    const reqOrigin = c.header('origin') || '';

    let allowOrigin: string;
    if (Array.isArray(origin)) {
      allowOrigin = origin.includes(reqOrigin) ? reqOrigin : '';
    } else {
      allowOrigin = origin;
    }

    // CORS spec: wildcard '*' cannot be used with credentials
    if (credentials && allowOrigin === '*') {
      allowOrigin = reqOrigin || '*';
    }

    if (c.method === 'OPTIONS') {
      const h = new Headers();
      h.set('access-control-allow-origin', allowOrigin);
      h.set('access-control-allow-methods', methods);
      h.set('access-control-allow-headers', headers);
      h.set('access-control-max-age', String(maxAge));
      if (credentials) h.set('access-control-allow-credentials', 'true');
      return new Response(null, { status: 204, headers: h });
    }

    const res = await next();
    res.headers.set('access-control-allow-origin', allowOrigin);
    if (credentials) res.headers.set('access-control-allow-credentials', 'true');
    return res;
  };
}

/** Built-in logger middleware */
export function logger(): Middleware {
  return async (c, next) => {
    const start = performance.now();
    const res = await next();
    const ms = (performance.now() - start).toFixed(2);
    const status = res.status;
    const method = c.method;
    const path = c.path;
    console.log(`${method} ${path} ${status} ${ms}ms`);
    return res;
  };
}

/** Built-in timing middleware (adds Server-Timing header) */
export function timing(): Middleware {
  return async (c, next) => {
    const start = performance.now();
    const res = await next();
    const ms = (performance.now() - start).toFixed(2);
    res.headers.set('server-timing', `total;dur=${ms}`);
    return res;
  };
}

/** Built-in security headers */
export function secureHeaders(): Middleware {
  return async (_c, next) => {
    const res = await next();
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('x-frame-options', 'DENY');
    res.headers.set('x-xss-protection', '0');
    res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!res.headers.has('content-security-policy')) {
      res.headers.set('content-security-policy', "default-src 'self'");
    }
    return res;
  };
}
