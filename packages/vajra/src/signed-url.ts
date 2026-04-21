/**
 * Vajra Signed URL Module
 * Generate and verify signed URLs for downloads, uploads, limited access tokens.
 *
 * const signer = createSigner({ secret: process.env.URL_SECRET });
 * const url = await signer.sign('/download/report.pdf', {
 *   expiresIn: 3600,
 *   claims: { userId: 42 },
 * });
 * app.get('/download/*', signer.middleware(), handler);
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import { sign, unsign } from './session';

/* ═════════════ TYPES ═════════════ */

export interface SignOptions {
  /** Expiry in seconds from now. Default: 3600 */
  expiresIn?: number;
  /** HTTP method allowed. Default: 'GET' */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Max uses (0 = unlimited, default). Requires counter store. */
  maxUses?: number;
  /** Extra claims encoded into the signature */
  claims?: Record<string, string | number | boolean>;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'missing' | 'tampered' | 'expired' | 'method' | 'exhausted' | 'path';
  path?: string;
  method?: string;
  expiresAt?: number;
  claims?: Record<string, string | number | boolean>;
}

export interface SignerOptions {
  /** HMAC secret (required) */
  secret: string;
  /** Query parameter for the signature. Default: 'sig' */
  paramName?: string;
  /** Usage counter store for maxUses support (Redis, memory, etc.) */
  usageStore?: UsageStore;
  /** Default expiry (seconds) if not specified per URL. Default: 3600 */
  defaultExpiry?: number;
}

export interface UsageStore {
  /** Returns new usage count after increment */
  increment(token: string, ttlSeconds: number): Promise<number>;
}

export interface Signer {
  /** Generate a signed URL path with query string */
  sign(path: string, options?: SignOptions): Promise<string>;
  /** Verify a signed request (path + query) */
  verify(path: string, query: URLSearchParams, method: string): Promise<VerifyResult>;
  /** Middleware that 403s on invalid signatures */
  middleware(): Middleware;
}

/* ═════════════ FACTORY ═════════════ */

export function createSigner(options: SignerOptions): Signer {
  const paramName = options.paramName ?? 'sig';
  const defaultExpiry = options.defaultExpiry ?? 3600;

  const signUrl: Signer['sign'] = async (path, opts = {}) => {
    const expiresAt = Date.now() + (opts.expiresIn ?? defaultExpiry) * 1000;
    const method = opts.method ?? 'GET';
    const cleanPath = normalizePath(path);
    const maxUses = opts.maxUses ?? 0;
    const claims = opts.claims ?? {};

    const payload = JSON.stringify({
      p: cleanPath,
      m: method,
      e: expiresAt,
      u: maxUses,
      c: claims,
      n: randomNonce(),
    });

    const encoded = base64urlEncode(payload);
    const signed = await sign(encoded, options.secret);

    const query = new URLSearchParams();
    query.set(paramName, signed);
    return `${cleanPath}?${query.toString()}`;
  };

  const verifyUrl: Signer['verify'] = async (path, query, method) => {
    const signedParam = query.get(paramName);
    if (!signedParam) return { valid: false, reason: 'missing' };

    const unsigned = await unsign(signedParam, options.secret);
    if (!unsigned) return { valid: false, reason: 'tampered' };

    let payload: {
      p: string;
      m: string;
      e: number;
      u: number;
      c: Record<string, string | number | boolean>;
      n: string;
    };
    try {
      payload = JSON.parse(base64urlDecode(unsigned));
    } catch {
      return { valid: false, reason: 'tampered' };
    }

    const cleanPath = normalizePath(path);
    if (payload.p !== cleanPath) return { valid: false, reason: 'path' };
    if (payload.m !== method.toUpperCase()) return { valid: false, reason: 'method' };
    if (payload.e < Date.now()) return { valid: false, reason: 'expired', expiresAt: payload.e };

    if (payload.u > 0) {
      if (!options.usageStore) {
        throw new Error('maxUses requires a usageStore');
      }
      const ttl = Math.max(60, Math.ceil((payload.e - Date.now()) / 1000));
      const count = await options.usageStore.increment(signedParam, ttl);
      if (count > payload.u) {
        return { valid: false, reason: 'exhausted' };
      }
    }

    return {
      valid: true,
      path: payload.p,
      method: payload.m,
      expiresAt: payload.e,
      claims: payload.c,
    };
  };

  return {
    sign: signUrl,
    verify: verifyUrl,
    middleware() {
      return async (ctx: Context, next) => {
        const result = await verifyUrl(ctx.path, ctx.url.searchParams, ctx.method);
        if (!result.valid) {
          return new Response(JSON.stringify({ error: 'Invalid signature', reason: result.reason }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        ctx.set('signedUrlClaims', result.claims ?? {});
        await next();
      };
    },
  };
}

/* ═════════════ IN-MEMORY USAGE STORE ═════════════ */

export function createMemoryUsageStore(): UsageStore {
  const counts = new Map<string, { count: number; expiresAt: number }>();

  return {
    async increment(token, ttlSeconds) {
      const now = Date.now();
      let entry = counts.get(token);
      if (!entry || entry.expiresAt < now) {
        entry = { count: 0, expiresAt: now + ttlSeconds * 1000 };
        counts.set(token, entry);
      }
      entry.count++;
      return entry.count;
    },
  };
}

/* ═════════════ REDIS USAGE STORE ═════════════ */

export interface RedisUsageClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export function createRedisUsageStore(client: RedisUsageClient, keyPrefix = 'vajra:url-use:'): UsageStore {
  return {
    async increment(token, ttlSeconds) {
      const key = keyPrefix + token;
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, ttlSeconds);
      return count;
    },
  };
}

/* ═════════════ HELPERS ═════════════ */

function normalizePath(path: string): string {
  // Strip query/hash
  const idx = path.indexOf('?');
  const idx2 = path.indexOf('#');
  let clean = path;
  const cutAt = Math.min(...[idx, idx2].filter((i) => i >= 0), clean.length);
  clean = clean.slice(0, cutAt === Infinity ? clean.length : cutAt);
  // Ensure leading slash
  if (!clean.startsWith('/')) clean = '/' + clean;
  return clean;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - input.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
