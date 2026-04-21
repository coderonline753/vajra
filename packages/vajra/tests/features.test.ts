import { describe, it, expect } from 'bun:test';
import { Vajra, Context, rateLimit, jwtSign, jwtVerify, jwt, HttpError, parseCookies, serializeCookie } from '../src/index';

describe('Cookies', () => {
  it('parses request cookies', () => {
    const req = new Request('http://localhost/test', {
      headers: { cookie: 'session=abc123; theme=dark' },
    });
    const c = new Context(req);

    expect(c.cookie('session')).toBe('abc123');
    expect(c.cookie('theme')).toBe('dark');
    expect(c.cookie('missing')).toBeUndefined();
  });

  it('gets all cookies', () => {
    const req = new Request('http://localhost/test', {
      headers: { cookie: 'a=1; b=2' },
    });
    const c = new Context(req);

    expect(c.cookies).toEqual({ a: '1', b: '2' });
  });

  it('sets response cookies', async () => {
    const app = new Vajra();
    app.get('/login', (c) => {
      return c.setCookie('session', 'xyz', { httpOnly: true, path: '/' }).json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/login'));
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('session=xyz');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
  });

  it('deletes cookies', async () => {
    const app = new Vajra();
    app.get('/logout', (c) => {
      return c.deleteCookie('session', { path: '/' }).json({ ok: true });
    });

    const res = await app.handle(new Request('http://localhost/logout'));
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('parseCookies handles edge cases', () => {
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('  a=1  ;  b=2  ')).toEqual({ a: '1', b: '2' });
    expect(parseCookies('key=hello%20world')).toEqual({ key: 'hello world' });
  });

  it('serializeCookie has secure defaults', () => {
    const result = serializeCookie('token', 'abc');
    expect(result).toContain('token=abc');
    expect(result).toContain('Secure');
    expect(result).toContain('HttpOnly');
    expect(result).toContain('SameSite=Lax');
  });
});

describe('Rate Limiter', () => {
  it('allows requests within limit', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 5, window: 60000, keyExtractor: () => 'test-ip' }));
    app.get('/', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBe('5');
    }
  });

  it('blocks requests over limit with 429', async () => {
    const app = new Vajra();
    app.use(rateLimit({ max: 2, window: 60000, keyExtractor: () => 'test-ip-2' }));
    app.get('/', (c) => c.text('ok'));

    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
    const data = await res.json() as any;
    expect(data.success).toBe(false);
    expect(data.error.code).toBe('RATE_LIMITED');
  });

  it('different keys have separate limits', async () => {
    let currentKey = 'user1';
    const app = new Vajra();
    app.use(rateLimit({ max: 1, window: 60000, keyExtractor: () => currentKey }));
    app.get('/', (c) => c.text('ok'));

    const res1 = await app.handle(new Request('http://localhost/'));
    expect(res1.status).toBe(200);

    currentKey = 'user2';
    const res2 = await app.handle(new Request('http://localhost/'));
    expect(res2.status).toBe(200);
  });
});

describe('JWT', () => {
  const secret = 'test-secret-key-for-vajra';

  it('signs and verifies token', async () => {
    const token = await jwtSign({ userId: 42, role: 'admin' }, secret);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);

    const payload = await jwtVerify(token, secret);
    expect(payload.userId).toBe(42);
    expect(payload.role).toBe('admin');
    expect(payload.iat).toBeDefined();
  });

  it('rejects expired tokens', async () => {
    const token = await jwtSign({ userId: 1 }, secret, -10); // expired 10 seconds ago

    try {
      await jwtVerify(token, secret);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err instanceof HttpError).toBe(true);
      expect((err as HttpError).statusCode).toBe(401);
      expect((err as HttpError).message).toBe('Token expired');
    }
  });

  it('rejects tampered tokens', async () => {
    const token = await jwtSign({ userId: 1 }, secret);
    const tampered = token.slice(0, -5) + 'XXXXX';

    try {
      await jwtVerify(tampered, secret);
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof HttpError).toBe(true);
      expect((err as HttpError).statusCode).toBe(401);
    }
  });

  it('rejects invalid format', async () => {
    try {
      await jwtVerify('not.a.valid-token-format', secret);
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof HttpError).toBe(true);
    }
  });

  it('jwt middleware protects routes', async () => {
    const app = new Vajra();
    app.get('/protected', jwt({ secret }), (c) => {
      const payload = c.get('jwtPayload') as any;
      return c.json({ userId: payload.userId });
    });

    // No token
    const res1 = await app.handle(new Request('http://localhost/protected'));
    expect(res1.status).toBe(401);

    // Valid token
    const token = await jwtSign({ userId: 99 }, secret, 3600);
    const res2 = await app.handle(new Request('http://localhost/protected', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(res2.status).toBe(200);
    const data = await res2.json() as any;
    expect(data.userId).toBe(99);
  });

  it('jwt middleware rejects wrong secret', async () => {
    const app = new Vajra();
    app.get('/safe', jwt({ secret }), (c) => c.text('ok'));

    const token = await jwtSign({ userId: 1 }, 'wrong-secret', 3600);
    const res = await app.handle(new Request('http://localhost/safe', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(401);
  });
});

describe('WebSocket', () => {
  it('ws route registration does not crash', () => {
    const app = new Vajra();
    app.ws('/chat', {
      open(ws) { /* noop */ },
      message(ws, msg) { /* noop */ },
      close(ws) { /* noop */ },
    });
    // No crash = test passes
    expect(true).toBe(true);
  });
});
