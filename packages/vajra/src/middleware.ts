/**
 * Vajra Middleware Pipeline
 * Onion model: each middleware wraps the next.
 */

import type { Context } from './context';

export type Handler = (c: Context) => Response | Promise<Response>;
export type Next = () => Promise<Response>;
export type Middleware = (c: Context, next: Next) => Response | Promise<Response>;

/** Compose middleware stack into a single handler */
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
