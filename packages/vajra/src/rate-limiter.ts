/**
 * Vajra Rate Limiter
 * Three stores: memory (default), Redis (distributed), custom.
 * Two algorithms: sliding window (simple) and token bucket (SPA-friendly).
 *
 * @example
 *   // In-memory (single process, default)
 *   app.use(rateLimit({ max: 100, window: 60_000 }));
 *
 *   // Redis (distributed, multi-process)
 *   const store = createRedisStore({ url: 'redis://localhost:6379', prefix: 'rl:' });
 *   app.use(rateLimit({ max: 100, window: 60_000, store }));
 *   app.use(tokenBucket({ capacity: 50, refillRate: 3, store }));
 *
 *   // Custom store
 *   app.use(rateLimit({ store: myCustomStore }));
 */

import type { Context } from './context';
import type { Middleware } from './middleware';

/* ═══════ STORE INTERFACE ═══════ */

export interface RateLimitStore {
  /** Increment counter, return { count, resetAt } */
  increment(key: string, window: number): Promise<{ count: number; resetAt: number }>;
  /** Get current state without incrementing */
  get(key: string): Promise<{ count: number; resetAt: number } | null>;
}

export interface TokenBucketStore {
  /** Consume tokens, return { tokens (remaining), allowed, retryAfter } */
  consume(key: string, capacity: number, refillRate: number, cost: number): Promise<{ tokens: number; allowed: boolean; retryAfter: number }>;
}

/* ═══════ MEMORY STORE (Default) ═══════ */

interface WindowEntry {
  count: number;
  resetAt: number;
}

class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, WindowEntry>();
  private timer: ReturnType<typeof setInterval>;

  constructor(cleanupMs: number) {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store) {
        if (now >= entry.resetAt) this.store.delete(key);
      }
    }, cleanupMs);
    if (this.timer.unref) this.timer.unref();
  }

  async increment(key: string, window: number) {
    const now = Date.now();
    let entry = this.store.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + window };
      this.store.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  async get(key: string) {
    return this.store.get(key) ?? null;
  }
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

class MemoryTokenBucketStore implements TokenBucketStore {
  private buckets = new Map<string, Bucket>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private capacity: number, private refillRate: number) {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        const elapsed = (now - bucket.lastRefill) / 1000;
        if (bucket.tokens + elapsed * this.refillRate >= this.capacity) {
          this.buckets.delete(key);
        }
      }
    }, 60_000);
    if (this.timer.unref) this.timer.unref();
  }

  async consume(key: string, capacity: number, refillRate: number, cost: number) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < cost) {
      const retryAfter = Math.ceil((cost - bucket.tokens) / refillRate);
      return { tokens: Math.floor(bucket.tokens), allowed: false, retryAfter };
    }

    bucket.tokens -= cost;
    return { tokens: Math.floor(bucket.tokens), allowed: true, retryAfter: 0 };
  }
}

/* ═══════ REDIS STORE ═══════ */

export interface RedisStoreOptions {
  /** Redis connection URL. Default: redis://localhost:6379 */
  url?: string;
  /** Key prefix. Default: 'vajra:rl:' */
  prefix?: string;
  /** Existing Redis client (ioredis compatible: must have eval/get/del) */
  client?: RedisClient;
}

interface RedisClient {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  quit?(): Promise<unknown>;
}

const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('GET', key)
local count = 0
local resetAt = now + window

if data then
  local parts = cjson.decode(data)
  if now < parts[2] then
    count = parts[1]
    resetAt = parts[2]
  end
end

count = count + 1
redis.call('SET', key, cjson.encode({count, resetAt}), 'PX', window)

return cjson.encode({count, resetAt})
`;

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('GET', key)
local tokens = capacity
local lastRefill = now

if data then
  local parts = cjson.decode(data)
  tokens = parts[1]
  lastRefill = parts[2]
end

local elapsed = (now - lastRefill) / 1000
tokens = math.min(capacity, tokens + elapsed * refillRate)
lastRefill = now

if tokens < cost then
  local retryAfter = math.ceil((cost - tokens) / refillRate)
  redis.call('SET', key, cjson.encode({tokens, lastRefill}), 'EX', math.ceil(capacity / refillRate) + 10)
  return cjson.encode({tokens, 0, retryAfter})
end

tokens = tokens - cost
redis.call('SET', key, cjson.encode({tokens, lastRefill}), 'EX', math.ceil(capacity / refillRate) + 10)
return cjson.encode({tokens, 1, 0})
`;

class RedisRateLimitStore implements RateLimitStore {
  private client: RedisClient;
  private prefix: string;

