/**
 * Vajra Content-Type Validation
 * Ensures request Content-Type matches what the route expects.
 * Prevents attackers from sending XML/HTML to JSON endpoints.
 */

import type { Middleware } from '../middleware';

type AllowedType = 'json' | 'form' | 'multipart' | 'text' | 'xml';

const TYPE_MAP: Record<AllowedType, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  text: 'text/plain',
  xml: 'application/xml',
};

/**
 * Validate that the request Content-Type matches the expected type(s).
 * Only applies to methods with a body (POST, PUT, PATCH).
 *
 * @example
 *   app.post('/api/users', contentType('json'), handler)
 *   app.post('/upload', contentType(['json', 'multipart']), handler)
 */
export function contentType(allowed: AllowedType | AllowedType[]): Middleware {
  const types = Array.isArray(allowed) ? allowed : [allowed];
  const expectedMimes = types.map(t => TYPE_MAP[t]);

  return async (c, next) => {
    // Only validate methods that have a body
    if (!['POST', 'PUT', 'PATCH'].includes(c.method)) {
      return next();
    }

    const ct = c.req.headers.get('content-type') || '';

    // Check if any expected type matches
    const matches = expectedMimes.some(mime => ct.includes(mime));

    if (!matches) {
      const expected = types.join(', ');
      return c.json({
        error: 'Unsupported Media Type',
        message: `Expected Content-Type: ${expected}. Received: ${ct || 'none'}`,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      }, 415);
    }

    return next();
  };
}
