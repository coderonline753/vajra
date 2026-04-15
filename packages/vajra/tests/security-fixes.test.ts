import { describe, test, expect } from 'bun:test';
import { Vajra } from '../src/vajra';
import { tokenBucket } from '../src/rate-limiter';

describe('Prototype Pollution Protection', () => {
  test('strips __proto__ from JSON body', async () => {
    const app = new Vajra();
    app.post('/test', async (c) => {
      const body = await c.body<any>();
      return c.json({
        hasProto: '__proto__' in body,
        polluted: ({} as any).isAdmin === true,
      });
    });

    const res = await app.handle(new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'test', '__proto__': { isAdmin: true } }),
    }));

    const data = await res.json();
    expect(data.hasProto).toBe(false);
    expect(data.polluted).toBe(false);
  });

  test('strips constructor from JSON body', async () => {
    const app = new Vajra();
    app.post('/test', async (c) => {
      const body = await c.body<any>();
      return c.json({ hasConstructor: 'constructor' in body });
    });

    const res = await app.handle(new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ constructor: { prototype: { isAdmin: true } } }),
    }));

    const data = await res.json();
    expect(data.hasConstructor).toBe(false);
  });

  test('strips __proto__ from nested objects', async () => {
    const app = new Vajra();
    app.post('/test', async (c) => {
      const body = await c.body<any>();
      return c.json({
        nested: body.user,
        polluted: ({} as any).isAdmin === true,
      });
    });

    const res = await app.handle(new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { name: 'test', '__proto__': { isAdmin: true } } }),
    }));

    const data = await res.json();
    expect(data.polluted).toBe(false);
    expect(data.nested.name).toBe('test');
  });

  test('strips __proto__ from form data', async () => {
    const app = new Vajra();
    app.post('/test', async (c) => {
      const body = await c.body<any>();
      return c.json({ hasProto: '__proto__' in body });
    });

    const res = await app.handle(new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '__proto__=polluted&name=test',
    }));

    const data = await res.json();
    expect(data.hasProto).toBe(false);
  });

  test('preserves normal body data', async () => {
    const app = new Vajra();
    app.post('/test', async (c) => {
      const body = await c.body<any>();
      return c.json(body);
    });

    const res = await app.handle(new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Vajra', version: '0.2.0', tags: ['fast', 'secure'] }),
    }));

    const data = await res.json();
    expect(data.name).toBe('Vajra');
    expect(data.version).toBe('0.2.0');
    expect(data.tags).toEqual(['fast', 'secure']);
  });
});

