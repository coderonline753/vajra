/**
 * Vajra CSRF Protection
 * Double-submit cookie pattern (stateless, no session needed).
 */

import type { Middleware } from '../middleware';
import type { CookieOptions } from '../cookie';
import { timingSafeEqual, randomToken } from './utils';

interface CsrfOptions {
  cookie?: string;
  header?: string;
  safeMethods?: string[];
  excludePaths?: string[];
  cookieOptions?: CookieOptions;
  tokenLength?: number;
  errorMessage?: string;
}

export function generateCsrfToken(bytes = 32): string {
  return randomToken(bytes);
}

export function csrf(options: CsrfOptions = {}): Middleware {
  const cookieName = options.cookie ?? '_csrf';
  const headerName = options.header ?? 'x-csrf-token';
  const safeMethods = new Set(options.safeMethods ?? ['GET', 'HEAD', 'OPTIONS']);
  const excludePaths = new Set(options.excludePaths ?? []);
  const tokenLength = options.tokenLength ?? 32;
  const errorMessage = options.errorMessage ?? 'Invalid CSRF token';
  const cookieOpts: CookieOptions = {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    ...options.cookieOptions,
  };

  return async (c, next) => {
    // Skip excluded paths
    if (excludePaths.has(c.path)) {
      return next();
    }

    // Get or generate token
    let token = c.cookie(cookieName);
    if (!token) {
      token = generateCsrfToken(tokenLength);
      c.setCookie(cookieName, token, cookieOpts);
    }

    // Store token in context for templates/responses
    c.set('csrfToken', token);

    // Safe methods skip validation
    if (safeMethods.has(c.method)) {
      return next();
    }

    // Unsafe methods: validate token
    const submittedToken = c.header(headerName);
    if (!submittedToken || !timingSafeEqual(token, submittedToken)) {
      return c.json({ error: errorMessage }, 403);
    }

    return next();
  };
}
