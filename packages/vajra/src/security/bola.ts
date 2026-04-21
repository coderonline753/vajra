/**
 * Vajra BOLA Protection
 * Broken Object Level Authorization — #1 OWASP API vulnerability.
 * Declarative route-level ownership checks.
 */

import type { Context } from '../context';
import type { Middleware } from '../middleware';

interface BolaOptions {
  ownerParam: string;
  userKey?: string;
  userExtractor?: (c: Context) => string | Promise<string>;
  adminBypass?: (c: Context) => boolean | Promise<boolean>;
  errorMessage?: string;
  onDenied?: (c: Context) => Response | Promise<Response>;
}

export function bola(options: BolaOptions): Middleware {
  const { ownerParam, errorMessage = 'Forbidden: access denied', onDenied } = options;

  return async (c, next) => {
    // Extract resource owner ID from route params
    const resourceOwnerId = c.param(ownerParam);
    if (!resourceOwnerId) {
      return c.json({ error: errorMessage }, 403);
    }

    // Check admin bypass first
    if (options.adminBypass) {
      const isAdmin = await options.adminBypass(c);
      if (isAdmin) return next();
    }

    // Extract authenticated user ID
    let userId: string;
    if (options.userExtractor) {
      userId = await options.userExtractor(c);
    } else {
      const key = options.userKey ?? 'userId';
      // Try direct context key first
      const directValue = c.get<string>(key);
      if (directValue) {
        userId = String(directValue);
      } else {
        // Try JWT payload
        const jwtPayload = c.get<Record<string, unknown>>('jwtPayload');
        if (jwtPayload && jwtPayload[key] !== undefined) {
          userId = String(jwtPayload[key]);
        } else {
          // No authenticated user found
          if (onDenied) return onDenied(c);
          return c.json({ error: errorMessage }, 403);
        }
      }
    }

    // Compare (both as strings)
    if (String(userId) !== String(resourceOwnerId)) {
      if (onDenied) return onDenied(c);
      return c.json({ error: errorMessage }, 403);
    }

    return next();
  };
}