describe('Token Bucket Rate Limiter', () => {
  test('allows requests within capacity', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 5, refillRate: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/test'));
      expect(res.status).toBe(200);
    }
  });

  test('blocks after capacity exhausted', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 3, refillRate: 0.1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // Use up capacity
    for (let i = 0; i < 3; i++) {
      await app.handle(new Request('http://localhost/test'));
    }

    // This should be blocked
    const res = await app.handle(new Request('http://localhost/test'));
    expect(res.status).toBe(429);

    const body = await res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  test('refills tokens over time', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 2, refillRate: 100 })); // Fast refill for test
    app.get('/test', (c) => c.json({ ok: true }));

    // Use up capacity
    await app.handle(new Request('http://localhost/test'));
    await app.handle(new Request('http://localhost/test'));

    // Wait for refill
    await new Promise(r => setTimeout(r, 50));

    // Should have tokens again
    const res = await app.handle(new Request('http://localhost/test'));
    expect(res.status).toBe(200);
  });

  test('sets rate limit headers on success', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 10, refillRate: 1 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.handle(new Request('http://localhost/test'));
    expect(res.headers.get('x-ratelimit-limit')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
  });

  test('supports custom cost per request', async () => {
    const app = new Vajra();
    app.use(tokenBucket({ capacity: 10, refillRate: 1, cost: 5 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // First request costs 5 tokens (10 - 5 = 5 remaining)
    const res1 = await app.handle(new Request('http://localhost/test'));
    expect(res1.status).toBe(200);

    // Second request costs 5 tokens (5 - 5 = 0 remaining)
    const res2 = await app.handle(new Request('http://localhost/test'));
    expect(res2.status).toBe(200);

    // Third request: not enough tokens
    const res3 = await app.handle(new Request('http://localhost/test'));
    expect(res3.status).toBe(429);
  });
});

describe('SSE Enhancement', () => {
  test('SSE sends retry directive', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(({ send, close }) => {
        send('test', 'hello', '1');
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events'));
    const text = await res.text();
    expect(text).toContain('retry: 5000');
  });

  test('SSE sends event with id', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(({ send, close }) => {
        send('update', '{"count":1}', 'evt-1');
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events'));
    const text = await res.text();
    expect(text).toContain('id: evt-1');
    expect(text).toContain('event: update');
    expect(text).toContain('data: {"count":1}');
  });

  test('SSE receives Last-Event-ID', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(({ send, close, lastEventId }) => {
        send('resume', `from:${lastEventId}`);
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events', {
      headers: { 'last-event-id': '42' },
    }));
    const text = await res.text();
    expect(text).toContain('from:42');
  });

  test('SSE handles multi-line data', async () => {
    const app = new Vajra();
    app.get('/events', (c) => {
      return c.sse(({ send, close }) => {
        send('log', 'line1\nline2\nline3');
        close();
      });
    });

    const res = await app.handle(new Request('http://localhost/events'));
    const text = await res.text();
    expect(text).toContain('data: line1\ndata: line2\ndata: line3');
  });
});

describe('Plugin System', () => {
  test('registers and uses a plugin', async () => {
    const app = new Vajra();

    const testPlugin = {
      name: 'test-plugin',
      defaults: { greeting: 'Hello' },
      register(app: any, config: any) {
        app.decorate('greeting', config.greeting);
      },
    };

    await app.plugin(testPlugin, { greeting: 'Namaste' });
    expect((app as any).greeting).toBe('Namaste');
  });

  test('rejects duplicate plugin registration', async () => {
    const app = new Vajra();
    const plugin = { name: 'dup', register() {} };

    await app.plugin(plugin);
    await expect(app.plugin(plugin)).rejects.toThrow('already registered');
  });

  test('checks plugin dependencies', async () => {
    const app = new Vajra();
    const dependent = {
      name: 'auth',
      dependencies: ['redis'],
      register() {},
    };

    await expect(app.plugin(dependent)).rejects.toThrow('requires "redis"');
  });

  test('dependency chain works when satisfied', async () => {
    const app = new Vajra();
    const redis = { name: 'redis', register(app: any) { app.decorate('redis', 'connected'); } };
    const auth = {
      name: 'auth',
      dependencies: ['redis'],
      register(app: any) { app.decorate('auth', 'ready'); },
    };

    await app.plugin(redis);
    await app.plugin(auth);
    expect((app as any).redis).toBe('connected');
    expect((app as any).auth).toBe('ready');
  });

  test('rejects duplicate decoration', async () => {
    const app = new Vajra();
    app.decorate('db', 'postgres');
    expect(() => app.decorate('db', 'mysql')).toThrow('already exists');
  });

  test('decorateContext adds per-request data', async () => {
    const app = new Vajra();
    app.decorateContext('requestId', () => Math.random().toString(36).slice(2));
    app.get('/test', (c) => {
      const id = c.get<string>('requestId');
      return c.json({ id });
    });

    const res = await app.handle(new Request('http://localhost/test'));
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(typeof data.id).toBe('string');
  });

  test('plugin with lifecycle hooks', async () => {
    const app = new Vajra();
    let closed = false;

    const plugin = {
      name: 'lifecycle',
      register() {},
      close() { closed = true; },
    };

    await app.plugin(plugin);
    // Simulate shutdown
    await (app as any).pluginRegistry.shutdown(app);
    expect(closed).toBe(true);
  });
});
