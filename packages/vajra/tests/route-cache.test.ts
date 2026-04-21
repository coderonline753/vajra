import { describe, test, expect } from 'bun:test';
import { Vajra, cors, type Middleware } from '../src/index';

describe('Per-route compile cache (optimize mode)', () => {
  test('same route handled many times yields identical responses', async () => {
    const app = new Vajra({ optimize: true });
    let calls = 0;
    app.use(async (c, next) => { calls++; return next(); });
    app.get('/ping', (c) => c.json({ pong: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.handle(new Request('http://localhost/ping'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pong: true });
    }
    expect(calls).toBe(5);
  });

  test('different routes get independent cached chains', async () => {
    const app = new Vajra({ optimize: true });
    app.use(cors({ origin: '*' }));
    app.get('/a', (c) => c.text('A'));
    app.get('/b', (c) => c.text('B'));

    const r1 = await app.handle(new Request('http://localhost/a'));
    const r2 = await app.handle(new Request('http://localhost/b'));
    const r1b = await app.handle(new Request('http://localhost/a'));

    expect(await r1.text()).toBe('A');
    expect(await r2.text()).toBe('B');
    expect(await r1b.text()).toBe('A');
  });

  test('route-level middleware is preserved in cached chain', async () => {
    const app = new Vajra({ optimize: true });
    const addX: Middleware = async (c, next) => {
      const r = await next();
      r.headers.set('x-route-mw', 'yes');
      return r;
    };
    app.get('/x', addX, (c) => c.text('ok'));

    const r1 = await app.handle(new Request('http://localhost/x'));
    const r2 = await app.handle(new Request('http://localhost/x'));
    expect(r1.headers.get('x-route-mw')).toBe('yes');
    expect(r2.headers.get('x-route-mw')).toBe('yes');
  });

  test('empty middleware stack bypasses compose on cache hit', async () => {
    const app = new Vajra({ optimize: true });
    app.get('/bare', (c) => c.text('bare'));
    const r1 = await app.handle(new Request('http://localhost/bare'));
    const r2 = await app.handle(new Request('http://localhost/bare'));
    expect(await r1.text()).toBe('bare');
    expect(await r2.text()).toBe('bare');
  });

  test('cache survives across many requests without behavior drift', async () => {
    const app = new Vajra({ optimize: true });
    app.use(async (c, next) => {
      const r = await next();
      r.headers.set('x-count', String((c.get<number>('n') ?? 0) + 1));
      return r;
    });
    app.get('/n/:v', (c) => {
      c.set('n', Number(c.param('v')));
      return c.text('ok');
    });

    for (let i = 1; i <= 10; i++) {
      const res = await app.handle(new Request(`http://localhost/n/${i}`));
      expect(res.headers.get('x-count')).toBe(String(i + 1));
    }
  });
});
