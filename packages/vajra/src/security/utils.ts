/**
 * Vajra Security Utilities
 * Shared functions for security modules.
 */

import type { Context } from '../context';

/** Constant-time string comparison to prevent timing attacks */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

/** Extract client IP from request, respecting proxy headers */
export function getClientIp(c: Context, options?: {
  trustProxy?: boolean;
  proxyHeaders?: string[];
}): string {
  const trustProxy = options?.trustProxy ?? true;
  const proxyHeaders = options?.proxyHeaders ?? ['x-forwarded-for', 'x-real-ip'];

  if (trustProxy) {
    for (const header of proxyHeaders) {
      const value = c.header(header);
      if (value) {
        // X-Forwarded-For can be comma-separated, take first (client IP)
        const ip = value.split(',')[0]?.trim();
        if (ip) return ip;
      }
    }
  }

  return 'unknown';
}

/** Generate a cryptographically secure random hex token */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
}
