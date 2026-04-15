import { describe, it, expect } from 'bun:test';
import { Vajra, rateLimit, tokenBucket, createRedisStore, type RateLimitStore, type TokenBucketStore } from '../src/index';

/* ═══════ MOCK REDIS CLIENT ═══════ */

function createMockRedis() {
  const data = new Map<string, { value: string; expireAt: number }>();

  return {
    calls: [] as string[],
    async eval(script: string, numkeys: number, ...args: (string | number)[]) {
      this.calls.push('eval');
      const key = String(args[0]);
      const now = Date.now();

      // Detect which script by checking for 'capacity' arg pattern
      if (String(script).includes('capacity')) {
        // Token bucket script
        const capacity = Number(args[1]);
        const refillRate = Number(args[2]);
        const cost = Number(args[3]);
        const ts = Number(args[4]);

        let tokens = capacity;
        let lastRefill = ts;

        const existing = data.get(key);
        if (existing && existing.expireAt > now) {
          const parsed = JSON.parse(existing.value);
          tokens = parsed[0];
          lastRefill = parsed[1];
        }

        const elapsed = (ts - lastRefill) / 1000;
        tokens = Math.min(capacity, tokens + elapsed * refillRate);
        lastRefill = ts;

        if (tokens < cost) {
          const retryAfter = Math.ceil((cost - tokens) / refillRate);
          const ttl = Math.ceil(capacity / refillRate) + 10;
          data.set(key, { value: JSON.stringify([tokens, lastRefill]), expireAt: now + ttl * 1000 });
          return JSON.stringify([tokens, 0, retryAfter]);
        }

        tokens -= cost;
        const ttl = Math.ceil(capacity / refillRate) + 10;
        data.set(key, { value: JSON.stringify([tokens, lastRefill]), expireAt: now + ttl * 1000 });
        return JSON.stringify([tokens, 1, 0]);
      } else {
        // Sliding window script
        const window = Number(args[1]);
        const ts = Number(args[3]);

        let count = 0;
        let resetAt = ts + window;

        const existing = data.get(key);
        if (existing && existing.expireAt > now) {
          const parsed = JSON.parse(existing.value);
          if (ts < parsed[1]) {
            count = parsed[0];
            resetAt = parsed[1];
          }
        }

        count++;
        data.set(key, { value: JSON.stringify([count, resetAt]), expireAt: now + window });
        return JSON.stringify([count, resetAt]);
      }
    },
    async get(key: string) {
      const entry = data.get(key);
      if (!entry || entry.expireAt <= Date.now()) return null;
      return entry.value;
    },
    async del(...keys: string[]) {
      let deleted = 0;
      for (const k of keys) {
        if (data.delete(k)) deleted++;
      }
      return deleted;
    },
  };
}

/* ═══════ SLIDING WINDOW — MEMORY ═══════ */

describe('Rate Limiter (Memory Store)', () => {
  it('allows requests within limit', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 5, window: 60000, keyExtractor: () => 'mem-test-1' }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(200);
    }
  });

  it('blocks requests over limit with 429', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 2, window: 60000, keyExtractor: () => 'mem-test-2' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);

    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
  });

  it('sets rate limit headers', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 10, window: 60000, keyExtractor: () => 'mem-test-3' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
    expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
  });

  it('different keys have separate limits', async () => {
    let currentKey = 'user-a';
    const app = new Vajra();
    app.use(rateLimit({ max: 1, window: 60000, keyExtractor: () => currentKey }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/'));
    expect(res1.status).toBe(200);

    currentKey = 'user-b';
    const res2 = await app.handle(new Request('http://localhost/'));
    expect(res2.status).toBe(200);

    currentKey = 'user-a';
    const res3 = await app.handle(new Request('http://localhost/'));
    expect(res3.status).toBe(429);
  });

  it('uses custom message', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 0, window: 60000, keyExtractor: () => 'msg-test', message: 'Slow down buddy' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    const body = await res.json() as any;
    expect(body.error.message).toBe('Slow down buddy');
  });
});

/* ═══════ TOKEN BUCKET — MEMORY ═══════ */

