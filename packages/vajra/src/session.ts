/**
 * Vajra Session Module
 * Session middleware with signed cookies + pluggable stores (memory, Redis, signed-cookie).
 *
 * const store = createMemorySessionStore();
 * app.use(session({ secret: 'my-secret', store }));
 *
 * app.get('/profile', async (ctx) => {
 *   const session = ctx.get('session');
 *   session.userId = 42;
 *   return ctx.json({ ok: true });
 * });
 */

import type { Context } from './context';
import type { Middleware } from './middleware';
import { serializeCookie, type CookieOptions } from './cookie';

/* ═════════════ TYPES ═════════════ */

export interface SessionData {
  [key: string]: unknown;
}

export interface SessionOptions {
  /** HMAC signing secret (required) */
  secret: string;
  /** Cookie name. Default: 'vajra.sid' */
  name?: string;
  /** Session lifetime in seconds. Default: 86400 (24h) */
  maxAge?: number;
  /** Session store. Default: in-memory */
  store?: SessionStore;
  /** Cookie options override */
  cookie?: Omit<CookieOptions, 'maxAge'>;
  /** Rolling expiry: refresh cookie on every request. Default: true */
  rolling?: boolean;
  /** Skip session for these paths (exact or prefix match) */
  skipPaths?: string[];
}

export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, ttlSeconds: number): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Optional cleanup hook (for in-memory stores with expiry) */
  cleanup?(): Promise<void>;
}

export interface SessionHandle extends SessionData {
  /** Generate a new session ID (useful after login for session fixation defence) */
  regenerate(): Promise<void>;
  /** Destroy the session and clear cookie */
  destroy(): Promise<void>;
  /** Save current session state (usually automatic on response) */
  save(): Promise<void>;
  /** Underlying session ID */
  readonly id: string;
}

/* ═════════════ HMAC SIGNING ═════════════ */

const SIG_ALG = 'SHA-256';

async function hmacSign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: SIG_ALG },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, value: string, signature: string): Promise<boolean> {
  const expected = await hmacSign(secret, value);
  return constantTimeEqual(expected, signature);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(buf: Uint8Array): string {
  let bin = '';
  for (const byte of buf) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sign(value: string, secret: string): Promise<string> {
  const sig = await hmacSign(secret, value);
  return `${value}.${sig}`;
}

export async function unsign(signed: string, secret: string): Promise<string | null> {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const ok = await hmacVerify(secret, value, sig);
  return ok ? value : null;
}

/* ═════════════ STORES ═════════════ */

export function createMemorySessionStore(): SessionStore {
  const store = new Map<string, { data: SessionData; expiresAt: number }>();

  return {
    async get(id) {
      const entry = store.get(id);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(id);
        return null;
      }
      return entry.data;
    },
    async set(id, data, ttlSeconds) {
      store.set(id, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async destroy(id) {
      store.delete(id);
    },
    async cleanup() {
      const now = Date.now();
      for (const [id, entry] of store.entries()) {
        if (entry.expiresAt < now) store.delete(id);
      }
    },
  };
}

export interface RedisSessionClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function createRedisSessionStore(client: RedisSessionClient, keyPrefix = 'vajra:sess:'): SessionStore {
  return {
    async get(id) {
      const raw = await client.get(keyPrefix + id);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async set(id, data, ttlSeconds) {
      await client.set(keyPrefix + id, JSON.stringify(data), { EX: ttlSeconds });
    },
    async destroy(id) {
      await client.del(keyPrefix + id);
    },
  };
}

/* ═════════════ MIDDLEWARE ═════════════ */

export function session(options: SessionOptions): Middleware {
  const name = options.name ?? 'vajra.sid';
  const maxAge = options.maxAge ?? 86400;
  const store = options.store ?? createMemorySessionStore();
  const rolling = options.rolling !== false;
  const skipPaths = options.skipPaths ?? [];

  return async (ctx: Context, next) => {
    if (skipPaths.some((p) => ctx.path === p || ctx.path.startsWith(p + '/'))) {
      await next();
      return;
    }

    const cookieValue = ctx.cookie(name);
    let id: string | null = null;
    let data: SessionData = {};
    let isNew = true;

    if (cookieValue) {
      const unsigned = await unsign(cookieValue, options.secret);
      if (unsigned) {
        const stored = await store.get(unsigned);
        if (stored) {
          id = unsigned;
          data = stored;
          isNew = false;
        }
      }
    }

    if (!id) id = randomId();

    let destroyed = false;

    const handle = data as SessionHandle;
    Object.defineProperty(handle, 'id', {
      get: () => id!,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(handle, 'regenerate', {
      value: async () => {
        await store.destroy(id!);
        id = randomId();
        isNew = true;
      },
      enumerable: false,
    });
    Object.defineProperty(handle, 'destroy', {
      value: async () => {
        await store.destroy(id!);
        destroyed = true;
        for (const k of Object.keys(handle)) {
          delete (handle as SessionData)[k];
        }
      },
      enumerable: false,
    });
    Object.defineProperty(handle, 'save', {
      value: async () => {
        if (!destroyed) await store.set(id!, extractData(handle), maxAge);
      },
      enumerable: false,
    });

    ctx.set('session', handle);

    await next();

    if (destroyed) {
      ctx.setCookie(name, '', { ...options.cookie, maxAge: 0 });
      return;
    }

    const dataChanged = isNew || hasData(handle);
    if (dataChanged || rolling) {
      await store.set(id, extractData(handle), maxAge);
      const signed = await sign(id, options.secret);
      ctx.setCookie(name, signed, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        ...options.cookie,
        maxAge,
      });
    }
  };
}

function extractData(handle: SessionHandle): SessionData {
  const data: SessionData = {};
  // Object.entries only returns enumerable properties, so the hidden methods are skipped
  for (const [k, v] of Object.entries(handle)) {
    if (typeof v === 'function') continue;
    data[k] = v;
  }
  return data;
}

function hasData(handle: SessionHandle): boolean {
  return Object.keys(handle).length > 0;
}

/* ═════════════ CSRF SYNC TOKEN HELPERS ═════════════ */

/**
 * Generate a CSRF sync token bound to the session ID.
 * Call on safe requests (GET). Send in response and require on unsafe requests.
 */
export async function csrfSyncToken(sessionId: string, secret: string): Promise<string> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${sessionId}.${nonce}.${Date.now()}`;
  return await sign(payload, secret);
}

export async function csrfSyncVerify(token: string, sessionId: string, secret: string, maxAgeMs = 3600_000): Promise<boolean> {
  const unsigned = await unsign(token, secret);
  if (!unsigned) return false;
  const parts = unsigned.split('.');
  if (parts.length !== 3) return false;
  const [sid, , tsStr] = parts;
  if (sid !== sessionId) return false;
  const ts = parseInt(tsStr!, 10);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > maxAgeMs) return false;
  return true;
}
