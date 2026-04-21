import { describe, it, expect } from 'bun:test';
import { Vajra, cors, logger, timing, secureHeaders } from '../src/index';

describe('Middleware Edge Cases', () => {
  it('middleware execution order is correct (onion model)', async () => {
    const app = new Vajra();
    const order: string[] = [];

    app.use(async (_c, next) => {
      order.push('mw1-before');
      const res = await next();
      order.push('mw1-after');
      return res;
    });

    app.use(async (_c, next) => {
      order.push('mw2-before');
      const res = await next();
      order.push('mw2-after');
      return res;
    });

    app.get('/', (c) => {
      order.push('handler');
      return c.text('ok');
    });

    await app.handle(new Request('http://localhost/'));
    expect(order).toEqual(['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
  });

  it('middleware can short-circuit (skip handler)', async () => {
    const app = new Vajra();

    app.use(async (c, _next) => {
      return c.json({ blocked: true }, 403);
    });

    app.get('/', (c) => c.text('should not reach'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.blocked).toBe(true);
  });

  it('middleware error is caught by error handler', async () => {
    const app = new Vajra();
    app.onError((err, c) => c.json({ caught: err.message }, 500));

    app.use(async (_c, _next) => {
      throw new Error('middleware boom');
    });

    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.caught).toBe('middleware boom');
  });

  it('route-level middleware only runs for that route', async () => {
    const app = new Vajra();
    let mwRan = false;

    const routeMw = async (c: any, next: any) => {
      mwRan = true;
      return next();
    };

    app.get('/protected', routeMw, (c) => c.text('protected'));
    app.get('/public', (c) => c.text('public'));

    mwRan = false;
    await app.handle(new Request('http://localhost/public'));
    expect(mwRan).toBe(false);

    mwRan = false;
    await app.handle(new Request('http://localhost/protected'));
    expect(mwRan).toBe(true);
  });

  it('CORS middleware handles preflight OPTIONS', async () => {
    const app = new Vajra();
    app.use(cors({ origin: 'https://example.com' }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com' },
    }));

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('CORS middleware rejects unlisted origin', async () => {
    const app = new Vajra();
    app.use(cors({ origin: ['https://good.com'] }));
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com' },
    }));

    // Origin not in allowed list, so header should be empty or not set
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao === '' || acao === null).toBe(true);
  });

  it('secureHeaders adds all security headers', async () => {
    const app = new Vajra();
    app.use(secureHeaders());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('timing middleware adds Server-Timing header', async () => {
    const app = new Vajra();
    app.use(timing());
    app.get('/', (c) => c.text('ok'));

    const res = await app.handle(new Request('http://localhost/'));
    const st = res.headers.get('server-timing');
    expect(st).not.toBeNull();
    expect(st).toContain('total;dur=');
  });

  it('multiple middleware + route middleware all execute', async () => {
    const app = new Vajra();
    const trace: string[] = [];

    app.use(async (_c, next) => { trace.push('global1'); return next(); });
    app.use(async (_c, next) => { trace.push('global2'); return next(); });

    const routeMw = async (_c: any, next: any) => { trace.push('route'); return next(); };
    app.get('/', routeMw, (c) => { trace.push('handler'); return c.text('ok'); });

    await app.handle(new Request('http://localhost/'));
    expect(trace).toEqual(['global1', 'global2', 'route', 'handler']);
  });
});