describe('Token Bucket (Memory Store)', () => {
  it('allows burst requests up to capacity', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 5, refillRate: 1, keyExtractor: () => 'tb-mem-1' }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(200);
    }
  });

  it('blocks when bucket empty', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 2, refillRate: 1, keyExtractor: () => 'tb-mem-2' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);
  });

  it('sets correct headers', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 10, refillRate: 2, keyExtractor: () => 'tb-mem-3' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('9');
  });

  it('supports per-request cost', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 10, refillRate: 1, cost: 5, keyExtractor: () => 'tb-mem-4' }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/'));
    expect(res1.status).toBe(200);

    const res2 = await app.handle(new Request('http://localhost/'));
    expect(res2.status).toBe(200);

    // 10 - 5 - 5 = 0, next should fail
    const res3 = await app.handle(new Request('http://localhost/'));
    expect(res3.status).toBe(429);
  });

  it('supports function cost', async () => {
    const app = new Vajra();
    app.use(tokenBucket({
      capacity: 10,
      refillRate: 1,
      cost: (c) => c.path.includes('/heavy') ? 5 : 1,
      keyExtractor: () => 'tb-mem-5',
    }));
    app.get('/light', (c) => c.text('light'));
    app.get('/heavy', (c) => c.text('heavy'));

    const res1 = await app.handle(new Request('http://localhost/heavy'));
    expect(res1.status).toBe(200);
    // 10 - 5 = 5 remaining

    const res2 = await app.handle(new Request('http://localhost/light'));
    expect(res2.status).toBe(200);
    // 5 - 1 = 4 remaining
  });
});

/* ═══════ SLIDING WINDOW — REDIS ═══════ */

describe('Rate Limiter (Redis Store)', () => {
  it('allows requests within limit using Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });

    const app = new Vajra();
    app.use(rateLimit({ max: 5, window: 60000, store, keyExtractor: () => 'redis-rl-1' }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(200);
    }
    expect(mockRedis.calls.length).toBe(5);
  });

  it('blocks over limit using Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });

    const app = new Vajra();
    app.use(rateLimit({ max: 2, window: 60000, store, keyExtractor: () => 'redis-rl-2' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);

    const body = await res.json() as any;
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('separate keys work independently in Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });
    let key = 'ip-1';

    const app = new Vajra();
    app.use(rateLimit({ max: 1, window: 60000, store, keyExtractor: () => key }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/'));
    expect(res1.status).toBe(200);

    key = 'ip-2';
    const res2 = await app.handle(new Request('http://localhost/'));
    expect(res2.status).toBe(200);
  });

  it('uses custom prefix', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis, prefix: 'myapp:' });

    const app = new Vajra();
    app.use(rateLimit({ max: 10, window: 60000, store, keyExtractor: () => 'test' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    const data = await mockRedis.get('myapp:test');
    expect(data).toBeTruthy();
  });
});

/* ═══════ TOKEN BUCKET — REDIS ═══════ */

describe('Token Bucket (Redis Store)', () => {
  it('allows burst using Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });

    const app = new Vajra();
    app.use(tokenBucket({ capacity: 5, refillRate: 1, store, keyExtractor: () => 'redis-tb-1' }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(200);
    }
  });

  it('blocks when bucket empty in Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });

    const app = new Vajra();
    app.use(tokenBucket({ capacity: 2, refillRate: 1, store, keyExtractor: () => 'redis-tb-2' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);
  });

  it('per-request cost works with Redis', async () => {
    const mockRedis = createMockRedis();
    const store = createRedisStore({ client: mockRedis });

    const app = new Vajra();
    app.use(tokenBucket({ capacity: 10, refillRate: 1, cost: 4, store, keyExtractor: () => 'redis-tb-3' }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/'));
    expect(res1.status).toBe(200); // 10-4=6

    const res2 = await app.handle(new Request('http://localhost/'));
    expect(res2.status).toBe(200); // 6-4=2

    const res3 = await app.handle(new Request('http://localhost/'));
    expect(res3.status).toBe(429); // 2<4 blocked
  });
});

/* ═══════ EDGE CASES ═══════ */

describe('Rate Limiter Edge Cases', () => {
  it('throws if no Redis client provided', () => {
    expect(() => createRedisStore()).toThrow('pass your own Redis client');
  });

  it('defaults work without any options', async () => {
    const app = new Vajra();
    app.use(rateLimit());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('100');
  });

  it('token bucket defaults work without options', async () => {
    const app = new Vajra();
    app.use(tokenBucket());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-limit')).toBe('50');
  });

  it('retry-after header present on 429', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 1, window: 60000, keyExtractor: () => 'retry-test' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('429 response has retryable: true', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 1, refillRate: 1, keyExtractor: () => 'retryable-test' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    const res = await app.handle(new Request('http://localhost/'));
    const body = await res.json() as any;
    expect(body.error.retryable).toBe(true);
    expect(body.error.details.retryAfter).toBeGreaterThan(0);
  });
});