  constructor(client: RedisClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  async increment(key: string, window: number) {
    const now = Date.now();
    const result = await this.client.eval(
      SLIDING_WINDOW_SCRIPT, 1,
      this.prefix + key, window, 0, now
    ) as string;
    const parsed = JSON.parse(result);
    return { count: parsed[0], resetAt: parsed[1] };
  }

  async get(key: string) {
    const data = await this.client.get(this.prefix + key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    return { count: parsed[0], resetAt: parsed[1] };
  }
}

class RedisTokenBucketStore implements TokenBucketStore {
  private client: RedisClient;
  private prefix: string;

  constructor(client: RedisClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  async consume(key: string, capacity: number, refillRate: number, cost: number) {
    const now = Date.now();
    const result = await this.client.eval(
      TOKEN_BUCKET_SCRIPT, 1,
      this.prefix + key, capacity, refillRate, cost, now
    ) as string;
    const parsed = JSON.parse(result);
    return { tokens: Math.floor(parsed[0]), allowed: parsed[1] === 1, retryAfter: parsed[2] };
  }
}

/** Create a Redis-backed rate limit store for distributed rate limiting */
export function createRedisStore(options: RedisStoreOptions = {}): RateLimitStore & TokenBucketStore {
  const prefix = options.prefix ?? 'vajra:rl:';
  let client: RedisClient;

  if (options.client) {
    client = options.client;
  } else {
    throw new Error('Vajra Redis Rate Limiter: pass your own Redis client via options.client (ioredis compatible). No built-in Redis dependency.');
  }

  const rlStore = new RedisRateLimitStore(client, prefix);
  const tbStore = new RedisTokenBucketStore(client, prefix + 'tb:');

  return {
    increment: (key, window) => rlStore.increment(key, window),
    get: (key) => rlStore.get(key),
    consume: (key, capacity, refillRate, cost) => tbStore.consume(key, capacity, refillRate, cost),
  };
}

/* ═══════ SLIDING WINDOW ═══════ */

interface RateLimitOptions {
  window?: number;
  max?: number;
  keyExtractor?: (c: Context) => string;
  message?: string;
  /** Custom store. Default: in-memory. Use createRedisStore() for distributed. */
  store?: RateLimitStore;
}

export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const window = options.window ?? 60_000;
  const max = options.max ?? 100;
  const keyExtractor = options.keyExtractor ?? defaultKeyExtractor;
  const message = options.message ?? 'Too Many Requests';
  const store = options.store ?? new MemoryRateLimitStore(window);

  return async (c, next) => {
    const key = keyExtractor(c);
    const { count, resetAt } = await store.increment(key, window);
    const remaining = Math.max(0, max - count);
    const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);

    if (count > max) {
      return c
        .setHeader('x-ratelimit-limit', String(max))
        .setHeader('x-ratelimit-remaining', '0')
        .setHeader('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)))
        .setHeader('retry-after', String(retryAfter))
        .json({ success: false, error: { code: 'RATE_LIMITED', message, retryable: true, details: { retryAfter } } }, 429);
    }

    const res = await next();
    res.headers.set('x-ratelimit-limit', String(max));
    res.headers.set('x-ratelimit-remaining', String(remaining));
    res.headers.set('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));
    return res;
  };
}

/* ═══════ TOKEN BUCKET (SPA-friendly) ═══════ */

interface TokenBucketOptions {
  /** Max burst size (bucket capacity). Default: 50 */
  capacity?: number;
  /** Tokens refilled per second. Default: 3 (180/min sustained) */
  refillRate?: number;
  /** Extract rate limit key from request. Default: IP-based */
  keyExtractor?: (c: Context) => string;
  /** Error message on 429 */
  message?: string;
  /** Cost per request. Default: 1. Use function for per-route cost */
  cost?: number | ((c: Context) => number);
  /** Custom store. Default: in-memory. Use createRedisStore() for distributed. */
  store?: TokenBucketStore;
}

export function tokenBucket(options: TokenBucketOptions = {}): Middleware {
  const capacity = options.capacity ?? 50;
  const refillRate = options.refillRate ?? 3;
  const keyExtractor = options.keyExtractor ?? defaultKeyExtractor;
  const message = options.message ?? 'Too Many Requests';
  const cost = options.cost ?? 1;
  const store = options.store ?? new MemoryTokenBucketStore(capacity, refillRate);

  return async (c, next) => {
    const key = keyExtractor(c);
    const requestCost = typeof cost === 'function' ? cost(c) : cost;
    const result = await store.consume(key, capacity, refillRate, requestCost);

    if (!result.allowed) {
      return c
        .setHeader('x-ratelimit-limit', String(capacity))
        .setHeader('x-ratelimit-remaining', '0')
        .setHeader('x-ratelimit-reset', String(Math.ceil(Date.now() / 1000) + result.retryAfter))
        .setHeader('retry-after', String(result.retryAfter))
        .json({ success: false, error: { code: 'RATE_LIMITED', message, retryable: true, details: { retryAfter: result.retryAfter } } }, 429);
    }

    const res = await next();
    res.headers.set('x-ratelimit-limit', String(capacity));
    res.headers.set('x-ratelimit-remaining', String(result.tokens));
    res.headers.set('x-ratelimit-reset', String(
      Math.ceil(Date.now() / 1000 + (capacity - result.tokens) / refillRate)
    ));
    return res;
  };
}

/* ═══════ SHARED ═══════ */

function defaultKeyExtractor(c: Context): string {
  return c.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.header('x-real-ip')
    || 'unknown';
}
